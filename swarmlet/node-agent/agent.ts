// AgentClient: the node's connection to the control plane. Enrolls over HTTP, then keeps one
// WebSocket open: challenge -> signed auth -> hello -> heartbeats; assignments arrive as messages;
// binary frames carry multiplexed streams (relays this node asked for, and data/http streams control
// or peers open towards this node's local ports).

import { connect as netConnect } from "node:net";
import { StreamMux, type MuxStream } from "../protocol/frame.ts";
import { canonicalize, signObject } from "../protocol/sign.ts";
import { parseControlMessage } from "../protocol/validate.ts";
import {
  HEARTBEAT_MS, PROTOCOL_VERSION,
  type AgentToControl, type Assignment, type AssignmentState, type Capabilities, type EnrollRequest, type EnrollResponse,
  type ModelFile, type NodeMetrics, type Offer,
} from "../protocol/types.ts";
import type { Identity } from "./identity.ts";
import { pipe } from "./streams.ts";
import type { Logger } from "../control/log.ts";

export interface AgentHooks {
  caps: () => Capabilities;
  offer: () => Offer;
  models: () => ModelFile[];
  metrics: () => NodeMetrics;
  assignments: () => Array<{ id: string; state: AssignmentState }>;
  onAssign: (a: Assignment) => void;
  /** Control asked for a catalog model's weights. Optional: a node without a fetcher simply ignores it. */
  onFetch?: (profile: string) => void;
  /** Local ports a `data` stream may be connected to right now. */
  allowedPorts: () => Set<number>;
}

export const AGENT_VERSION = "0.1.0";

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}

