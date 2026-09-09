// Serialized Qwen35-2B execution over the existing authenticated TunnelPool.
// This module never starts processes or publishes routes; DeploymentManager owns those.
import { createHash } from "node:crypto";
import type { NativeExecutionPlan, NativeStageEndpoint, NativeStageIdentity } from "../protocol/types.ts";
export type { NativeStageEndpoint, NativeStageIdentity } from "../protocol/types.ts";

const BATCH = 64, EMBEDDING = 2048, VOCAB = 248320, CHUNK = 262144;
const MAX_STATE = 512 * 1024 * 1024, MAX_MANIFEST = 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;

export interface StageExecutionPlan extends NativeExecutionPlan {
  deploymentId: string;
}
export interface StageGenerationRequest {
  prompt?: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}
export interface StageTokenChunk { tokenId: number | null; text: string }
export interface StageGenerationResult {
  text: string; tokenIds: number[]; finishReason: "stop" | "length";
  promptTokens: number; completionTokens: number;
}
export interface StageCleanupFailure { nodeId: string; port: number; operation: string; error: string }
export class StageExecutionError extends Error {
  constructor(message: string, readonly cleanupFailures: StageCleanupFailure[] = [], options?: ErrorOptions) {
    super(message, options); this.name = "StageExecutionError";
  }
}
export interface StageExecutionDeps {
  localPort(nodeId: string, remotePort: number): Promise<number>;
  fetch?: typeof fetch;
  /** Must withdraw the deployment if cleanup could not establish empty workers. */
  onUnsafeCleanup(deploymentId: string, failures: StageCleanupFailure[]): Promise<void> | void;
}
type ObjectValue = Record<string, unknown>;
interface Prepared { target: NativeStageEndpoint; url: string; status: ObjectValue }
const object = (x: unknown): ObjectValue => {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new StageExecutionError("expected native object response");
  return x as ObjectValue;
};
const integer = (x: unknown, low: number, high: number): x is number => Number.isSafeInteger(x) && (x as number) >= low && (x as number) <= high;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const key = (e: NativeStageEndpoint) => `${e.nodeId}:${e.port}`;
function assertIdentity(actual: unknown, expected: NativeStageIdentity): void {
  const a = object(actual);
  for (const [field, value] of Object.entries(expected)) if (a[field] !== value) throw new StageExecutionError(`native identity mismatch: ${field}`);
}
function validatePlan(plan: StageExecutionPlan): void {
  if (plan.profile !== "qwen35-2b-q8" || !plan.deploymentId) throw new StageExecutionError("only an identified Qwen35-2B deployment is supported");
  if (!["stages", "prefill-decode"].includes(plan.mode) || !Array.isArray(plan.endpoints) || ![2, 3].includes(plan.endpoints.length)) throw new StageExecutionError("invalid native execution layout");
  if (plan.mode === "prefill-decode" && plan.endpoints.length !== 2) throw new StageExecutionError("prefill-decode requires exactly two endpoints");
  const first = plan.endpoints[0]!.identity;
  let boundary = 0;
  const seen = new Set<string>();
  for (const e of plan.endpoints) {
    if (!e.nodeId || !integer(e.port, 1024, 65535) || !SHA.test(e.binarySha256) || seen.has(key(e))) throw new StageExecutionError("invalid or duplicate native endpoint");
    seen.add(key(e));
    const i = e.identity;
    if (i.schema !== 1 || !SHA.test(i.engine) || !SHA.test(i.model_sha256) || !SHA.test(i.source_sha256) || !integer(i.ctx, 64, 32768) || i.cache_k !== "f32" || i.cache_v !== "f32" || i.ubatch !== 1 || i.flash_attn !== "disabled") throw new StageExecutionError("unqualified native identity");
    if (i.engine !== first.engine || i.source_sha256 !== first.source_sha256 || i.ctx !== first.ctx) throw new StageExecutionError("incompatible native source, ABI or context");
    if (plan.mode === "stages") {
      const start = Number(i.stage_start), end = Number(i.stage_end);
      if (i.stage_start === "" || i.stage_end === "" || i.stage_total !== "24" || start !== boundary || !integer(end, start + 1, 24)) throw new StageExecutionError("stage intervals must cover 24 transformer layers in order");
      boundary = end;
    } else if (i.stage_start !== "" || i.stage_end !== "" || i.stage_total !== "" || i.model_sha256 !== first.model_sha256 || i.model_sha256 !== i.source_sha256) throw new StageExecutionError("prefill-decode requires matching full models");
  }
  if (plan.mode === "stages" && boundary !== 24) throw new StageExecutionError("incomplete stage coverage");
  const q = plan.stateTransferQualification;
  if (plan.mode === "prefill-decode" && (!q || !SHA.test(q.sourceBinarySha256) || !SHA.test(q.targetBinarySha256) || !SHA.test(q.evidenceSha256))) throw new StageExecutionError("prefill-decode binary-pair qualification required");
}
function validateRequest(q: StageGenerationRequest): void {
  if (Object.keys(q).some(k => !["prompt", "messages", "maxTokens", "temperature", "signal"].includes(k))) throw new StageExecutionError("unsupported generation option");
  if (q.signal !== undefined && !(q.signal instanceof AbortSignal)) throw new StageExecutionError("invalid cancellation signal");
  if (!integer(q.maxTokens, 1, 128) || (q.temperature !== undefined && q.temperature !== 0)) throw new StageExecutionError("only greedy generation of 1..128 tokens is supported");
  if ((q.prompt === undefined) === (q.messages === undefined)) throw new StageExecutionError("provide exactly one prompt or messages");
  if (q.prompt !== undefined && (typeof q.prompt !== "string" || !q.prompt || Buffer.byteLength(q.prompt) > 65536)) throw new StageExecutionError("prompt must be nonempty and at most 65536 bytes");
  if (q.messages !== undefined && (!Array.isArray(q.messages) || !q.messages.length || q.messages.length > 64 || q.messages.some(m => !m || !["system", "user", "assistant"].includes(m.role) || typeof m.content !== "string" || Object.keys(m).some(k => k !== "role" && k !== "content")) || Buffer.byteLength(JSON.stringify(q.messages)) > 65536)) throw new StageExecutionError("invalid text-only chat messages");
}

