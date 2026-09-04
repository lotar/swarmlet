// Hand-written validators (zero dependencies). Every check returns a reason a person can act on;
// the agent shows them in the Resources page, control returns them from /api.

import type { Assignment, Capabilities, Offer, AgentToControl, ControlToAgent } from "./types.ts";

export type Result<T> = { ok: true; value: T; warnings: string[] } | { ok: false; errors: string[] };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Default OS reserve when the probe did not set one. */
export function defaultRamReserveMiB(os: Capabilities["os"]): number {
  return os === "darwin" ? 12 * 1024 : 4 * 1024;
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
  if (offer.enabled && offer.roles.worker && offer.gpu.every((g) => g.memMiB === 0) && offer.ramMiB === 0) {
    errors.push("worker role needs GPU memory or RAM");
  }
  if (offer.enabled && !offer.roles.worker && !offer.roles.coordinator && !offer.roles.replica) {
    warnings.push("enabled with no roles: the node will only report");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: offer, warnings };
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
    case "hello": bad = need(isNum(m.proto) && isObj(m.caps) && isObj(m.offer) && Array.isArray(m.models) && Array.isArray(m.assignments), "needs proto, caps, offer, models, assignments"); break;
    case "heartbeat": bad = need(isStr(m.ts) && isObj(m.metrics), "needs ts, metrics"); break;
    case "offer": bad = need(isObj(m.offer), "needs offer"); break;
    case "models": bad = need(Array.isArray(m.models), "needs models"); break;
    case "assignment": bad = need(isStr(m.id) && isStr(m.state), "needs id, state"); break;
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
    case "welcome": if (!isStr(m.nodeId)) return { ok: false, errors: ["welcome needs nodeId"] }; break;
    case "assign": { const a = validateAssignment(m.assignment); if (!a.ok) return a; break; }
    case "error": if (!isStr(m.message)) return { ok: false, errors: ["error needs message"] }; break;
    case "ping": if (!isStr(m.ts)) return { ok: false, errors: ["ping needs ts"] }; break;
    default: return { ok: false, errors: [`unknown control message ${m.t}`] };
  }
  return { ok: true, value: m as unknown as ControlToAgent, warnings: [] };
}

const PORT_OK = (p: unknown): p is number => isNum(p) && p > 0 && p < 65536;
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
