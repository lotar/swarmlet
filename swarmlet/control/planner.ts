// Deterministic placement planner for the Swarmlet control plane.
//
// Input: a DeploymentSpec, the model's profile (control/profiles/*.json) and the registry's node rows.
// Output: a Plan whose `reasons` explain every choice, or a PlanError that lists every refusal the planner
// could find. Same input, same plan: no randomness, no clock, no I/O (loadProfiles is the one reader).
// Sizes are MiB, as everywhere in the protocol.
//
// The envelope rows are measured facts (docs/FLASHNEXT_RING_LEVERS_20260904.md, control/profiles/README.md):
// the planner picks the row with the most layers per worker that the request and every worker's GPU offer
// allow, and never clamps a request to fit. Anything outside the envelope is refused with the limit that
// blocked it.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DeploymentSpec, EnvelopeRow, ModelFile, ModelProfile, Plan, PlanWorker } from "../protocol/types.ts";
import type { NodeRow } from "./registry.ts";

export interface PlanInput {
  spec: DeploymentSpec;
  profile: ModelProfile;
  nodes: NodeRow[];
  /** Ports already taken on each node (other deployments' rpc and peer ports), keyed by node id. */
  usedPorts: Map<string, Set<number>>;
}

export class PlanError extends Error {
  constructor(message: string, public readonly reasons: string[]) {
    super(reasons.length ? `${message} ${reasons.join(" ")}` : message);
    this.name = "PlanError";
  }
}

export const DEFAULT_CTX = 1536;
export const DEFAULT_PARALLEL = 1;
export const DEFAULT_CHAIN = 0;
/** Worker rpc ports start here and step by 10 per deployment on a node; the peer port is rpc + 1. */
export const WORKER_PORT_BASE = 50200;
export const WORKER_PORT_STEP = 10;
export const MAX_WORKER_THREADS = 10;
const WIRE_MODES: ReadonlySet<string> = new Set(["off", "f16", "q8"]);

// ---------- profiles ----------

const PROFILE_KEYS: readonly string[] = ["id", "name", "modelName", "ggufPattern", "mtpPattern", "layers", "layerMiB", "coordinatorHostMiB", "boundaryBytes", "envelope", "extraArgs", "workerMarginMiB"];
const ROW_KEYS: readonly string[] = ["workerLayers", "maxCtx", "maxParallel", "maxChain"];

type Raw = Record<string, unknown>;

const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

function checkKeys(obj: Raw, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Error(`${where}: unknown key "${k}"`);
}
function str(obj: Raw, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`${where}: "${key}" must be a non-empty string`);
  return v;
}
function int(obj: Raw, key: string, where: string, min: number): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new Error(`${where}: "${key}" must be an integer >= ${min}`);
  return v;
}
function pattern(obj: Raw, key: string, where: string): string {
  const v = str(obj, key, where);
  try { new RegExp(v); } catch (e) { throw new Error(`${where}: "${key}" is not a valid RegExp (${(e as Error).message})`); }
  return v;
}

/** Strict shape check for one profile: exactly the ModelProfile keys, integers in range, patterns that compile. */
export function validateProfile(raw: unknown, where = "profile"): ModelProfile {
  if (!isRecord(raw)) throw new Error(`${where}: must be a JSON object`);
  checkKeys(raw, PROFILE_KEYS, where);
  const envelopeRaw = raw.envelope;
  if (!Array.isArray(envelopeRaw) || envelopeRaw.length === 0) throw new Error(`${where}: "envelope" must be a non-empty array`);
  const envelope: EnvelopeRow[] = envelopeRaw.map((r: unknown, i: number): EnvelopeRow => {
    const rw = `${where}: envelope[${i}]`;
    if (!isRecord(r)) throw new Error(`${rw} must be an object`);
    checkKeys(r, ROW_KEYS, rw);
    return { workerLayers: int(r, "workerLayers", rw, 1), maxCtx: int(r, "maxCtx", rw, 1), maxParallel: int(r, "maxParallel", rw, 1), maxChain: int(r, "maxChain", rw, 0) };
  });
  const extraRaw = raw.extraArgs;
  if (!Array.isArray(extraRaw) || !extraRaw.every((a: unknown) => typeof a === "string")) throw new Error(`${where}: "extraArgs" must be an array of strings`);
  const profile: ModelProfile = {
    id: str(raw, "id", where),
    name: str(raw, "name", where),
    modelName: str(raw, "modelName", where),
    ggufPattern: pattern(raw, "ggufPattern", where),
    layers: int(raw, "layers", where, 1),
    layerMiB: int(raw, "layerMiB", where, 1),
    coordinatorHostMiB: int(raw, "coordinatorHostMiB", where, 0),
    boundaryBytes: int(raw, "boundaryBytes", where, 0),
    envelope,
    extraArgs: extraRaw.map((a: unknown) => String(a)),
    workerMarginMiB: int(raw, "workerMarginMiB", where, 0),
  };
  if (raw.mtpPattern !== undefined) profile.mtpPattern = pattern(raw, "mtpPattern", where);
  for (const row of envelope) {
    if (row.workerLayers >= profile.layers) throw new Error(`${where}: envelope workerLayers ${row.workerLayers} must be below layers ${profile.layers}`);
  }
  return profile;
}

