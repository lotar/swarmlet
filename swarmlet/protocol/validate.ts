// Hand-written validators (zero dependencies). Every check returns a reason a person can act on;
// the agent shows them in the Resources page, control returns them from /api.

import type { Assignment, Capabilities, Offer, AgentToControl, ControlToAgent } from "./types.ts";

export type Result<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Default OS reserve when the probe did not set one (darwin 12 GiB, Windows 6 GiB, Linux 4 GiB). */
export function defaultRamReserveMiB(os: Capabilities["os"]): number {
  if (os === "darwin") return 12 * 1024;
  if (os === "win32") return 6 * 1024;
  return 4 * 1024;
}

/**
 * Validate an owner's Offer against measured Capabilities. Values above what the machine has are
 * errors (never silently clamped: the owner must see what they asked for). Returns a normalized copy.
 */
export function validateOffer(input: unknown, caps: Capabilities): Result<Offer> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(input)) return { ok: false, errors: ["offer must be an object"] };
  const o = input;
  const roles = isObj(o.roles) ? o.roles : {};
  const offer: Offer = {
    enabled: o.enabled === true,
    roles: { worker: roles.worker === true, coordinator: roles.coordinator === true, replica: roles.replica === true },
    gpu: [],
    ramMiB: isNum(o.ramMiB) ? Math.floor(o.ramMiB) : NaN,
    cpuCores: isNum(o.cpuCores) ? Math.floor(o.cpuCores) : NaN,
    diskMiB: isNum(o.diskMiB) ? Math.floor(o.diskMiB) : NaN,
    modelsDir: isStr(o.modelsDir) ? o.modelsDir : "",
  };
  const reserve = caps.ramReserveMiB || defaultRamReserveMiB(caps.os);
  const ramMax = Math.max(0, caps.ramMiB - reserve);
  if (!isNum(offer.ramMiB) || offer.ramMiB < 0) errors.push("ramMiB must be a non-negative number");
  else if (offer.ramMiB > ramMax) errors.push(`ramMiB ${offer.ramMiB} exceeds ${ramMax} (total ${caps.ramMiB} minus OS reserve ${reserve})`);
  if (!isNum(offer.cpuCores) || offer.cpuCores < 0) errors.push("cpuCores must be a non-negative number");
  else if (offer.cpuCores > caps.cpuCores) errors.push(`cpuCores ${offer.cpuCores} exceeds ${caps.cpuCores}`);
  if (!isNum(offer.diskMiB) || offer.diskMiB < 0) errors.push("diskMiB must be a non-negative number");
  else if (offer.diskMiB > caps.diskFreeMiB) warnings.push(`diskMiB ${offer.diskMiB} exceeds free disk ${caps.diskFreeMiB}`);
  if (!offer.modelsDir) errors.push("modelsDir is required");
  const gpuIn = Array.isArray(o.gpu) ? o.gpu : [];
  for (const g of gpuIn) {
    if (!isObj(g) || !isStr(g.id) || !isNum(g.memMiB)) { errors.push("gpu entries need {id, memMiB}"); continue; }
    const dev = caps.gpus.find((d) => d.id === g.id);
    if (!dev) { errors.push(`gpu ${g.id} not present (have ${caps.gpus.map((d) => d.id).join(", ") || "none"})`); continue; }
    const mem = Math.floor(g.memMiB);
    if (mem < 0) errors.push(`gpu ${g.id}: memMiB must be non-negative`);
    else if (mem > dev.totalMiB) errors.push(`gpu ${g.id}: memMiB ${mem} exceeds device total ${dev.totalMiB}`);
    else offer.gpu.push({ id: g.id, memMiB: mem });
  }
  if (offer.enabled && (offer.roles.worker || offer.roles.coordinator || offer.roles.replica) && offer.cpuCores < 1) errors.push("enabled compute roles need at least one CPU core");
  if (offer.enabled && offer.roles.worker && offer.gpu.every((g) => g.memMiB === 0) && offer.ramMiB === 0) {
    errors.push("worker role needs GPU memory or RAM");
  }
  if (offer.enabled && !offer.roles.worker && !offer.roles.coordinator && !offer.roles.replica) {
    warnings.push("enabled with no roles: the node will only report");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: offer, warnings };
}

