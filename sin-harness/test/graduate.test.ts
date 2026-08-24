// test/graduate.test.ts — L3 graduation gate + adapter recipe export.
//
// Covers: pattern-key normalization stability, saturation verdict logic
// (threshold / burst / text-path-exhaustion), provenance scan against a real
// git-backed knowledge repo, and signed recipe build (refuses non-saturated,
// verifies own signature, idempotent bytes).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKeys, verifyObject } from "../core/sign.ts";
import type { CaptureInput, EventRecord } from "../core/types.ts";
import {
  detectSaturatedPatterns,
  patternKeyOf,
} from "../loop/graduate.ts";
import { applyRefinement, ensureKnowledgeRepo } from "../loop/refine.ts";
import { buildRecipe } from "../loop/recipe.ts";
import { EventStore } from "../loop/events.ts";

const TMP = mkdtempSync(join(tmpdir(), "sin-graduate-test-"));
const sub = (n: string) => join(TMP, n);

function iso(daysAgo: number): string {
  return new Date(Date.UTC(2026, 7, 24) - daysAgo * 86_400_000).toISOString();
}
void iso;

function seedStore(
  name: string,
  payload: string,
  count: number,
  spreadDays: number,
): { store: EventStore; events: EventRecord[] } {
  const store = new EventStore(sub(`${name}.sqlite`));
  const inputs: CaptureInput[] = [];
  const base = Date.UTC(2026, 7, 24);
  for (let i = 0; i < count; i++) {
    // Spread evenly from `spreadDays` ago up to (just before) the anchor date;
    // +i minutes keeps timestamps unique without changing the day-span story.
    const frac = count > 1 ? (i * spreadDays) / (count - 1) : 0;
    const ts = new Date(base - (spreadDays - frac) * 86_400_000 + i * 60_000).toISOString();
    inputs.push({
      session: `sess-${i % 5}`,
      kind: i % 2 === 0 ? "tool_failure" : "correction",
      payload,
      ts,
    });
  }
  return { store, events: store.captureMany(inputs) };
}

const FLAKY_PAYLOAD =
  "Error: upstream tool call failed: timeout after 3000ms waiting for worker abc-def-123";

describe("patternKey normalization", () => {
  test("stable across noise: numbers, uuids, case, punctuation", () => {
    const a = patternKeyOf("Timeout after 3000ms waiting for ABC-123!");
    const b = patternKeyOf("timeout after 9421ms waiting for abc-999");
    expect(a).toBe(b);
  });
  test("PII never enters the key", () => {
    const k = patternKeyOf("failed for ivan@example.com twice at 12:00");
    expect(k).not.toContain("@");
    expect(k).not.toContain("example");
  });
});

