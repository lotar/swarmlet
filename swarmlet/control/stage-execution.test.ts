import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { StageExecutor, type StageExecutionPlan, type NativeStageIdentity, type StageCleanupFailure } from "./stage-execution.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const engine = "a".repeat(64), source = "b".repeat(64), binary = "c".repeat(64);
type Call = { node: number; op: string; body: Record<string, any> };
const running: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const s of running.splice(0)) s.stop(true); });

function rig(mode: "stages" | "prefill-decode" = "stages", promptLength = 3, count = 2) {
  const calls: Call[] = [], withdrawals: StageCleanupFailure[][] = [];
  const states = Array.from({ length: count }, () => ({ position: 0, session: "", generated: 0, evaluated: 0, files: new Map<string, Uint8Array>(), resetFails: false }));
  let badIdentity = false, corruptChunk = false, badAck = false, invalidActivation = false, largeCapsule = false;
  const identities: NativeStageIdentity[] = states.map((_, i) => ({
    schema: 1, engine, source_sha256: source, model_sha256: mode === "stages" ? String(i + 1).repeat(64) : source,
    ctx: 256, cache_k: "f32", cache_v: "f32", ubatch: 1, flash_attn: "disabled",
    stage_start: mode === "stages" ? String(i * (24 / count)) : "", stage_end: mode === "stages" ? String((i + 1) * (24 / count)) : "", stage_total: mode === "stages" ? "24" : "",
  }));
  const endpoints = states.map((state, i) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const q = await req.json() as Record<string, any>; calls.push({ node: i, op: q.op, body: q });
      const reply = (value: unknown, status = 200) => Response.json(value, { status });
      if (q.op === "status") return reply({ identity: badIdentity ? { ...identities[i], engine: "d".repeat(64) } : identities[i], n_embd: 2048, n_vocab: 248320, binary_sha256: binary, session: state.session, position: state.position });
      if (q.op === "tokenize" || q.op === "chat_tokens") return reply({ tokens: Array(promptLength).fill(1) });
      if (q.op === "reset") {
        if (state.resetFails) return reply({ error: "reset unavailable" }, 503);
        if (state.session && state.session !== q.session) return reply({ error: "session mismatch" }, 400);
        state.position = 0; state.session = ""; state.generated = 0; state.evaluated = 0;
        return reply({ reset: true });
      }
      if (q.op === "eval") {
        if (q.position !== state.position || (state.session && q.session !== state.session)) return reply({ error: "position/session mismatch" }, 400);
        if (q.compact !== true) return reply({ error: "compact required" }, 400);
        state.session = q.session;
        const count = q.tokens?.length ?? q.activations.length / 2048;
        state.position += count; state.evaluated += count;
        if (mode === "stages" && i < states.length - 1) return reply({ position: state.position, evaluated_tokens: state.evaluated, activations: invalidActivation ? [1] : Array(count * 2048).fill(0.25) });
        const index = state.generated++;
        return reply({ position: state.position, evaluated_tokens: state.evaluated, token: 10 + index, pieceBytes: [[0xe2], [0x82], [0xac]][index % 3], isEog: false });
      }
      if (q.op === "export") {
        const bytes = largeCapsule ? Buffer.alloc(262144 + 17, 17) : Buffer.from(JSON.stringify({ position: state.position, session: state.session }));
        const meta = { identity: identities[i], position: state.position, session: state.session, bytes: bytes.length, sha256: sha(bytes), envelope_sha256: "e".repeat(64), last_logits: [1] };
        state.files.set(q.file, bytes); state.files.set(q.file + ".json", Buffer.from(JSON.stringify(meta)));
        return reply(meta);
      }
      if (q.op === "state_read") {
        const bytes = state.files.get(q.file)!; const data = Array.from(bytes.slice(q.offset, q.offset + q.max_bytes));
        if (corruptChunk && q.file.endsWith(".state")) data[0] = (data[0]! + 1) % 256;
        return reply({ data, next_offset: q.offset + data.length, total_bytes: bytes.length, eof: q.offset + data.length === bytes.length });
      }
      if (q.op === "state_write") {
        const previous = state.files.get(q.file) ?? new Uint8Array();
        if (q.offset !== previous.length) return reply({ error: "offset mismatch" }, 400);
        const next = Buffer.concat([previous, Uint8Array.from(q.data)]); state.files.set(q.file, next);
        return reply({ next_offset: next.length + (badAck ? 1 : 0), total_bytes: next.length });
      }
      if (q.op === "import") {
        const bytes = state.files.get(q.file)!;
        const meta = JSON.parse(Buffer.from(state.files.get(q.file + ".json")!).toString());
        if (sha(bytes) !== meta.sha256 || q.session !== meta.session) return reply({ error: "checksum mismatch" }, 400);
        state.position = meta.position; state.session = q.session; state.generated = 1;
        return reply({ position: state.position, evaluated_tokens: 0, ...(largeCapsule ? { logits: Array(248320).fill(0.12345678901234567) } : {}) });
      }
      if (q.op === "state_delete") {
        if (!state.files.has(q.file)) return reply({ error: "unknown capsule" }, 400);
        state.files.delete(q.file); return reply({ deleted: true });
      }
      return reply({ error: "unsupported operation" }, 400);
    } });
    running.push(server);
    return { nodeId: `n${i}`, port: server.port!, identity: identities[i]!, binarySha256: binary };
  });
  const plan: StageExecutionPlan = { deploymentId: "native", mode, profile: "qwen35-2b-q8", endpoints,
    ...(mode === "prefill-decode" ? { stateTransferQualification: { sourceBinarySha256: binary, targetBinarySha256: binary, evidenceSha256: "f".repeat(64) } } : {}) };
  const executor = new StageExecutor({ localPort: async (_, port) => port, onUnsafeCleanup: (_, failures) => { withdrawals.push(failures); } });
  return { plan, executor, states, calls, withdrawals,
    badIdentity: () => { badIdentity = true; }, corruptChunk: () => { corruptChunk = true; }, badAck: () => { badAck = true; }, invalidActivation: () => { invalidActivation = true; }, largeCapsule: () => { largeCapsule = true; } };
}