/** Read every *.json in `dir` (default control/profiles), keyed by profile id, which must equal the file name. Throws on the first bad file. */
export function loadProfiles(dir: string = join(import.meta.dir, "profiles")): Map<string, ModelProfile> {
  const out = new Map<string, ModelProfile>();
  for (const f of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const file = join(dir, f);
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`profile ${file}: ${(e as Error).message}`); }
    const profile = validateProfile(raw, `profile ${file}`);
    const expected = basename(f, ".json");
    if (profile.id !== expected) throw new Error(`profile ${file}: id "${profile.id}" must equal the file name "${expected}"`);
    out.set(profile.id, profile);
  }
  return out;
}

// ---------- planner ----------

type Role = "coordinator" | "replica" | "worker";

interface Ctx {
  spec: DeploymentSpec;
  profile: ModelProfile;
  ctx: number;
  parallel: number;
  chain: number;
  gguf: RegExp;
  mtp: RegExp | null;
  /** Every enrolled node (for explaining why a requested node is unusable). */
  all: NodeRow[];
  /** Online nodes with an enabled offer, sorted by hostname then id. */
  eligible: NodeRow[];
  usedPorts: Map<string, Set<number>>;
  reasons: string[];
  errors: string[];
  headline: string;
}

interface GpuSlot { id: string; engineName: string; memMiB: number }
interface WorkerSlot { node: NodeRow; gpu: GpuSlot }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byHost = (a: NodeRow, b: NodeRow): number => cmp(a.hostname, b.hostname) || cmp(a.id, b.id);
const rttOf = (n: NodeRow): number => n.caps?.net?.rttMs ?? Number.POSITIVE_INFINITY;
function byRtt(a: NodeRow, b: NodeRow): number {
  const ra = rttOf(a), rb = rttOf(b);
  return ra === rb ? byHost(a, b) : ra < rb ? -1 : 1;
}
const rttLabel = (n: NodeRow): string => (Number.isFinite(rttOf(n)) ? `${rttOf(n)} ms` : "rtt unmeasured");
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const findModel = (n: NodeRow, re: RegExp): ModelFile | undefined => n.models.find((m) => re.test(m.name));
const envLine = (env: Record<string, string>): string => `env ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}.`;

/** First GPU the owner offers that the node's capabilities also report, with the offered memory. */
function offeredGpu(n: NodeRow): GpuSlot | null {
  for (const o of n.offer?.gpu ?? []) {
    const d = n.caps?.gpus.find((g) => g.id === o.id);
    if (d && o.memMiB > 0) return { id: d.id, engineName: d.engineName, memMiB: o.memMiB };
  }
  return null;
}

function envFor(spec: DeploymentSpec, workers: number): Record<string, string> {
  return {
    GGML_RPC_FORWARD: spec.forwarding !== false && workers > 1 ? "1" : "0",
    GGML_RPC_PIPELINE: "1",
    GGML_SCHED_PIPELINED_COPY: "1",
    GGML_RPC_GET_PIPELINE: spec.batchedGets === false ? "0" : "1",
    GGML_RPC_WIRE: spec.wire ?? "off",
  };
}

/** First free rpc port on a node: from 50200 in steps of 10, skipping any step whose rpc or peer port is taken. */
function pickPort(used: Set<number> | undefined): number {
  for (let p = WORKER_PORT_BASE; p + 1 < 65536; p += WORKER_PORT_STEP) {
    if (!used?.has(p) && !used?.has(p + 1)) return p;
  }
  throw new PlanError("No free worker port.", [`Every port from ${WORKER_PORT_BASE} upward in steps of ${WORKER_PORT_STEP} is taken on this node.`]);
}