describe("detectSaturatedPatterns", () => {
  test("below threshold -> not saturated", () => {
    const { events } = seedStore("few", FLAKY_PAYLOAD, 10, 30);
    const [v] = detectSaturatedPatterns(events, {});
    expect(v!.occurrences).toBe(10);
    expect(v!.saturated).toBe(false);
    expect(v!.reason).toBe("below-threshold");
  });

  test("burst within one day -> not saturated even at high count", () => {
    const { events } = seedStore("burst", FLAKY_PAYLOAD, 25, 0);
    const [v] = detectSaturatedPatterns(events, {});
    expect(v!.occurrences).toBe(25);
    expect(v!.spanDays).toBeLessThan(7);
    expect(v!.saturated).toBe(false);
    expect(v!.reason).toBe("burst-not-recurring");
  });

  test("recurring + threshold but text path not tried -> not saturated", () => {
    const { events } = seedStore("noskill", FLAKY_PAYLOAD, 25, 30);
    const [v] = detectSaturatedPatterns(events, {});
    expect(v!.textSkillTried).toBe(false);
    expect(v!.saturated).toBe(false);
    expect(v!.reason).toBe("text-path-not-exhausted");
  });

  test("full PRD conditions -> SATURATED (provenance scanned from real git repo)", async () => {
    const { store, events } = seedStore("sat", FLAKY_PAYLOAD, 25, 30);
    const root = sub("knowledge-sat");
    await ensureKnowledgeRepo(root);
    // A text skill was already written to fix this exact pattern...
    await applyRefinement(root, {
      type: "skill",
      action: "create",
      path: "skills/flaky-tool-timeout.md",
      content:
        "# Skill: flaky tool timeouts\n\n- Retry once with backoff before reporting failure.\n",
      oneLiner: "retry flaky tool calls with backoff",
      triggers: [events[0]!.id],
      evidence: "nightly failures clustered on tool timeout",
    });
    const [v] = detectSaturatedPatterns(events, { knowledgeRoot: root });
    expect(v!.textSkillTried).toBe(true); // ...but the pattern STILL recurs
    expect(v!.saturated).toBe(true);

    const all = detectSaturatedPatterns(store.all(), { knowledgeRoot: root });
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  test("non-signal kinds are ignored", () => {
    const store = new EventStore(sub("noise.sqlite"));
    store.captureMany(
      Array.from({ length: 30 }, (_, i) => ({
        session: `s-${i}`,
        kind: "observation" as const,
        payload: FLAKY_PAYLOAD,
        ts: iso(30, i),
      })),
    );
    expect(detectSaturatedPatterns(store.all(), {})).toHaveLength(0);
  });
});

describe("buildRecipe", () => {
  test("refuses non-saturated patterns", async () => {
    const { events } = seedStore("recipe-refuse", FLAKY_PAYLOAD, 5, 30);
    const [v] = detectSaturatedPatterns(events, {});
    await expect(
      buildRecipe({
        verdict: v!,
        events,
        baseModel: { name: "OLMoE", quantization: "Q8_0", contextLength: 4096 },
        keysDir: sub("rk"),
        outDir: sub("recipes-refuse"),
      }),
    ).rejects.toThrow(/non-saturated/);
  });

  test("signed, self-verified, anti-collapse policy baked in, idempotent bytes", async () => {
    const { events } = seedStore("recipe-ok", FLAKY_PAYLOAD, 25, 30);
    const root = sub("knowledge-recipe");
    await ensureKnowledgeRepo(root);
    await applyRefinement(root, {
      type: "skill",
      action: "create",
      path: "skills/flaky-tool-timeout.md",
      content: "# Skill: flaky tool timeouts\n- backoff retry\n",
      oneLiner: "retry flaky tool calls",
      triggers: [events[1]!.id],
      evidence: "still failing after skill",
    });
    const [v] = detectSaturatedPatterns(events, { knowledgeRoot: root });
    expect(v!.saturated).toBe(true);

    const keysDir = sub("recipe-keys");
    const outDir = sub("recipes-ok");
    const base = {
      verdict: v!,
      events,
      baseModel: { name: "OLMoE-1B-7B-A1B", quantization: "Q8_0", contextLength: 4096 },
      ts: "2026-08-24T00:00:00.000Z",
      keysDir,
      outDir,
    };

    const first = await buildRecipe(base);
    expect(first.recipe.status).toBe("draft");
    expect(first.recipe.trainingDataSpec.source).toBe("distilled-corrections-only"); // never raw self-outputs
    expect(first.recipe.trainingDataSpec.piiPolicy).toBe("redact-before-export");
    expect(first.recipe.audition.required).toBe(true);
    expect(first.recipe.sourcePattern.samples.every((s) => !s.includes("@"))).toBe(true);

    // signature verifies against the on-disk public key
    const { pub } = await ensureKeys(keysDir);
    const persisted = JSON.parse(readFileSync(first.path, "utf8"));
    expect(await verifyObject(persisted, pub)).toBe(true);

    // idempotent: identical inputs+ts -> identical bytes
    const second = await buildRecipe(base);
    expect(second.path).toBe(first.path);
    expect(readFileSync(second.path, "utf8")).toBe(readFileSync(first.path, "utf8"));
  });
});