export class StageExecutor {
  private active = new Set<string>();
  private unsafe = new Set<string>();
  private fetcher: typeof fetch;
  constructor(private readonly deps: StageExecutionDeps) { this.fetcher = deps.fetch ?? fetch; }
  isBusy(deploymentId: string): boolean { return this.active.has(deploymentId); }

  /** DeploymentManager calls this only after fresh supervised workers have reached ready. */
  acknowledgeRecovery(deploymentId: string): void {
    if (this.active.has(deploymentId)) throw new StageExecutionError("cannot acknowledge recovery during active execution");
    this.unsafe.delete(deploymentId);
  }

  private async emit(onToken: ((chunk: StageTokenChunk) => Promise<void> | void) | undefined, chunk: StageTokenChunk, signal: AbortSignal): Promise<void> {
    if (!onToken) return;
    signal.throwIfAborted();
    let aborted!: () => void;
    const cancelled = new Promise<never>((_, reject) => { aborted = () => reject(signal.reason); });
    signal.addEventListener("abort", aborted, { once: true });
    try {
      // A paused HTTP consumer must not keep native state leased after cancellation or timeout.
      await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return onToken(chunk); }), cancelled]);
    } finally { signal.removeEventListener("abort", aborted); }
  }

  private async command(e: Prepared, body: ObjectValue, signal: AbortSignal, responseBound = 4 * 1024 * 1024): Promise<ObjectValue> {
    signal.throwIfAborted();
    const response = await this.fetcher(e.url + "/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.body) throw new StageExecutionError("empty native response");
    // Bound the decoded body too; Content-Length is not a trustworthy allocation limit.
    const reader = response.body.getReader(); let total = 0; const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.length;
        if (total > responseBound) throw new StageExecutionError(`native response exceeds ${responseBound} byte bound`);
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const text = Buffer.concat(chunks).toString("utf8");
    const result = object(JSON.parse(text));
    if (!response.ok) throw new StageExecutionError(`native command failed (${response.status}): ${String(result.error ?? "unknown error")}`);
    return result;
  }

  private async prepare(plan: StageExecutionPlan, signal: AbortSignal): Promise<Prepared[]> {
    const prepared: Prepared[] = [];
    for (const target of plan.endpoints) {
      const port = await this.deps.localPort(target.nodeId, target.port);
      const e: Prepared = { target, url: `http://127.0.0.1:${port}`, status: {} };
      e.status = await this.command(e, { op: "status" }, signal);
      assertIdentity(e.status.identity, target.identity);
      if (e.status.n_embd !== EMBEDDING || e.status.n_vocab !== VOCAB || e.status.binary_sha256 !== target.binarySha256) throw new StageExecutionError("unexpected native model dimensions or binary identity");
      if (e.status.session !== "" || e.status.position !== 0) throw new StageExecutionError("native endpoint is busy or has uncleared state");
      prepared.push(e);
    }
    if (plan.mode === "prefill-decode") {
      const q = plan.stateTransferQualification!;
      if (prepared[0]!.status.binary_sha256 !== q.sourceBinarySha256 || prepared[1]!.status.binary_sha256 !== q.targetBinarySha256) throw new StageExecutionError("native binary pair differs from state-transfer qualification");
    }
    return prepared;
  }

  private async eval(e: Prepared, session: string, position: number, input: ObjectValue, count: number, middle: boolean, signal: AbortSignal): Promise<ObjectValue> {
    const out = await this.command(e, { op: "eval", session, position, ...input, compact: true }, signal);
    if (out.position !== position + count) throw new StageExecutionError("native position acknowledgement mismatch");
    if (middle) {
      if (!Array.isArray(out.activations) || out.activations.length !== count * EMBEDDING || !out.activations.every(x => typeof x === "number" && Number.isFinite(x))) throw new StageExecutionError("invalid native activation batch");
    } else if (!integer(out.token, 0, VOCAB - 1) || typeof out.isEog !== "boolean" || !Array.isArray(out.pieceBytes) || out.pieceBytes.length > 65536 || !out.pieceBytes.every(x => integer(x, 0, 255)) || out.logits !== undefined) throw new StageExecutionError("invalid compact native token response");
    return out;
  }

  private async transfer(source: Prepared, destination: Prepared, session: string, file: string, signal: AbortSignal, files: Map<Prepared, Set<string>>): Promise<void> {
    const track = (e: Prepared, name: string) => { const names = files.get(e) ?? new Set<string>(); names.add(name); files.set(e, names); };
    track(source, file); track(source, file + ".json");
    const exported = await this.command(source, { op: "export", session, file }, signal);
    if (!integer(exported.bytes, 1, MAX_STATE) || !SHA.test(String(exported.sha256)) || !SHA.test(String(exported.envelope_sha256))) throw new StageExecutionError("invalid native capsule descriptor");
    for (const suffix of ["", ".json"]) {
      const name = file + suffix, max = suffix ? MAX_MANIFEST : MAX_STATE;
      let offset = 0, size: number | undefined; const hash = createHash("sha256"); const manifest: Uint8Array[] = [];
      while (size === undefined || offset < size) {
        const read = await this.command(source, { op: "state_read", session, file: name, offset, max_bytes: CHUNK }, signal);
        const data = read.data;
        if (!Array.isArray(data) || !data.length || data.length > CHUNK || !data.every(x => integer(x, 0, 255)) || !integer(read.total_bytes, 1, max)) throw new StageExecutionError("invalid bounded capsule chunk");
        if (size === undefined) size = read.total_bytes;
        if (read.total_bytes !== size || read.next_offset !== offset + data.length || offset + data.length > size || read.eof !== (offset + data.length === size)) throw new StageExecutionError("capsule read offset or size changed");
        if (!suffix && size !== exported.bytes) throw new StageExecutionError("capsule size differs from export");
        const bytes = Uint8Array.from(data as number[]); hash.update(bytes); if (suffix) manifest.push(bytes);
        track(destination, name);
        const ack = await this.command(destination, { op: "state_write", session, file: name, offset, data }, signal);
        offset += data.length;
        if (ack.next_offset !== offset || ack.total_bytes !== offset) throw new StageExecutionError("capsule write acknowledgement mismatch");
      }
      if (!suffix && hash.digest("hex") !== exported.sha256) throw new StageExecutionError("capsule transport checksum mismatch");
      if (suffix) {
        const meta = object(JSON.parse(Buffer.concat(manifest).toString("utf8")));
        if (meta.envelope_sha256 !== exported.envelope_sha256 || meta.sha256 !== exported.sha256 || meta.bytes !== exported.bytes || meta.session !== session || meta.position !== exported.position) throw new StageExecutionError("capsule manifest differs from export");
        assertIdentity(meta.identity, source.target.identity);
      }
    }
  }

  async generate(plan: StageExecutionPlan, request: StageGenerationRequest, onToken?: (chunk: StageTokenChunk) => Promise<void> | void): Promise<StageGenerationResult> {
    validatePlan(plan); validateRequest(request);
    if (this.active.has(plan.deploymentId)) throw new StageExecutionError("native deployment is busy");
    if (this.unsafe.has(plan.deploymentId)) throw new StageExecutionError("native deployment requires recovery after unsafe cleanup");
    this.active.add(plan.deploymentId);
    const signal = AbortSignal.any([request.signal ?? new AbortController().signal, AbortSignal.timeout(10 * 60_000)]);
    const session = crypto.randomUUID(), file = `${session}.state`;
    let endpoints: Prepared[] = [], mutated = false, failed = false, result: StageGenerationResult | undefined, failure: unknown;
    const capsuleFiles = new Map<Prepared, Set<string>>();
    const cleanupFailures: StageCleanupFailure[] = [];
    try {
      endpoints = await this.prepare(plan, signal);
      const first = endpoints[0]!;
      const tokenized = await this.command(first, request.prompt !== undefined ? { op: "tokenize", text: request.prompt } : { op: "chat_tokens", messages: request.messages }, signal);
      const prompt = tokenized.tokens;
      if (!Array.isArray(prompt) || !prompt.length || !prompt.every(x => integer(x, 0, VOCAB - 1)) || prompt.length + request.maxTokens > first.target.identity.ctx) throw new StageExecutionError("invalid prompt tokens or context capacity exceeded");
      let position = 0, output: ObjectValue = {};
      mutated = true;
      for (let offset = 0; offset < prompt.length; offset += BATCH) {
        const tokens = prompt.slice(offset, offset + BATCH);
        let input: ObjectValue = { tokens };
        const prefillEndpoints = plan.mode === "stages" ? endpoints : [first];
        for (let i = 0; i < prefillEndpoints.length; i++) {
          const middle = plan.mode === "stages" && i < prefillEndpoints.length - 1;
          output = await this.eval(prefillEndpoints[i]!, session, position, input, tokens.length, middle, signal);
          if (middle) input = { activations: output.activations };
        }
        position += tokens.length;
      }
      if (plan.mode === "prefill-decode") {
        await this.transfer(first, endpoints[1]!, session, file, signal, capsuleFiles);
        // The qualified native import returns saved logits once, even with compact:true.
        // Its bound matches the manifest; per-token eval responses remain compact and 4 MiB bounded.
        const imported = await this.command(endpoints[1]!, { op: "import", session, file, compact: true }, signal, MAX_MANIFEST);
        if (imported.position !== position || imported.evaluated_tokens !== 0) throw new StageExecutionError("state import did not acknowledge zero-replay continuation");
      }
      const decoder = new TextDecoder(); const tokenIds: number[] = []; let text = "", finishReason: "stop" | "length" = "length";
      for (let n = 0; n < request.maxTokens; n++) {
        signal.throwIfAborted();
        if (output.isEog === true) { finishReason = "stop"; break; }
        const token = output.token as number;
        const piece = decoder.decode(Uint8Array.from(output.pieceBytes as number[]), { stream: true });
        tokenIds.push(token); text += piece; await this.emit(onToken, { tokenId: token, text: piece }, signal);
        signal.throwIfAborted();
        if (n + 1 === request.maxTokens) break;
        let input: ObjectValue = { tokens: [token] };
        const decodeEndpoints = plan.mode === "stages" ? endpoints : [endpoints[1]!];
        for (let i = 0; i < decodeEndpoints.length; i++) {
          const middle = plan.mode === "stages" && i < decodeEndpoints.length - 1;
          output = await this.eval(decodeEndpoints[i]!, session, position, input, 1, middle, signal);
          if (middle) input = { activations: output.activations };
        }
        position++;
      }
      const tail = decoder.decode(); text += tail; if (tail) await this.emit(onToken, { tokenId: null, text: tail }, signal);
      result = { text, tokenIds, finishReason, promptTokens: prompt.length, completionTokens: tokenIds.length };
    } catch (error) { failed = true; failure = error; }
    finally {
      if (mutated) {
        for (const e of endpoints) {
          for (const ownedFile of capsuleFiles.get(e) ?? []) {
            try {
              const deleted = await this.command(e, { op: "state_delete", session, file: ownedFile }, AbortSignal.timeout(10_000));
              if (deleted.deleted !== true) throw new Error("capsule deletion was not acknowledged");
            }
            catch (error) { cleanupFailures.push({ nodeId: e.target.nodeId, port: e.target.port, operation: "state_delete", error: errorText(error) }); }
          }
          try {
            await this.command(e, { op: "reset", session }, AbortSignal.timeout(10_000));
            const status = await this.command(e, { op: "status" }, AbortSignal.timeout(10_000));
            if (status.session !== "" || status.position !== 0) throw new Error("reset did not clear native state");
          } catch (error) { cleanupFailures.push({ nodeId: e.target.nodeId, port: e.target.port, operation: "reset", error: errorText(error) }); }
        }
      }
      if (cleanupFailures.length) {
        this.unsafe.add(plan.deploymentId);
        try { await this.deps.onUnsafeCleanup(plan.deploymentId, cleanupFailures); }
        catch (error) { cleanupFailures.push({ nodeId: "control", port: 0, operation: "withdraw", error: errorText(error) }); }
      }
      this.active.delete(plan.deploymentId);
    }
    if (failed || cleanupFailures.length) throw new StageExecutionError(failed ? errorText(failure) : "native cleanup failed; deployment withdrawn", cleanupFailures, failed ? { cause: failure } : undefined);
    return result!;
  }
}