/** A node named in the spec: must be enrolled, online, offering the role (and the model when asked). */
function requireNode(c: Ctx, id: string, role: Role, needModel: boolean): NodeRow | undefined {
  const n = c.all.find((x) => x.id === id);
  if (!n) { c.errors.push(`Requested ${role} node ${id} is not enrolled.`); return undefined; }
  const problems: string[] = [];
  if (!n.online) problems.push("is offline");
  if (!n.offer) problems.push("has not published an offer");
  else {
    if (!n.offer.enabled) problems.push("has its offer disabled");
    if (!n.offer.roles[role]) problems.push(`does not offer the ${role} role`);
  }
  if (needModel && !findModel(n, c.gguf)) problems.push(`holds no model matching ${c.profile.ggufPattern}`);
  if (problems.length) { c.errors.push(`Requested ${role} node ${n.hostname} ${problems.join(", ")}.`); return undefined; }
  c.reasons.push(`${capital(role)} ${n.hostname}: requested by the spec; online, ${role} role offered${needModel ? ", model present" : ""}.`);
  return n;
}

/** MTP draft head for chain > 0: the node running llama-server must hold a file matching the profile's mtpPattern. */
function draftHead(c: Ctx, n: NodeRow): string | undefined {
  if (c.chain === 0) { c.reasons.push("chain 0: no speculative decoding."); return undefined; }
  if (!c.mtp) { c.errors.push(`chain ${c.chain} requested but profile ${c.profile.id} has no mtpPattern (no draft head for this model).`); return undefined; }
  const f = findModel(n, c.mtp);
  if (!f) { c.errors.push(`chain ${c.chain} needs a draft head matching ${c.profile.mtpPattern} on ${n.hostname}; none of its ${n.models.length} model files match.`); return undefined; }
  c.reasons.push(`chain ${c.chain}: draft head ${f.name} on ${n.hostname}.`);
  return f.path;
}

/**
 * Device for the layers the coordinator (or replica) keeps itself, checking that `layers` plus the host-side
 * residency fit the offer: darwin = unified memory, everything against ramMiB; linux = layers against the GPU
 * offer and the host part against ramMiB (no GPU offered: everything in host RAM on the CPU backend).
 */
function placeResident(c: Ctx, n: NodeRow, layers: number, role: string): string {
  const offer = n.offer!; // eligible nodes have an offer
  const p = c.profile;
  const layersMiB = layers * p.layerMiB;
  const host = p.coordinatorHostMiB;
  const of = `${layers} of ${p.layers} layers`;
  if (n.os === "darwin") {
    const device = n.caps?.gpus[0]?.engineName ?? "CPU";
    const need = layersMiB + host;
    if (need <= offer.ramMiB) c.reasons.push(`${role} ${n.hostname} keeps ${of} on ${device}: ${layers} × ${p.layerMiB} + ${host} MiB host = ${need} MiB of ${offer.ramMiB} MiB RAM offered (darwin, unified memory).`);
    else c.errors.push(`${role} ${n.hostname} cannot hold ${of}: ${layers} × ${p.layerMiB} + ${host} MiB host = ${need} MiB exceeds the ${offer.ramMiB} MiB RAM offered (darwin, unified memory).`);
    return device;
  }
  const gpu = offeredGpu(n);
  if (gpu) {
    if (layersMiB <= gpu.memMiB) c.reasons.push(`${role} ${n.hostname} keeps ${of} on ${gpu.engineName}: ${layers} × ${p.layerMiB} = ${layersMiB} MiB of ${gpu.memMiB} MiB GPU offered.`);
    else c.errors.push(`${role} ${n.hostname} cannot hold ${of}: ${layers} × ${p.layerMiB} = ${layersMiB} MiB exceeds the ${gpu.memMiB} MiB GPU offered on ${gpu.engineName}.`);
    if (host <= offer.ramMiB) c.reasons.push(`${role} ${n.hostname} host side: ${host} MiB of ${offer.ramMiB} MiB RAM offered.`);
    else c.errors.push(`${role} ${n.hostname} host side: ${host} MiB exceeds the ${offer.ramMiB} MiB RAM offered.`);
    return gpu.engineName;
  }
  const need = layersMiB + host;
  if (need <= offer.ramMiB) c.reasons.push(`${role} ${n.hostname} keeps ${of} on CPU (no GPU offered): ${layers} × ${p.layerMiB} + ${host} MiB host = ${need} MiB of ${offer.ramMiB} MiB RAM offered.`);
  else c.errors.push(`${role} ${n.hostname} cannot hold ${of} on CPU (no GPU offered): ${layers} × ${p.layerMiB} + ${host} MiB host = ${need} MiB exceeds the ${offer.ramMiB} MiB RAM offered.`);
  return "CPU";
}

