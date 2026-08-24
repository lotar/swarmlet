// test/loop.test.ts — loop layer against the deterministic mock endpoint.
// Covers: event store capture/idempotency/PII flagging, curate
// classification (judge unparseable → deterministic fallback), refine CRUD +
// provenance commits + revert-by-SHA, gate accept path, gate AUTO-REVERT of
// an injected regression with signed certificate, and one HTTP-path gate run
// against the mock server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpL0Client } from "../core/l0.ts";
import { startMockServer, type MockServerHandle } from "../core/mock.ts";
import { ensureKeys, verifyObject } from "../core/sign.ts";
import type {
  ChatMsg,
  ChatOptions,
  EvalInstance,
  EventKind,
  L0Client,
  ModelManifest,
} from "../core/types.ts";
import { generateSuite } from "../evals/generate.ts";
import { getTemplate } from "../evals/templates.ts";
import { curateUnprocessed } from "../loop/curate.ts";
import { detectPii, EventStore } from "../loop/events.ts";
import { runGate } from "../loop/gate.ts";
import {
  applyRefinement,
  ensureKnowledgeRepo,
  git,
  knowledgePromptAt,
  revertCommit,
  type RefinementInput,
} from "../loop/refine.ts";

const TMP = mkdtempSync(join(tmpdir(), "sin-loop-test-"));
const SUITE_SEED = 20260807;
const GATE_VERSION = "loop-test-v1";
const INSTANCE_COUNT = 4;
const GOOD_MARKER = "GOOD-KNOWLEDGE-MARKER";

function sub(name: string): string {
  const dir = join(TMP, name);
  return dir;
}

// ---------- stub L0 client whose quality flips on a system-prompt marker ----------
//
// Answers PERFECTLY (template renderAnswer) iff the system prompt contains
// GOOD_MARKER — i.e. the candidate/baseline that carries the marker is by
// construction score-1 on every generated instance; anything else scores 0.
// This makes head-to-head deltas exact and decisions fully predictable.

class MarkerStubClient implements L0Client {
  private lookup: Map<string, EvalInstance>;
  constructor(suiteSeed: number, version: string, count: number) {
    this.lookup = new Map(
      generateSuite(suiteSeed, version, count).map((i) => [i.prompt, i]),
    );
  }
  async healthy(): Promise<boolean> {
    return true;
  }
  async manifest(): Promise<ModelManifest> {
    return {
      name: "marker-stub",
      contextLength: 4096,
      quantization: "Q8_0",
      moe: true,
      activeParams: 1.3,
      endpoint: "stub://",
    };
  }
  async chat(messages: ChatMsg[], _opts?: ChatOptions): Promise<string> {
    void _opts;
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const inst = this.lookup.get(user);
    if (inst && system.includes(GOOD_MARKER)) {
      return getTemplate(inst.templateId).renderAnswer(inst);
    }
    return "sorry, no json here";
  }
}

async function seedRepo(
  name: string,
): Promise<{ root: string; baseline: string }> {
  const root = sub(name);
  await ensureKnowledgeRepo(root);
  const baseline = await git(root, "rev-parse", "HEAD");
  return { root, baseline };
}

describe("events store", () => {
  test("capture is idempotent, flags PII, tracks processed", () => {
    const store = new EventStore(join(sub("db"), "ev.sqlite"));
    const ts = "2026-08-24T10:00:00.000Z";
    const input = { session: "s1", kind: "correction" as EventKind, payload: "use ISO dates", ts };
    const a = store.capture(input);
    const b = store.capture({ ...input }); // identical content ⇒ same id, ignored
    expect(b.id).toBe(a.id);
    expect(store.counts().total).toBe(1);

    const pii = store.capture({
      session: "s1",
      kind: "observation",
      payload: "contact ana@example.com or +385 91 234 5678",
      ts,
    });
    expect(pii.piiFlagged).toBe(true);
    expect(detectPii("plain text nothing here")).toBe(false);

    expect(store.unprocessed().length).toBe(2);
    store.markProcessed([a.id]);
    expect(store.unprocessed().map((e) => e.id)).toEqual([pii.id]);
    store.close();
  });
});