// Wire shape checks deliberately do not compare offers with current free resources: telemetry
// and owner edits can race hardware changes. Admission performs that separate policy check.
const nonnegative = (v: unknown) => isNum(v) && v >= 0;
const optional = (o: Record<string, unknown>, key: string, check: (v: unknown) => boolean) => o[key] === undefined || check(o[key]);
const strings = (v: unknown) => Array.isArray(v) && v.every(isStr);
const numbers = (o: Record<string, unknown>, keys: string[]) => keys.every(k => optional(o, k, nonnegative));
const netShape = (v: unknown) => isObj(v) && nonnegative(v.rttMs) && isStr(v.measuredAt) && numbers(v, ["upMbit", "downMbit"]);

export function capabilitiesShape(v: unknown, partial = false): v is Capabilities {
  if (!isObj(v)) return false;
  const checks: Record<string, (v: unknown) => boolean> = {
    os: v => ["darwin", "linux", "win32"].includes(v as string), arch: v => ["arm64", "x64"].includes(v as string),
    hostname: isStr, ramMiB: nonnegative, ramReserveMiB: nonnegative, cpuCores: nonnegative,
    diskFreeMiB: nonnegative, privateIps: strings, measuredAt: isStr,
    gpus: v => Array.isArray(v) && v.every(g => isObj(g) && isStr(g.id) && isStr(g.name) &&
      ["cuda", "metal", "cpu", "other"].includes(g.backend as string) && isStr(g.engineName) && nonnegative(g.totalMiB) && optional(g, "freeMiB", nonnegative)),
  };
  if (!Object.entries(checks).every(([k, check]) => partial && v[k] === undefined || check(v[k]))) return false;
  return optional(v, "allocationVersion", v => v === 1) && optional(v, "publicIp", isStr) &&
    optional(v, "dataPort", PORT_OK) && optional(v, "net", netShape) &&
    optional(v, "cgroup", v => isObj(v) && typeof v.memory === "boolean" && typeof v.cpu === "boolean") &&
    optional(v, "engine", v => isObj(v) && isStr(v.proto) && isObj(v.sha256) && Object.values(v.sha256).every(isStr) &&
      optional(v, "stages", v => isObj(v) && isStr(v.engine)));
}