/**
 * The envelope row with the most layers per worker that the request (ctx, parallel, chain) and every worker's
 * GPU offer allow, leaving the coordinator at least one layer. Ties keep profile order. No fit: every blocker
 * lands in c.errors (per worker, the most layers its memory allows; per row, which limit refused it).
 */
function chooseRow(c: Ctx, slots: WorkerSlot[]): EnvelopeRow | null {
  const p = c.profile;
  const rows = p.envelope.map((row, i) => ({ row, i })).sort((a, b) => b.row.workerLayers - a.row.workerLayers || a.i - b.i);
  const skipped: string[] = [];
  for (const { row } of rows) {
    const blocked: string[] = [];
    if (c.ctx > row.maxCtx) blocked.push(`ctx ${c.ctx} > maxCtx ${row.maxCtx}`);
    if (c.parallel > row.maxParallel) blocked.push(`parallel ${c.parallel} > maxParallel ${row.maxParallel}`);
    if (c.chain > row.maxChain) blocked.push(`chain ${c.chain} > maxChain ${row.maxChain}`);
    if (row.workerLayers * slots.length > p.layers - 1) blocked.push(`${slots.length} workers × ${row.workerLayers} layers leave the coordinator none of the ${p.layers} layers`);
    const need = row.workerLayers * p.layerMiB + p.workerMarginMiB;
    for (const s of slots) {
      if (need > s.gpu.memMiB) blocked.push(`${s.node.hostname} needs ${need} MiB for ${row.workerLayers} layers but offers ${s.gpu.memMiB} MiB on ${s.gpu.engineName}`);
    }
    const label = `row workerLayers ${row.workerLayers} (maxCtx ${row.maxCtx}, maxParallel ${row.maxParallel}, maxChain ${row.maxChain})`;
    if (blocked.length === 0) {
      c.reasons.push(`Envelope ${label} fits ctx ${c.ctx}, parallel ${c.parallel}, chain ${c.chain} and every worker's GPU offer (${row.workerLayers} × ${p.layerMiB} + ${p.workerMarginMiB} MiB margin = ${need} MiB per worker)${skipped.length ? `; skipped ${skipped.join("; ")}` : ""}.`);
      return row;
    }
    skipped.push(`${label}: ${blocked.join(", ")}`);
  }
  c.errors.push(`No envelope row of profile ${p.id} fits ctx ${c.ctx}, parallel ${c.parallel}, chain ${c.chain} on ${slots.length} worker(s).`);
  for (const s of slots) {
    const maxLayers = Math.max(0, Math.floor((s.gpu.memMiB - p.workerMarginMiB) / p.layerMiB));
    c.errors.push(`${s.node.hostname}: ${s.gpu.memMiB} MiB offered on ${s.gpu.engineName} allows at most ${maxLayers} layer(s) of ${p.layerMiB} MiB after the ${p.workerMarginMiB} MiB margin.`);
  }
  for (const line of skipped) c.errors.push(`Envelope ${line}.`);
  return null;
}

function planReplica(c: Ctx): Plan {
  const { profile, spec } = c;
  let node: NodeRow | undefined;
  if (spec.replicaNodeId !== undefined) node = requireNode(c, spec.replicaNodeId, "replica", true);
  else {
    node = c.eligible.find((n) => n.offer!.roles.replica && findModel(n, c.gguf));
    if (node) c.reasons.push(`Replica ${node.hostname}: first node by hostname with the replica role and a model matching ${profile.ggufPattern}.`);
    else c.errors.push(`No online node offers the replica role and holds a model matching ${profile.ggufPattern}.`);
  }
  if (!node) throw new PlanError(c.headline, c.errors);
  const mtpPath = draftHead(c, node);
  const device = placeResident(c, node, profile.layers, "Replica");
  if (c.errors.length) throw new PlanError(c.headline, c.errors);
  const env = envFor(spec, 0);
  c.reasons.push(`Whole model on one node: no workers, no tensor split, device ${device}.`);
  c.reasons.push(envLine(env));
  const plan: Plan = {
    coordinatorNodeId: node.id, coordinatorDevice: device, workers: [], tensorSplit: [],
    ctx: c.ctx, parallel: c.parallel, chain: c.chain, env, modelPath: findModel(node, c.gguf)!.path, reasons: c.reasons,
  };
  if (mtpPath !== undefined) plan.mtpPath = mtpPath;
  return plan;
}