describe("curate", () => {
  let server: MockServerHandle;

  beforeAll(() => {
    server = startMockServer({ seed: 42 });
  });

  test("classifies synthetic events; PII never reaches prose verbatim", async () => {
    const client = new HttpL0Client(
      {
        baseModel: {
          name: "mock-model",
          quantization: "Q8_0",
          moe: true,
          ggufPath: "x",
          contextLength: 8192,
        },
        llamaServer: { host: "127.0.0.1", port: 0 },
        mesh: { nodeCount: 3, nodePorts: [9201] },
        suiteSeed: SUITE_SEED,
        paths: { knowledge: "knowledge", data: "data", gates: "gates" },
      },
      server.url,
    );
    const store = new EventStore(join(sub("curate"), "ev.sqlite"));
    const ts = "2026-08-24T10:00:00.000Z";
    // recurring failure pattern in session s1 → skill candidate
    store.captureMany([
      { session: "s1", kind: "tool_failure", payload: "invoice total parse failed for EUR format", ts },
      { session: "s1", kind: "correction", payload: "totals must sum line amounts exactly", ts },
      { session: "s1", kind: "retry", payload: "retry succeeded after fixing currency handling", ts },
      // noise observation
      { session: "s2", kind: "observation", payload: "user said thanks and closed chat", ts },
      // signal but PII-flagged: prose must be redacted
      { session: "s3", kind: "correction", payload: "email results to ana@example.com after each invoice run", ts },
    ]);

    const candidates = await curateUnprocessed({ client, store });

    // s1 group ⇒ skill; lone s3 correction ⇒ memory; s2 noise dropped
    expect(candidates.map((c) => c.kind).sort()).toEqual(["memory", "skill"]);
    const skill = candidates.find((c) => c.kind === "skill")!;
    expect(skill.eventIds.length).toBe(3);
    expect(skill.summary).toContain("session:s1");

    const memory = candidates.find((c) => c.kind === "memory")!;
    expect(memory.summary).not.toContain("ana@example.com");
    expect(memory.summary).toContain("[redacted:email]");

    // crash-resumable: batch marked processed; re-run is a no-op
    expect(store.counts().unprocessed).toBe(0);
    expect(await curateUnprocessed({ client, store })).toEqual([]);
    store.close();
  });

  afterAll(() => {
    server.stop();
  });
});

describe("refine", () => {
  test("init creates immutable core; CRUD commits carry greppable provenance", async () => {
    const root = await seedRepo("refine-repo").then((r) => r.root);
    const sys = await import("node:fs/promises");
    const sysMd = await sys.readFile(`${root}/system.md`, "utf8");
    expect(sysMd).toContain("IMMUTABLE-CORE");

    const input: RefinementInput = {
      type: "skill",
      action: "create",
      path: "skills/invoice-format.md",
      content: "# Invoice totals\nAlways sum line amounts; currency EUR.",
      oneLiner: "add invoice total rule",
      triggers: ["evt-abc", "evt-def"],
      evidence: "3 tool_failures in session s1 resolved",
    };
    const sha1 = await applyRefinement(root, input);
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);

    const msg = await git(root, "log", "--format=%B", "-1", sha1);
    expect(msg).toContain("refine(skill): add invoice total rule");
    expect(msg).toContain("trigger: evt-abc,evt-def");
    expect(msg).toContain("evidence: 3 tool_failures in session s1 resolved");
    // provenance greppable across the whole log
    const logAll = await git(root, "log", "--format=%B");
    expect(logAll.includes(`trigger: evt-abc`)).toBe(true);

    // idempotent replay: identical create ⇒ no empty commit
    const shaAgain = await applyRefinement(root, input);
    expect(shaAgain).toBe(sha1);

    // update
    const sha2 = await applyRefinement(root, { ...input, action: "update", content: "# v2\nupdated" });
    expect(sha2).not.toBe(sha1);
    const promptAt2 = await knowledgePromptAt(root, sha2);
    expect(promptAt2).toContain("# v2");

    // delete
    const delSha = await applyRefinement(root, { ...input, action: "delete", content: undefined });
    let gone = false;
    try {
      await sys.access(`${root}/skills/invoice-format.md`);
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);

    // revert-by-SHA of the latest commit touching the path restores its state
    await revertCommit(root, delSha, "manual check");
    expect(await sys.readFile(`${root}/skills/invoice-format.md`, "utf8")).toContain("# v2");
  });
});