describe("native stage execution over HTTP", () => {
  test("resident chain forwards activations, emits incremental UTF-8 and resets both workers", async () => {
    const r = rig(); const chunks: string[] = [];
    const out = await r.executor.generate(r.plan, { prompt: "hello", maxTokens: 3 }, chunk => { chunks.push(chunk.text); });
    expect(out).toEqual({ text: "€", tokenIds: [10, 11, 12], finishReason: "length", promptTokens: 3, completionTokens: 3 });
    expect(chunks).toEqual(["", "", "€"]);
    expect(r.calls.filter(c => c.node === 1 && c.op === "eval").map(c => c.body.activations.length)).toEqual([3 * 2048, 2048, 2048]);
    expect(r.states.map(s => [s.position, s.session])).toEqual([[0, ""], [0, ""]]);
    expect(r.withdrawals).toEqual([]);
  });

  test("long prompts are prefetched in native batches of at most 64", async () => {
    const r = rig("stages", 70);
    await r.executor.generate(r.plan, { messages: [{ role: "user", content: "hello" }], maxTokens: 1 });
    expect(r.calls.find(c => c.op === "chat_tokens")).toBeDefined();
    expect(r.calls.filter(c => c.node === 0 && c.op === "eval").map(c => [c.body.position, c.body.tokens.length])).toEqual([[0, 64], [64, 6]]);
  });

  test("three resident stages preserve ordered positions", async () => {
    const r = rig("stages", 3, 3);
    const out = await r.executor.generate(r.plan, { prompt: "hello", maxTokens: 3 });
    expect(out.text).toBe("€");
    expect(r.calls.filter(c => c.op === "eval").map(c => c.node)).toEqual([0, 1, 2, 0, 1, 2, 0, 1, 2]);
    expect(r.states.every(s => s.position === 0)).toBe(true);
  });

  test("prefill/decode copies bounded capsules and never replays prompt tokens on decode", async () => {
    const r = rig("prefill-decode");
    const out = await r.executor.generate(r.plan, { prompt: "hello", maxTokens: 3 });
    expect(out.text).toBe("€");
    expect(r.calls.filter(c => c.node === 1 && c.op === "eval").map(c => c.body.tokens)).toEqual([[10], [11]]);
    expect(r.calls.filter(c => c.op === "state_read").every(c => c.body.max_bytes === 262144)).toBe(true);
    expect(r.calls.filter(c => c.op === "import")).toHaveLength(1);
    expect(r.states.every(s => s.files.size === 0 && s.position === 0)).toBe(true);
  });

  test("capsule corruption and invalid acknowledgements fail before native import", async () => {
    for (const corrupt of ["corruptChunk", "badAck"] as const) {
      const r = rig("prefill-decode"); r[corrupt]();
      await expect(r.executor.generate(r.plan, { prompt: "hello", maxTokens: 3 })).rejects.toThrow(corrupt === "corruptChunk" ? "checksum mismatch" : "acknowledgement mismatch");
      expect(r.calls.some(c => c.op === "import")).toBe(false);
      expect(r.states.every(s => s.position === 0 && s.files.size === 0)).toBe(true);
    }
  });

  test("multi-chunk transfer waits for each write acknowledgement and permits bounded import logits once", async () => {
    const r = rig("prefill-decode"); r.largeCapsule();
    await r.executor.generate(r.plan, { prompt: "hello", maxTokens: 1 });
    const writes = r.calls.filter(c => c.op === "state_write" && c.body.file.endsWith(".state"));
    expect(writes.map(c => [c.body.offset, c.body.data.length])).toEqual([[0, 262144], [262144, 17]]);
    const wire = r.calls.filter(c => ["state_read", "state_write"].includes(c.op) && c.body.file.endsWith(".state"));
    expect(wire.map(c => c.op)).toEqual(["state_read", "state_write", "state_read", "state_write"]);
  });

  test("one deployment lease covers callback waits and cleanup", async () => {
    const r = rig(); let release!: () => void, entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const first = r.executor.generate(r.plan, { prompt: "a", maxTokens: 1 }, async () => { entered(); await paused; });
    await started;
    expect(r.executor.isBusy(r.plan.deploymentId)).toBe(true);
    await expect(r.executor.generate(r.plan, { prompt: "b", maxTokens: 1 })).rejects.toThrow("busy");
    release(); await first;
    expect(r.executor.isBusy(r.plan.deploymentId)).toBe(false);
    await r.executor.generate(r.plan, { prompt: "c", maxTokens: 1 });
  });

  test("cancellation resets through an independent signal", async () => {
    const r = rig(); const abort = new AbortController();
    await expect(r.executor.generate(r.plan, { prompt: "a", maxTokens: 3, signal: abort.signal }, () => { abort.abort(new Error("cancel test")); })).rejects.toThrow("cancel test");
    expect(r.states.every(s => s.position === 0 && s.session === "")).toBe(true);
    expect(r.withdrawals).toEqual([]);
  });

  test("a null cancellation reason on the final token cannot be mistaken for success", async () => {
    const r = rig(); const abort = new AbortController();
    await expect(r.executor.generate(r.plan, { prompt: "a", maxTokens: 1, signal: abort.signal }, () => { abort.abort(null); })).rejects.toThrow("null");
    expect(r.states.every(s => s.position === 0 && s.session === "")).toBe(true);
    expect(r.executor.isBusy(r.plan.deploymentId)).toBe(false);
  });

  test("cancellation releases native state while an output callback remains blocked", async () => {
    const r = rig(); const abort = new AbortController(); let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const generation = r.executor.generate(r.plan, { prompt: "a", maxTokens: 3, signal: abort.signal }, () => { entered(); return new Promise<void>(() => {}); });
    await started; abort.abort(new Error("paused consumer cancelled"));
    await expect(generation).rejects.toThrow("paused consumer cancelled");
    expect(r.states.every(s => s.position === 0 && s.session === "")).toBe(true);
    expect(r.executor.isBusy(r.plan.deploymentId)).toBe(false);
  });

  test("failed reset withdraws and prevents another generation", async () => {
    const r = rig(); r.states[1]!.resetFails = true;
    await expect(r.executor.generate(r.plan, { prompt: "a", maxTokens: 1 })).rejects.toThrow("cleanup failed");
    expect(r.withdrawals).toHaveLength(1);
    await expect(r.executor.generate(r.plan, { prompt: "a", maxTokens: 1 })).rejects.toThrow("requires recovery");
    r.states[1]!.resetFails = false; r.states[1]!.position = 0; r.states[1]!.session = "";
    r.executor.acknowledgeRecovery(r.plan.deploymentId);
    await r.executor.generate(r.plan, { prompt: "a", maxTokens: 1 });
  });

  test("identity and activation validation fail closed", async () => {
    const r = rig(); r.badIdentity();
    await expect(r.executor.generate(r.plan, { prompt: "a", maxTokens: 1 })).rejects.toThrow("identity mismatch");
    expect(r.calls.some(c => c.op === "eval" || c.op === "reset")).toBe(false);
    const a = rig(); a.invalidActivation();
    await expect(a.executor.generate(a.plan, { prompt: "a", maxTokens: 1 })).rejects.toThrow("activation batch");
    expect(a.calls.some(c => c.node === 1 && c.op === "eval")).toBe(false);
    expect(a.states.every(s => s.position === 0)).toBe(true);
  });

  test("unqualified precision, microbatch or flash attention identity fails before any native command", async () => {
    const r = rig("stages", 2);
    for (const change of [{ cache_k: "f16" }, { cache_v: "f16" }, { ubatch: undefined }, { ubatch: 2 }, { flash_attn: undefined }, { flash_attn: "enabled" }]) {
        const plan = { ...r.plan, endpoints: r.plan.endpoints.map((e, i) => i ? e : { ...e, identity: { ...e.identity, ...change } }) } as StageExecutionPlan;
      await expect(r.executor.generate(plan, { prompt: "a", maxTokens: 1 })).rejects.toThrow("unqualified native identity");
    }
    expect(r.calls).toHaveLength(0);
  });

  test("unsupported requests and unqualified binary pairs fail before mutation", async () => {
    const r = rig("prefill-decode");
    await expect(r.executor.generate({ ...r.plan, stateTransferQualification: undefined }, { prompt: "a", maxTokens: 1 })).rejects.toThrow("qualification required");
    await expect(r.executor.generate(r.plan, { prompt: "a", maxTokens: 0 })).rejects.toThrow("1..128");
    await expect(r.executor.generate(r.plan, { prompt: "a", maxTokens: 1, temperature: 0.5 })).rejects.toThrow("greedy");
    await expect(r.executor.generate(r.plan, { prompt: "a", maxTokens: 1, signal: {} as AbortSignal })).rejects.toThrow("cancellation signal");
    expect(r.executor.isBusy(r.plan.deploymentId)).toBe(false);
    expect(r.calls).toEqual([]);
    await expect(r.executor.generate({ ...r.plan, stateTransferQualification: { ...r.plan.stateTransferQualification!, targetBinarySha256: "d".repeat(64) } }, { prompt: "a", maxTokens: 1 })).rejects.toThrow("binary pair differs");
    expect(r.calls.every(c => c.op === "status")).toBe(true);
  });
});