function offerShape(v: unknown): boolean {
  return isObj(v) && typeof v.enabled === "boolean" && isObj(v.roles) &&
    ["worker", "coordinator", "replica"].every(k => typeof (v.roles as Record<string, unknown>)[k] === "boolean") &&
    [v.ramMiB, v.cpuCores, v.diskMiB].every(nonnegative) && isStr(v.modelsDir) &&
    Array.isArray(v.gpu) && v.gpu.every(g => isObj(g) && isStr(g.id) && nonnegative(g.memMiB));
}
function modelsShape(v: unknown): boolean {
  return Array.isArray(v) && v.every(m => isObj(m) && isStr(m.name) && isStr(m.path) && nonnegative(m.sizeBytes) &&
    ["gguf", "mtp", "mmproj"].includes(m.kind as string) && optional(m, "sha256", isStr));
}
function assignmentReportShape(v: unknown): boolean {
  return isObj(v) && isStr(v.id) && ["starting", "listening", "loading", "ready", "stopped", "failed"].includes(v.state as string) &&
    optional(v, "detail", isStr) && optional(v, "ports", v => isObj(v) && Object.values(v).every(PORT_OK));
}
function metricsShape(v: unknown): boolean {
  if (!isObj(v)) return false;
  return optional(v, "ts", isStr) && numbers(v, ["cpuPct", "rssMiB", "freeRamMiB", "tokPerSec", "tokPerSecAvg", "tokensTotal", "inflight"]) &&
    optional(v, "serving", isStr) && optional(v, "serverMetricsTs", isStr) && optional(v, "serverMetricsState", v => ["ok", "partial", "unavailable"].includes(v as string)) &&
    optional(v, "link", netShape) && optional(v, "gpu", v => Array.isArray(v) && v.every(g => isObj(g) && isStr(g.id) && nonnegative(g.usedMiB) &&
      numbers(g, ["utilizationPct", "powerW", "fanPct"]) && optional(g, "temperatureC", isNum))) &&
    optional(v, "network", v => Array.isArray(v) && v.every(n => isObj(n) && isStr(n.name) && numbers(n, ["rxBps", "txBps"]))) &&
    optional(v, "hardware", v => isObj(v) && isStr(v.measuredAt) &&
      Array.isArray(v.fans) && v.fans.every(f => isObj(f) && isStr(f.id) && isStr(f.name) && numbers(f, ["rpm", "targetRpm", "maxRpm"]) && optional(f, "mode", isStr)) &&
      Array.isArray(v.temperatures) && v.temperatures.every(t => isObj(t) && isStr(t.name) && isNum(t.celsius)) &&
      isObj(v.fanControl) && isStr(v.fanControl.detail) && ["max", "requested", "automatic", "unsupported", "permission-required", "error"].includes(v.fanControl.state as string));
}

/** Message shape guards. Strict on `t`; field checks are the minimum each handler relies on. */
export function parseAgentMessage(raw: string): Result<AgentToControl> {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return { ok: false, errors: ["not JSON"] }; }
  if (!isObj(m) || !isStr(m.t)) return { ok: false, errors: ["missing t"] };
  const need = (cond: boolean, what: string): Result<AgentToControl> | null => (cond ? null : { ok: false, errors: [`${m.t}: ${what}`] });
  let bad: Result<AgentToControl> | null = null;
  switch (m.t) {
    case "auth": bad = need(isStr(m.nodeId) && isStr(m.nonce) && isStr(m.certFp) && isStr(m.signature), "needs nodeId, nonce, certFp, signature"); break;
    case "hello": bad = need(isNum(m.proto) && isStr(m.agentVersion) && capabilitiesShape(m.caps) && offerShape(m.offer) && modelsShape(m.models) && Array.isArray(m.assignments) && m.assignments.every(assignmentReportShape), "needs proto, caps, offer, models, assignments"); break;
    case "heartbeat": bad = need(isStr(m.ts) && metricsShape(m.metrics) && optional(m, "caps", v => capabilitiesShape(v, true)), "needs ts, metrics"); break;
    case "offer": bad = need(offerShape(m.offer), "needs offer"); break;
    case "models": bad = need(modelsShape(m.models), "needs models"); break;
    case "assignment": bad = need(assignmentReportShape(m), "needs id, state"); break;
    case "log": bad = need(isStr(m.assignmentId) && isStr(m.line), "needs assignmentId, line"); break;
    case "pong": bad = need(isStr(m.ts), "needs ts"); break;
    default: return { ok: false, errors: [`unknown agent message ${m.t}`] };
  }
  return bad ?? { ok: true, value: m as unknown as AgentToControl, warnings: [] };
}

export function parseControlMessage(raw: string): Result<ControlToAgent> {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return { ok: false, errors: ["not JSON"] }; }
  if (!isObj(m) || !isStr(m.t)) return { ok: false, errors: ["missing t"] };
  switch (m.t) {
    case "challenge": if (!isStr(m.nonce)) return { ok: false, errors: ["challenge needs nonce"] }; break;
    case "welcome": if (!isStr(m.nodeId) || (m.inferenceKey !== undefined && !isStr(m.inferenceKey))) return { ok: false, errors: ["welcome needs nodeId and optional inferenceKey string"] }; break;
    case "assign": { const a = validateAssignment(m.assignment); if (!a.ok) return a; break; }
    case "error": if (!isStr(m.message)) return { ok: false, errors: ["error needs message"] }; break;
    case "ping": if (!isStr(m.ts)) return { ok: false, errors: ["ping needs ts"] }; break;
    default: return { ok: false, errors: [`unknown control message ${m.t}`] };
  }
  return { ok: true, value: m as unknown as ControlToAgent, warnings: [] };
}