describe("gate", () => {
  test("accepts an improvement and writes a signed certificate", async () => {
    const { root, baseline } = await seedRepo("gate-good");
    // candidate adds the marker-carrying skill ⇒ newSystem answers perfectly
    const cand = await applyRefinement(root, {
      type: "skill",
      action: "create",
      path: "skills/golden.md",
      content: `# Golden rule\n${GOOD_MARKER}\nAlways emit the canonical minified JSON answer.`,
      oneLiner: "add golden answering rule",
      triggers: ["evt-g1"],
      evidence: "nightly failures clustered on JSON envelope",
    });

    const keysDir = join(sub("gate-good-keys"));
    const gatesDir = join(sub("gate-good-certs"));
    const run = await runGate({
      knowledgeRoot: root,
      candidateSha: cand,
      baselineSha: baseline,
      client: new MarkerStubClient(SUITE_SEED, GATE_VERSION, INSTANCE_COUNT),
      suiteSeed: SUITE_SEED,
      instanceCount: INSTANCE_COUNT,
      version: GATE_VERSION,
      gatesDir,
      keysDir,
    });

    expect(run.cert.decision).toBe("accept");
    expect(run.reverted).toBe(false);
    expect(run.cert.newScore).toBeGreaterThan(run.cert.oldScore);
    // HEAD unchanged (no revert commit)
    expect(await git(root, "rev-parse", "HEAD")).toBe(cand);

    // certificate persists and verifies against the public key
    const persisted = JSON.parse(await Bun.file(run.certPath).text());
    expect(persisted.knowledgeSha).toBe(cand);
    const { pub } = await ensureKeys(keysDir);
    expect(await verifyObject(persisted, pub)).toBe(true);
  });

  test("AUTO-REVERTS an injected regression and records it in the cert", async () => {
    const root = sub("gate-bad");
    await ensureKnowledgeRepo(root);
    // baseline carries the good skill (score 1)
    await applyRefinement(root, {
      type: "skill",
      action: "create",
      path: "skills/golden.md",
      content: `# Golden rule\n${GOOD_MARKER}\n`,
      oneLiner: "baseline golden rule",
      triggers: ["evt-b0"],
      evidence: "seeded baseline",
    });
    const baseline = await git(root, "rev-parse", "HEAD");
    // regression candidate DELETES the good skill ⇒ newSystem scores 0
    const cand = await applyRefinement(root, {
      type: "skill",
      action: "delete",
      path: "skills/golden.md",
      oneLiner: "remove golden rule",
      triggers: ["evt-b1"],
      evidence: "simulated bad refinement",
    });

    const keysDir = join(sub("gate-bad-keys"));
    const gatesDir = join(sub("gate-bad-certs"));
    const run = await runGate({
      knowledgeRoot: root,
      candidateSha: cand,
      baselineSha: baseline,
      client: new MarkerStubClient(SUITE_SEED, GATE_VERSION, INSTANCE_COUNT),
      suiteSeed: SUITE_SEED,
      instanceCount: INSTANCE_COUNT,
      version: GATE_VERSION,
      gatesDir,
      keysDir,
    });

    expect(run.cert.decision).toBe("revert");
    expect(run.reverted).toBe(true);
    expect(run.cert.newScore).toBeLessThan(run.cert.oldScore);

    // auto-revert fired: file restored to baseline content, revert commit logged
    const restored = await import("node:fs/promises").then((fs) =>
      fs.readFile(`${root}/skills/golden.md`, "utf8"),
    );
    expect(restored).toContain(GOOD_MARKER);
    const log = await git(root, "log", "--format=%B");
    expect(log).toContain(`gate(revert): auto-revert ${cand}`);

    // signed cert verifies
    const persisted = JSON.parse(await Bun.file(run.certPath).text());
    const { pub } = await ensureKeys(keysDir);
    expect(await verifyObject(persisted, pub)).toBe(true);
  });

  test("HTTP path (mock server): equal scores within tolerance accept cleanly", async () => {
    const server = startMockServer({ seed: 42 });
    try {
      const { root, baseline } = await seedRepo("gate-http");
      const cand = await applyRefinement(root, {
        type: "memory",
        action: "create",
        path: "memory/note.md",
        content: "note the mock ignores system prompts entirely",
        oneLiner: "add memory note",
        triggers: ["evt-h1"],
        evidence: "http smoke",
      });
      const client = new HttpL0Client(
        {
          baseModel: {
            name: "mock-model",
            quantization: "Q8_0",
            moe: true,
            ggufPath: "x",
            contextLength: 8192,
          },
          llamaServer: { host: "127.0.0.1", port: 0 },
          mesh: { nodeCount: 3, nodePorts: [9201] },
          suiteSeed: SUITE_SEED,
          paths: { knowledge: "knowledge", data: "data", gates: "gates" },
        },
        server.url,
      );
      const run = await runGate({
        knowledgeRoot: root,
        candidateSha: cand,
        baselineSha: baseline,
        client,
        suiteSeed: SUITE_SEED,
        instanceCount: 4,
        version: `${GATE_VERSION}-http`,
        gatesDir: join(sub("gate-http-certs")),
        keysDir: join(sub("gate-http-keys")),
      });
      // mock output is prompt-independent ⇒ delta 0 ⇒ statistical tie:
      // "keep" (incumbent stays), never a revert
      expect(run.cert.decision).toBe("keep");
      expect(run.cert.oldScore).toBe(run.cert.newScore);
      expect(run.reverted).toBe(false);
    } finally {
      server.stop();
    }
  });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});
