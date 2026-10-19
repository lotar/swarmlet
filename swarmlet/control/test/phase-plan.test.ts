// Phase-aware placement: the chooser must pick each phase by measured speed and let the transfer cost
// decide whether splitting is worth it at all. Pure, deterministic, and explained with its own numbers.
import { describe, expect, test } from "bun:test";
import { choosePhasePlan, type PhasePlanInput } from "../phase-plan.ts";

const MiB = 2 ** 20;
const input = (over: Partial<PhasePlanInput> = {}): PhasePlanInput => ({
  promptTokens: 512, outputTokens: 64, stateBytesPerToken: 20_480, transferBytesPerSec: () => 0.9 * MiB, ...over,
}) as PhasePlanInput;

describe("phase plan", () => {
  test("a much faster decoder elsewhere pays for the transfer", () => {
    const plan = choosePhasePlan(input({
      candidates: [{ nodeId: "mac", prefillTokPerSec: 200, decodeTokPerSec: 2 }, { nodeId: "cuda", prefillTokPerSec: 20, decodeTokPerSec: 80 }],
      prefillNodeIds: ["mac"], decodeNodeIds: ["cuda"],
    }));
    expect("error" in plan).toBe(false);
    expect(plan).toMatchObject({ prefillNodeId: "mac", decodeNodeId: "cuda", local: false });
    if (!("error" in plan)) expect(plan.reasons.at(-1)).toMatch(/Chosen split: prefill on mac, decode on cuda/);
  });

  test("one node fastest at both phases stays local", () => {
    const plan = choosePhasePlan(input({
      candidates: [{ nodeId: "mac", prefillTokPerSec: 200, decodeTokPerSec: 40 }, { nodeId: "cuda", prefillTokPerSec: 10, decodeTokPerSec: 5 }],
    }));
    expect(plan).toMatchObject({ prefillNodeId: "mac", decodeNodeId: "mac", local: true });
  });

  test("the transfer cost decides whether a split beats the local optimum", () => {
    const candidates = [{ nodeId: "mac", prefillTokPerSec: 200, decodeTokPerSec: 20 }, { nodeId: "cuda", prefillTokPerSec: 50, decodeTokPerSec: 200 }];
    const fast = choosePhasePlan(input({ candidates, transferBytesPerSec: () => 5 * MiB }));
    expect(fast).toMatchObject({ prefillNodeId: "mac", decodeNodeId: "cuda", local: false });
    const slow = choosePhasePlan(input({ candidates, transferBytesPerSec: () => 0.1 * MiB }));
    expect(slow).toMatchObject({ prefillNodeId: "mac", decodeNodeId: "mac", local: true });
  });

  test("role restrictions are honoured on both sides", () => {
    const plan = choosePhasePlan(input({
      candidates: [{ nodeId: "a", prefillTokPerSec: 200, decodeTokPerSec: 100 }, { nodeId: "b", prefillTokPerSec: 100, decodeTokPerSec: 200 }],
      prefillNodeIds: ["b"], decodeNodeIds: ["a"],
    }));
    expect(plan).toMatchObject({ prefillNodeId: "b", decodeNodeId: "a", local: false });
  });

  test("ties are deterministic regardless of input order", () => {
    const a = choosePhasePlan(input({ candidates: [{ nodeId: "a", prefillTokPerSec: 100, decodeTokPerSec: 100 }, { nodeId: "b", prefillTokPerSec: 100, decodeTokPerSec: 100 }] }));
    const b = choosePhasePlan(input({ candidates: [{ nodeId: "b", prefillTokPerSec: 100, decodeTokPerSec: 100 }, { nodeId: "a", prefillTokPerSec: 100, decodeTokPerSec: 100 }] }));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ prefillNodeId: "a", decodeNodeId: "a", local: true });
  });

  test("unmeasured phases are named instead of guessed, and impossible pairs refuse", () => {
    const missing = choosePhasePlan(input({ candidates: [{ nodeId: "a" }, { nodeId: "b" }] }));
    expect(missing).toHaveProperty("error");
    expect((missing as { error: string }).error).toMatch(/no measured phase speeds yet for a, b/);
    const unreachable = choosePhasePlan(input({
      candidates: [{ nodeId: "a", prefillTokPerSec: 200, decodeTokPerSec: 50 }, { nodeId: "b", prefillTokPerSec: 100, decodeTokPerSec: 50 }],
      prefillNodeIds: ["a"], decodeNodeIds: ["b"], transferBytesPerSec: () => 0,
    }));
    expect((unreachable as { error: string }).error).toMatch(/no phase pair can be reached/);
  });
});