function planSplit(c: Ctx): Plan {
  const { profile, spec } = c;

  // coordinator: requested id, else the coordinator-role node holding the model with the largest RAM offer
  let coord: NodeRow | undefined;
  if (spec.coordinatorNodeId !== undefined) coord = requireNode(c, spec.coordinatorNodeId, "coordinator", true);
  else {
    const cands = c.eligible.filter((n) => n.offer!.roles.coordinator && findModel(n, c.gguf)).sort((a, b) => b.offer!.ramMiB - a.offer!.ramMiB || byHost(a, b));
    coord = cands[0];
    if (coord) {
      const others = cands.slice(1).map((n) => `${n.hostname} ${n.offer!.ramMiB} MiB`).join(", ");
      c.reasons.push(`Coordinator ${coord.hostname}: largest RAM offer (${coord.offer!.ramMiB} MiB) among ${cands.length} online node(s) with the coordinator role and a model matching ${profile.ggufPattern}${others ? ` (others: ${others})` : ""}.`);
    } else c.errors.push(`No online node offers the coordinator role and holds a model matching ${profile.ggufPattern}.`);
  }

  // workers: requested ids in the given order, else every other eligible worker by RTT then hostname
  const slots: WorkerSlot[] = [];
  if (spec.workerNodeIds !== undefined) {
    const seen = new Set<string>();
    for (const id of spec.workerNodeIds) {
      if (seen.has(id)) { c.errors.push(`Worker ${id} is listed twice.`); continue; }
      seen.add(id);
      if (coord && id === coord.id) { c.errors.push(`${coord.hostname} is the coordinator and cannot also be a worker.`); continue; }
      const n = requireNode(c, id, "worker", false);
      if (!n) continue;
      const gpu = offeredGpu(n);
      if (!gpu) { c.errors.push(`Requested worker ${n.hostname} offers no GPU memory.`); continue; }
      slots.push({ node: n, gpu });
    }
    if (slots.length) c.reasons.push(`Workers in the order the spec lists them: ${slots.map((s, i) => `RPC${i} ${s.node.hostname}`).join(", ")}.`);
  } else {
    const picked = c.eligible.filter((n) => n !== coord && n.offer!.roles.worker && offeredGpu(n) !== null).sort(byRtt);
    for (const n of picked) slots.push({ node: n, gpu: offeredGpu(n)! });
    if (slots.length) c.reasons.push(`Workers: every other online node with the worker role and a GPU offer, ordered by RTT to control then hostname: ${slots.map((s, i) => `RPC${i} ${s.node.hostname} (${rttLabel(s.node)})`).join(", ")}.`);
  }
  if (slots.length === 0) c.errors.push("A split needs at least one worker; use kind replica to run the whole model on one node.");
  if (!coord || c.errors.length) throw new PlanError(c.headline, c.errors);

  const mtpPath = draftHead(c, coord);
  const row = chooseRow(c, slots);
  if (!row) throw new PlanError(c.headline, c.errors);
  const remaining = profile.layers - row.workerLayers * slots.length;
  const device = placeResident(c, coord, remaining, "Coordinator");
  if (c.errors.length) throw new PlanError(c.headline, c.errors);

  const forwarding = spec.forwarding !== false && slots.length > 1;
  const workers: PlanWorker[] = slots.map(({ node, gpu }, i) => {
    const port = pickPort(c.usedPorts.get(node.id));
    const threads = Math.max(1, Math.min(node.offer!.cpuCores, MAX_WORKER_THREADS));
    const w: PlanWorker = { nodeId: node.id, device: gpu.engineName, layers: row.workerLayers, port, threads, memCapMiB: gpu.memMiB };
    if (forwarding) w.peerPort = port + 1;
    c.reasons.push(`RPC${i} ${node.hostname}: ${row.workerLayers} layer(s) on ${gpu.engineName}, rpc port ${port}${forwarding ? `, peer port ${port + 1}` : ""}, ${threads} threads (min of ${node.offer!.cpuCores} offered and ${MAX_WORKER_THREADS}), mem cap ${gpu.memMiB} MiB.`);
    return w;
  });
  const env = envFor(spec, slots.length);
  const tensorSplit = [...workers.map((w) => w.layers), remaining];
  c.reasons.push(`Devices ${[...workers.map((_, i) => `RPC${i}`), device].join(",")}, tensor split ${tensorSplit.join(",")}.`);
  if (forwarding) c.reasons.push("Push forwarding on: each worker pushes the boundary tensors to the next worker (peer port = rpc port + 1).");
  else c.reasons.push(spec.forwarding === false ? "Push forwarding off by request." : "Push forwarding off: a single worker has no next hop.");
  if (spec.batchedGets === false) c.reasons.push("Batched boundary GETs off by request (each boundary tensor is fetched with its own round trip).");
  if (spec.wire !== undefined && spec.wire !== "off") c.reasons.push(`Wire compression ${spec.wire} by request: boundary tensors are quantized on the wire, outputs are not guaranteed bit-exact.`);
  c.reasons.push(`Each boundary crossing moves about ${profile.boundaryBytes} bytes per token (profile boundaryBytes); ${slots.length + 1} crossings per ring trip.`);
  c.reasons.push(envLine(env));
  const plan: Plan = {
    coordinatorNodeId: coord.id, coordinatorDevice: device, workers, tensorSplit,
    ctx: c.ctx, parallel: c.parallel, chain: c.chain, env, modelPath: findModel(coord, c.gguf)!.path, reasons: c.reasons,
  };
  if (mtpPath !== undefined) plan.mtpPath = mtpPath;
  return plan;
}

