// What a node tells its owner it is doing. Two things matter here: the worker's layer count must
// actually arrive (it exists only in the coordinator's tensor split, so control has to send it),
// and this must never throw — it runs inside the snapshot the local UI polls, and assignments come
// off the wire, so a missing field has to render as "unknown" rather than break the whole view.
import { expect, test } from "bun:test";
import { planView } from "../assignments.ts";
import type { Assignment } from "../../protocol/types.ts";

const worker = (over: object = {}) => ({ kind: "worker", id: "as-1", deploymentId: "dep-1", port: 50200,
  device: "MTL0", threads: 10, allow: [], layers: 20, modelLayers: 64, ...over }) as unknown as Assignment;
const coordinator = (over: object = {}) => ({ kind: "coordinator", id: "as-2", deploymentId: "dep-1",
  model: { path: "/models/Qwen3.8-27B-Q8_0.gguf" }, rpc: [{ nodeId: "friend", port: 50200 }],
  devices: ["RPC0", "MTL0"], tensorSplit: [20, 44], ctx: 8192, parallel: 1,
  env: { GGML_RPC_WIRE: "off" }, extraArgs: [], port: 8100, modelName: "qwen3.8-27b", ...over }) as unknown as Assignment;

test("a worker reports the share it holds, which only ever came from control", () => {
  const v = planView(worker());
  expect(v.role).toBe("worker");
  expect(v.layers).toBe(20);
  expect(v.modelLayers).toBe(64);
  expect(v.device).toBe("MTL0");
});

test("a coordinator reports the whole ring, its own share last", () => {
  const v = planView(coordinator());
  expect(v.role).toBe("coordinator");
  expect(v.tensorSplit).toEqual([20, 44]);
  expect(v.ctx).toBe(8192);
  expect(v.modelPath).toContain("Qwen3.8-27B");
  expect(v.peers).toEqual(["friend"]);
  expect(v.device).toBe("RPC0,MTL0");
});

test("names this machine exchanges boundaries with are carried for both roles", () => {
  expect(planView(worker({ peers: [{ index: 1, endpoint: { nodeId: "other" } }] })).peers).toEqual(["other"]);
});

test("a partial assignment renders as unknown instead of throwing", () => {
  // This is not hypothetical: a coordinator assignment without `model` crashed the snapshot during
  // development, which would have taken the local Status view down with it.
  for (const broken of [
    { kind: "coordinator", id: "x", deploymentId: "d" },
    { kind: "coordinator", id: "x", deploymentId: "d", model: undefined },
    { kind: "worker", id: "x", deploymentId: "d" },
    { kind: "replica", id: "x", deploymentId: "d" },
    { kind: "stop", id: "x", deploymentId: "d" },
  ] as unknown as Assignment[]) {
    const v = planView(broken);
    expect(v.role).toBe(broken.kind);
    expect(v.modelPath).toBeUndefined();
    expect(v.layers).toBeUndefined();
  }
});