const PORT_OK = (p: unknown): p is number => isNum(p) && Number.isInteger(p) && p > 0 && p < 65536;
const FP_OK = (s: unknown): s is string => isStr(s) && /^[0-9a-f]{64}$/.test(s);

export function validateAssignment(input: unknown): Result<Assignment> {
  if (!isObj(input) || !isStr(input.kind) || !isStr(input.id) || !isStr(input.deploymentId)) {
    return { ok: false, errors: ["assignment needs kind, id, deploymentId"] };
  }
  const a = input;
  const errors: string[] = [];
  const checkEndpoint = (e: unknown, where: string) => {
    if (!isObj(e) || !isStr(e.nodeId) || !FP_OK(e.certFp) || !PORT_OK(e.port) || !Array.isArray(e.direct) || typeof e.relay !== "boolean") {
      errors.push(`${where}: endpoint needs nodeId, certFp(sha256 hex), port, direct[], relay`);
      return;
    }
    for (const d of e.direct) if (!isObj(d) || !isStr(d.host) || !PORT_OK(d.port)) errors.push(`${where}: direct entries need host, port`);
  };
  const checkAllow = () => {
    if (!Array.isArray(a.allow) || !a.allow.every(FP_OK)) errors.push("allow must be a list of sha256 hex fingerprints");
  };
  switch (a.kind) {
    case "stage": {
      const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
      const positiveInt = (value: unknown) => isNum(value) && Number.isSafeInteger(value) && value > 0;
      if (!only(a, ["kind", "id", "deploymentId", "model", "port", "ctx", "gpuLayers", "identity", "binarySha256", "fitMiB", "allow", "enforce"])) errors.push("stage has unsupported fields");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(a.id as string) || !(a.deploymentId as string).length || (a.deploymentId as string).length > 128) errors.push("stage needs valid assignment and deployment IDs");
      if (!isObj(a.model) || !only(a.model, ["path", "sha256"]) || !isStr(a.model.path) || !a.model.path || a.model.path.includes("\0") || !FP_OK(a.model.sha256)) errors.push("stage needs model.path and lowercase model.sha256");
      if (!Number.isInteger(a.port) || !PORT_OK(a.port) || a.port < 1024) errors.push("stage needs integer port in [1024,65535]");
      if (a.ctx !== 1024 || a.gpuLayers !== 999) errors.push("stage requires ctx 1024 and gpuLayers 999");
      if (!FP_OK(a.binarySha256)) errors.push("stage needs lowercase binarySha256");
      if (a.fitMiB !== undefined && !positiveInt(a.fitMiB)) errors.push("stage fitMiB must be a positive integer");
      if (!Array.isArray(a.allow) || a.allow.length !== 0) errors.push("stage requires empty allow[]; transport is agent relay only");
      if (!isObj(a.enforce) || !only(a.enforce, ["ramMiB", "cpuCores"]) || !positiveInt(a.enforce.ramMiB) || a.enforce.cpuCores !== 2) errors.push("stage enforce requires positive integer ramMiB and cpuCores 2");
      const identity = a.identity;
      if (!isObj(identity)) errors.push("stage needs identity");
      else {
        if (!only(identity, ["schema", "engine", "model_sha256", "source_sha256", "ctx", "cache_k", "cache_v", "ubatch", "flash_attn", "stage_start", "stage_end", "stage_total"])) errors.push("stage identity has unsupported fields");
        if (identity.schema !== 1 || !FP_OK(identity.engine) || !FP_OK(identity.model_sha256) || !FP_OK(identity.source_sha256)) errors.push("stage identity needs schema 1 and lowercase SHA256 pins");
        if (!isObj(a.model) || identity.model_sha256 !== a.model.sha256) errors.push("stage model digest differs from identity");
        if (identity.ctx !== 1024 || identity.cache_k !== "f32" || identity.cache_v !== "f32" || identity.ubatch !== 1 || identity.flash_attn !== "disabled") errors.push("stage identity requires ctx 1024, F32 K/V, ubatch 1 and disabled flash attention");
        const { stage_start: start, stage_end: end, stage_total: total } = identity;
        if (start === "" && end === "" && total === "") {
          if (identity.source_sha256 !== identity.model_sha256) errors.push("full native context source digest must match model digest");
        } else {
          const block = (value: unknown) => isStr(value) && /^(?:[0-9]|1[0-9]|2[0-4])$/.test(value);
          if (!block(start) || !block(end) || Number(start) >= Number(end) || total !== "24") errors.push("stage identity requires a nonempty canonical block range within [0,24)");
        }
      }
      break;
    }
    case "worker":
      if (!PORT_OK(a.port)) errors.push("worker needs port");
      if (!isStr(a.device)) errors.push("worker needs device");
      if (!isNum(a.threads) || a.threads < 1) errors.push("worker needs threads >= 1");
      if (a.memCapMiB !== undefined && (!isNum(a.memCapMiB) || a.memCapMiB < 1)) errors.push("memCapMiB must be >= 1");
      if (a.peerPort !== undefined && !PORT_OK(a.peerPort)) errors.push("peerPort invalid");
      if (a.peers !== undefined) {
        if (!Array.isArray(a.peers)) errors.push("peers must be a list");
        else a.peers.forEach((p, i) => { if (!isObj(p) || !isNum(p.index)) errors.push(`peers[${i}] needs index`); else checkEndpoint(p.endpoint, `peers[${i}]`); });
      }
      checkAllow();
      break;
    case "coordinator":
      if (!isObj(a.model) || !isStr(a.model.path)) errors.push("coordinator needs model.path");
      if (!Array.isArray(a.rpc)) errors.push("coordinator needs rpc[]"); else a.rpc.forEach((e, i) => checkEndpoint(e, `rpc[${i}]`));
      if (!Array.isArray(a.devices) || !a.devices.every(isStr)) errors.push("coordinator needs devices[]");
      if (!Array.isArray(a.tensorSplit) || !a.tensorSplit.every(isNum)) errors.push("coordinator needs tensorSplit[]");
      else if (Array.isArray(a.devices) && a.devices.length !== a.tensorSplit.length) errors.push("devices and tensorSplit lengths differ");
      if (!isNum(a.ctx) || a.ctx < 1) errors.push("coordinator needs ctx");
      if (!isNum(a.parallel) || a.parallel < 1) errors.push("coordinator needs parallel");
      if (a.mtp !== undefined && (!isObj(a.mtp) || !isStr(a.mtp.path) || !isNum(a.mtp.chain) || a.mtp.chain < 1)) errors.push("mtp needs path, chain >= 1");
      if (!isObj(a.env)) errors.push("coordinator needs env");
      if (!Array.isArray(a.extraArgs) || !a.extraArgs.every(isStr)) errors.push("coordinator needs extraArgs[]");
      if (!PORT_OK(a.port)) errors.push("coordinator needs port");
      checkAllow();
      break;
    case "replica":
      if (!PORT_OK(a.port)) errors.push("replica needs port");
      if (!a.model && !a.external) errors.push("replica needs model or external");
      if (a.external !== undefined && (!isObj(a.external) || !isStr(a.external.url) || !isStr(a.external.healthPath))) errors.push("external needs url, healthPath");
      checkAllow();
      break;
    case "stop":
      break;
    default:
      return { ok: false, errors: [`unknown assignment kind ${a.kind}`] };
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: a as unknown as Assignment, warnings: [] };
}
