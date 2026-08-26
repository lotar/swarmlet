// mesh/protocol.ts — wire contract between the certification coordinator and
// logical mesh nodes. Types only + tiny fetch wrappers; no business logic.
//
// Security posture: node responses are signed (Ed25519, core/sign.ts) and the
// coordinator verifies before counting; shard CONTENTS never cross the wire.

import { canonicalize } from "../core/sign.ts";
import { extractJson } from "../evals/templates.ts";
import type { EvalInstance, EvalResult } from "../core/types.ts";

/** Every Nth instance is executed redundantly on multiple nodes (~5% at 20). */
export const REDUNDANT_EVERY = 20;
/** Redundant executions required while the full node set is alive. */
export const REDUNDANT_COPIES = 3;

// ---------- node HTTP API ----------

export interface NodeHealth {
  status: "ok";
  nodeId: string;
  mock: boolean;
}

/**
 * Shard metadata only — a node's private eval shard is built from its own
 * events and never leaves the machine (PRD L2 §2). `digest` binds the summary
 * to exact contents without revealing them.
 */
export interface ShardSummary {
  nodeId: string;
  count: number;
  digest: string;
}

export interface ExecuteRequest {
  requestId: string;
  instances: EvalInstance[];
}

/**
 * The part of an EvalResult that independent executions must agree on.
 *
 * NOTE (validated empirically, P0a acceptance): raw generation bytes are NOT
 * reproducible across executions even at temperature 0 — Metal AND CPU kernels
 * flip near-tie tokens depending on server history/batch composition (e.g.
 * a ```json fence appearing or not). The deterministic verifier's GRADED
 * RESULT is the unit of agreement: the checker-canonical answer extracted
 * from the output, plus pass flag and score. Any substantive divergence
 * (different extracted answer, different score) still fails certification.
 */
export interface ComparableResult {
  instanceId: string;
  /** Checker-canonical answer: parsed JSON when extractable, else trimmed text. */
  answer: unknown;
  passed: boolean;
  score: number;
}

/** Canonicalize raw model output the same way every template checker does. */
export function canonicalAnswer(output: string): unknown {
  const parsed = extractJson(output);
  return parsed ?? output.trim();
}

export function comparableOf(r: EvalResult): ComparableResult {
  return {
    instanceId: r.instanceId,
    answer: canonicalAnswer(r.output),
    passed: r.passed,
    score: r.score,
  };
}

/** Equality under the determinism contract: any substantive difference is a disagreement. */
export function sameResult(a: ComparableResult, b: ComparableResult): boolean {
  return (
    a.instanceId === b.instanceId &&
    canonicalize(a.answer) === canonicalize(b.answer) &&
    a.passed === b.passed &&
    Object.is(a.score, b.score)
  );
}

export interface ExecuteResponse {
  nodeId: string;
  requestId: string;
  /** Full results (incl. durationMs for telemetry); signature covers only the comparable projection. */
  results: EvalResult[];
  /** Ed25519 over canonicalize({nodeId, requestId, results: comparableOf(results)}). */
  signature: string;
}

export interface AuditionRequest {
  artifactName: string;
  /** Candidate skill text injected as system prompt during trial. */
  systemPrompt: string;
}

export interface AuditionResponse {
  nodeId: string;
  artifactName: string;
  candidatePassRate: number;
  baselinePassRate: number;
  evaluated: number;
  accepted: boolean;
  /** Ed25519 over canonicalize(everything else in this object). */
  signature: string;
}

export interface PubkeyResponse {
  nodeId: string;
  jwk: JsonWebKey;
}

/** Event capture payload accepted by POST /events (loop/events.ts-compatible shape). */
export interface NodeEventInput {
  id: string;
  session: string;
  kind: "correction" | "retry" | "tool_failure" | "outcome" | "observation";
  payload: string;
  ts?: string;
  piiFlagged?: boolean;
  processed?: boolean;
}

// ---------- coordinator-side helpers ----------

const DEFAULT_TIMEOUT_MS = 180_000;

async function request<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`mesh http ${res.status} from ${url}`);
  }
  return (await res.json()) as T;
}

export function meshGet<T>(url: string, timeoutMs?: number): Promise<T> {
  return request<T>(url, { timeoutMs });
}

export function meshPost<T>(
  url: string,
  body: unknown,
  timeoutMs?: number,
): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
}

/** Canonical comparable projection of an ExecuteResponse (what gets verified). */
export function executeComparable(r: ExecuteResponse): {
  nodeId: string;
  requestId: string;
  results: ComparableResult[];
} {
  return {
    nodeId: r.nodeId,
    requestId: r.requestId,
    results: r.results.map(comparableOf),
  };
}

/** True iff `signature` verifies over the response's comparable projection. */
export async function verifyExecuteResponse(
  r: ExecuteResponse,
  pub: CryptoKey,
): Promise<boolean> {
  const { signature, ...payload } = r;
  // Rebuild the signed projection: same fields, results reduced to comparable.
  return crypto.subtle.verify(
    { name: "Ed25519" },
    pub,
    base64ToBytes(signature),
    new TextEncoder().encode(canonicalize(executeComparable(payload as ExecuteResponse))),
  );
}

function base64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