export async function enroll(controlUrl: string, code: string, id: Identity, caps: Capabilities, expectedKey?: JsonWebKey): Promise<EnrollResponse> {
  const body: EnrollRequest = { code, nodeId: id.nodeId, pubJwk: id.pubJwk, certFp: id.certFp, hostname: caps.hostname, caps };
  const signed = await signObject(body, id.keys.priv);
  const res = await fetch(`${controlUrl.replace(/\/$/, "")}/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed), redirect: "error", signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let out: EnrollResponse | { error: string } | null = null;
  try { out = JSON.parse(text) as EnrollResponse | { error: string }; } catch { out = null; }
  if (!res.ok || !out || !("ok" in out)) throw new Error(`enroll failed (${res.status}): ${out && "error" in out ? out.error : text.replace(/\s+/g, " ").slice(0, 120) || "no body"}`);
  if (out.nodeId !== id.nodeId) throw new Error("enrollment returned a different node identity");
  if (expectedKey) {
    if (canonicalize(out.controlPubJwk) !== canonicalize(expectedKey)) throw new Error("discovered controller key changed during enrollment");
    const control = new URL(controlUrl), agent = new URL(out.agentUrl);
    if (agent.protocol !== "ws:" || agent.host !== control.host || agent.pathname !== "/agent" || agent.username || agent.password || agent.search || agent.hash) throw new Error("discovered controller returned a different agent endpoint");
  }
  return out;
}

/**
 * Control pings every node about every 10 s and drops one that stays silent for 30 s. Without the
 * mirror image on this side, a half-open TCP path (edge or NAT dropped the flow without a FIN) keeps
 * the socket OPEN and every send buffered until the kernel gives up, often 15 minutes or more. During
 * that time control shows the node offline, its assignments fail, and the supervisor refuses to switch
 * releases because the child is "not connected". 45 s is at least four missed pings.
 */
export const CONTROL_SILENCE_MS = 45_000;

export class AgentClient {
  private ws: WebSocket | null = null;
  private mux: StreamMux | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private _connected = false;
  /** Wall clock of the last frame or message received from control on the current socket. */
  private lastRx = 0;
  private readonly staleMs: number;
  /** Server-side only; never included in the local UI status payload. */
  inferenceKey: string | null = null;
  link: { rttMs: number; measuredAt: string } | undefined;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly agentUrl: string,
    private readonly id: Identity,
    private readonly hooks: AgentHooks,
    private readonly log: Logger,
    opts: { staleMs?: number } = {},
  ) { this.staleMs = opts.staleMs ?? CONTROL_SILENCE_MS; }

  get connected(): boolean { return this._connected; }

  /** Resolves once authenticated (or immediately if already). */
  whenConnected(): Promise<void> {
    return this._connected ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown("stopped");
  }

  send(msg: AgentToControl): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  sendOffer(): void { this.send({ t: "offer", offer: this.hooks.offer() }); }
  sendModels(): void { this.send({ t: "models", models: this.hooks.models() }); }
  reportAssignment(id: string, state: AssignmentState, detail?: string, ports?: Record<string, number>): void {
    this.send({ t: "assignment", id, state, detail, ports });
  }
  logLine(assignmentId: string, line: string): void { this.send({ t: "log", assignmentId, line }); }

  /** Ask control to bridge us to `targetNodeId`'s local `port`. Null when not connected. */
  openRelay(targetNodeId: string, port: number): MuxStream | null {
    if (!this.mux) return null;
    return this.mux.open({ kind: "relay", target: targetNodeId, port, from: this.id.nodeId });
  }

  // ---------- internals ----------

  private connect(): void {
    if (this.stopped) return;
    this.log.info("connecting", { url: this.agentUrl });
    const ws = new WebSocket(this.agentUrl);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.lastRx = Date.now();
    ws.onopen = () => { this.backoffMs = 1000; };
    ws.onmessage = (ev) => { this.lastRx = Date.now(); void this.onMessage(ev.data as string | ArrayBuffer); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
      // A socket this client already discarded (stale link, stop) must not schedule a second reconnect.
      if (this.ws !== ws) return;
      const wasConnected = this._connected;
      this.teardown(`closed ${ev.code} ${ev.reason}`);
      if (this.stopped) return;
      // a policy close (1008) means our identity was rejected: keep retrying slowly so an operator re-enrolling fixes it live
      const delay = ev.code === 1008 ? 15_000 : this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
      this.log.warn(`disconnected${wasConnected ? "" : " before auth"}: ${ev.code} ${ev.reason}; retry in ${delay} ms`);
      setTimeout(() => this.connect(), delay);
    };
  }

  private teardown(reason: string): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this.mux?.closeAll(reason);
    this.mux = null;
    this._connected = false;
    this.inferenceKey = null;
    this.link = undefined;
    const ws = this.ws; this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, reason);
  }

  /** Nothing has arrived from control for `staleMs`: drop the socket without waiting for the peer and dial again. */
  private reconnectStale(): void {
    const silentMs = Date.now() - this.lastRx;
    const ws = this.ws;
    this.log.warn(`control silent for ${Math.round(silentMs / 1000)} s; dropping the link and reconnecting`);
    this.teardown("control silent");
    // close() only queues a frame the dead peer never acknowledges; terminate() releases the TCP socket now.
    try { (ws as WebSocket & { terminate?: () => void } | null)?.terminate?.(); } catch { /* already gone */ }
    if (!this.stopped) this.connect();
  }

  private async onMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") {
      try { this.mux?.handleFrame(new Uint8Array(data)); } catch (e) { this.log.warn("bad frame", { err: (e as Error).message }); }
      return;
    }
    const parsed = parseControlMessage(data);
    if (!parsed.ok) { this.log.warn("bad control message", { errors: parsed.errors }); return; }
    const m = parsed.value;
    switch (m.t) {
      case "challenge": {
        const payload = { nodeId: this.id.nodeId, nonce: m.nonce, certFp: this.id.certFp };
        const sig = await crypto.subtle.sign({ name: "Ed25519" }, this.id.keys.priv, encoder.encode(canonicalize(payload)));
        this.send({ t: "auth", ...payload, signature: toBase64(new Uint8Array(sig)) });
        break;
      }
      case "welcome": {
        this.inferenceKey = m.inferenceKey ?? null;
        this.mux = new StreamMux((f) => this.ws?.send(f), (s) => this.onIncomingStream(s), 1);
        this._connected = true;
        this.send({
          t: "hello", proto: PROTOCOL_VERSION, agentVersion: AGENT_VERSION,
          caps: this.hooks.caps(), offer: this.hooks.offer(), models: this.hooks.models(), assignments: this.hooks.assignments(),
        });
        this.heartbeat = setInterval(() => {
          if (Date.now() - this.lastRx > this.staleMs) { this.reconnectStale(); return; }
          this.send({ t: "heartbeat", ts: new Date().toISOString(), metrics: this.hooks.metrics() });
        }, HEARTBEAT_MS);
        this.log.info("authenticated", { nodeId: this.id.nodeId });
        for (const w of this.waiters.splice(0)) w();
        break;
      }
      case "assign": this.hooks.onAssign(m.assignment); break;
      case "fetch": this.hooks.onFetch?.(m.profile); break;
      case "ping":
        if (m.link && Number.isFinite(m.link.rttMs) && m.link.rttMs >= 0 && Number.isFinite(Date.parse(m.link.measuredAt))) this.link = m.link;
        this.send({ t: "pong", ts: m.ts }); break;
      case "error": this.log.warn("control error", { message: m.message }); break;
    }
  }

  /** Control (or a peer through control) wants a local port: only ports of live assignments. */
  private onIncomingStream(stream: MuxStream): boolean {
    const h = stream.header;
    if (h.kind !== "data" && h.kind !== "http") return false;
    if (!this.hooks.allowedPorts().has(h.port)) { this.log.warn("stream to non-allowed port refused", { port: h.port }); return false; }
    this.log.info("incoming stream", { kind: h.kind, port: h.port, from: h.kind === "data" ? h.from : "control", stream: stream.id });
    const sock = netConnect({ host: "127.0.0.1", port: h.port });
    sock.on("connect", () => pipe(stream, sock));
    sock.on("error", (e) => { this.log.warn("incoming stream: local connect failed", { port: h.port, err: e.message }); stream.close(`connect failed: ${e.message}`); });
    return true;
  }
}
