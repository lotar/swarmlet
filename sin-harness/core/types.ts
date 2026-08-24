// Shared types for the sin-harness PoC.
// Zero-dependency policy: only ES/DOM-standard types appear here.

// ---------- L0 contract ----------

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** Pinned seed; when set, sampling is fully deterministic (temperature forced to 0 upstream). */
  seed?: number;
  /** Hard override of temperature; defaults to 0 per determinism rule. */
  temperature?: number;
  maxTokens?: number;
  /** Disable server-side prompt-cache reuse for this request. Verification
   * paths MUST set false: shared KV-cache state makes near-tie greedy tokens
   * depend on which other requests ran before, breaking the redundant-execution
   * agreement contract (empirically validated in P0a acceptance). */
  cachePrompt?: boolean;
}

export interface ModelManifest {
  name: string;
  contextLength: number;
  quantization: string;
  moe: boolean;
  activeParams?: number;
  endpoint: string;
}

export interface L0Client {
  chat(messages: ChatMsg[], opts?: ChatOptions): Promise<string>;
  manifest(): Promise<ModelManifest>;
  /** True if the underlying OpenAI-compatible endpoint answers /health or /v1/models. */
  healthy(): Promise<boolean>;
}

// ---------- Capture / events (loop layer) ----------

export type EventKind =
  | "correction"
  | "retry"
  | "tool_failure"
  | "outcome"
  | "observation";

export interface EventRecord {
  id: string;
  ts: string; // ISO-8601
  nodeId?: string;
  session: string;
  kind: EventKind;
  payload: string;
  piiFlagged: boolean;
  processed: boolean;
}

export interface SkillCandidate {
  id: string;
  eventIds: string[];
  summary: string;
  kind: "skill" | "memory";
}

// ---------- Evals (L2) ----------

export type ExpectedAnswer =
  | { kind: "exact"; value: string }
  | { kind: "contains"; value: string }
  | { kind: "numeric"; value: number; tolerance?: number };

export interface EvalInstance {
  id: string;
  templateId: string;
  transformId: string;
  seed: number;
  prompt: string;
  expected: ExpectedAnswer;
  meta?: Record<string, string | number | boolean>;
}

export interface EvalResult {
  instanceId: string;
  output: string;
  passed: boolean;
  score: number; // 0..1
  durationMs: number;
  nodeId?: string;
}

// ---------- Gate / certificates ----------

/** Three-way gate verdict: accept = beyond-noise improvement; keep =
 * statistical tie (incumbent stays — PRD kill criterion counts flat gates
 * upstream); revert = beyond-noise regression (auto-revert fires). */
export type GateDecision = "accept" | "keep" | "revert";

export interface GateCertificate {
  id: string;
  date: string; // ISO-8601
  knowledgeSha: string;
  baseModel: string;
  suiteSeed: number;
  instanceCount: number;
  oldScore: number;
  newScore: number;
  decision: GateDecision;
  signature?: string; // ed25519 over canonical JSON (signature field excluded)
}

export interface ArtifactRef {
  path: string; // relative to the node's knowledge repo root
  sha: string; // git blob sha at time of export
}
