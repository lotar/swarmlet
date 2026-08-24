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

// ---------- L3 graduation (PRD: evidence-driven, never scheduled) ----------

/** A recurring failure pattern detected in the event stream. */
export interface SaturationVerdict {
  /** Deterministic normalized signature shared by the grouped events. */
  patternKey: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  /** Days between first and last occurrence — "over weeks", not a burst. */
  spanDays: number;
  /** True iff an L1 text skill whose provenance references this pattern's
   * events already exists AND the pattern still recurs (text path exhausted). */
  textSkillTried: boolean;
  /** True only when ALL PRD conditions hold: ≥minOccurrences, spread over
   * ≥minSpanDays (weeks, not a burst), and the text-skill fix failed. */
  saturated: boolean;
  /** Why not saturated (machine-readable) when saturated is false. */
  reason?:
    | "below-threshold"
    | "burst-not-recurring"
    | "text-path-not-exhausted";
}

/** Executable training spec exported for a saturated pattern. Recipes —
 * never weights — are the commons-shareable L3 unit (PRD L4). */
export interface AdapterRecipe {
  id: string;
  createdAt: string;
  status: "draft" | "trained" | "audited" | "rejected";
  sourcePattern: {
    patternKey: string;
    occurrences: number;
    firstSeen: string;
    lastSeen: string;
    /** Redacted exemplar payloads (bounded) for local distillation. */
    samples: string[];
  };
  baseModel: { name: string; quantization: string; contextLength: number };
  trainingDataSpec: {
    /** Anti-collapse measure (PRD L3): distilled/corrected samples only,
     * never raw self-outputs. */
    source: "distilled-corrections-only";
    eventIds: string[];
    minSamples: number;
    format: "jsonl-chat";
    piiPolicy: "redact-before-export";
  };
  trainingConfig: {
    method: "QLoRA";
    r: number;
    loraAlpha: number;
    loraDropout: number;
    targetModules: string[];
    epochs: number;
    learningRate: number;
    batchSize: number;
    gradAccum: number;
    maxSeqLen: number;
    budgetGb: number;
    /** PRD: weekly-at-most, saturation-triggered. */
    cadence: "saturation-triggered-weekly-max";
  };
  audition: {
    required: boolean;
    criteria: [
      "beat-incumbent-on-private-shard",
      "behavioral-diff-certificate",
      "off-domain-drift-below-threshold",
    ];
  };
  signature?: string; // ed25519 over canonical JSON (signature excluded)
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