/** Deterministic placement. Throws PlanError carrying every reason the planner could list. */
export function planDeployment(input: PlanInput): Plan {
  const { spec, profile, nodes, usedPorts } = input;
  const headline = `Deployment "${spec.name}" (${profile.id}, ${spec.kind}) cannot be planned.`;
  const errors: string[] = [];
  const ctx = spec.ctx ?? DEFAULT_CTX;
  const parallel = spec.parallel ?? DEFAULT_PARALLEL;
  const chain = spec.chain ?? DEFAULT_CHAIN;
  if (!Number.isInteger(ctx) || ctx < 1) errors.push(`ctx must be a positive integer, got ${String(spec.ctx)}.`);
  if (!Number.isInteger(parallel) || parallel < 1) errors.push(`parallel must be a positive integer, got ${String(spec.parallel)}.`);
  if (!Number.isInteger(chain) || chain < 0) errors.push(`chain must be an integer >= 0, got ${String(spec.chain)}.`);
  if (spec.wire !== undefined && !WIRE_MODES.has(spec.wire)) errors.push(`wire must be off, f16 or q8, got ${String(spec.wire)}.`);
  if (spec.kind !== "split" && spec.kind !== "replica") errors.push(`kind "${spec.kind}" is not placed by the planner; external deployments are registered, not planned.`);
  if (errors.length) throw new PlanError(headline, errors);

  const dflt = (v: unknown): string => (v === undefined ? " (default)" : "");
  const c: Ctx = {
    spec, profile, ctx, parallel, chain,
    gguf: new RegExp(profile.ggufPattern),
    mtp: profile.mtpPattern ? new RegExp(profile.mtpPattern) : null,
    all: nodes,
    eligible: [...nodes].sort(byHost).filter((n) => n.online && n.offer?.enabled === true),
    usedPorts, reasons: [], errors, headline,
  };
  c.reasons.push(`Request: profile ${profile.id} (${profile.name}), kind ${spec.kind}, ctx ${ctx}${dflt(spec.ctx)}, parallel ${parallel}${dflt(spec.parallel)}, chain ${chain}${dflt(spec.chain)}.`);
  c.reasons.push(`${c.eligible.length} of ${nodes.length} enrolled node(s) online with an enabled offer${c.eligible.length ? `: ${c.eligible.map((n) => n.hostname).join(", ")}` : ""}.`);
  return spec.kind === "replica" ? planReplica(c) : planSplit(c);
}

/** Engine device list for the coordinator's --device and --tensor-split: RPC0..RPC<n-1>, then its own device. */
export function planDevices(plan: Plan): string[] {
  return [...plan.workers.map((_, i) => `RPC${i}`), plan.coordinatorDevice];
}
