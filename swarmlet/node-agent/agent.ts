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
  /** Local ports a `data` stream may be connected to right now. */
  allowedPorts: () => Set<number>;
}

export const AGENT_VERSION = "0.1.0";

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}

export async function enroll(controlUrl: string, code: string, id: Identity, caps: Capabilities): Promise<EnrollResponse> {
  const body: EnrollRequest = { code, nodeId: id.nodeId, pubJwk: id.pubJwk, certFp: id.certFp, hostname: caps.hostname, caps };
  const signed = await signObject(body, id.keys.priv);
  const res = await fetch(`${controlUrl.replace(/\/$/, "")}/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  const text = await res.text();
  let out: EnrollResponse | { error: string } | null = null;
  try { out = JSON.parse(text) as EnrollResponse | { error: string }; } catch { out = null; }
  if (!res.ok || !out || !("ok" in out)) throw new Error(`enroll failed (${res.status}): ${out && "error" in out ? out.error : text.replace(/\s+/g, " ").slice(0, 120) || "no body"}`);
  return out;
}

export class AgentClient {
  private ws: WebSocket | null = null;
  private mux: StreamMux | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private backoffMs = 1000;
  private _connected = false;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly agentUrl: string,
    private readonly id: Identity,
    private readonly hooks: AgentHooks,
    private readonly log: Logger,
  ) {}

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
    ws.onopen = () => { this.backoffMs = 1000; };
    ws.onmessage = (ev) => { void this.onMessage(ev.data as string | ArrayBuffer); };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = (ev) => {
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
    const ws = this.ws; this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, reason);
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
        this.mux = new StreamMux((f) => this.ws?.send(f), (s) => this.onIncomingStream(s), 1);
        this._connected = true;
        this.send({
          t: "hello", proto: PROTOCOL_VERSION, agentVersion: AGENT_VERSION,
          caps: this.hooks.caps(), offer: this.hooks.offer(), models: this.hooks.models(), assignments: this.hooks.assignments(),
        });
        this.heartbeat = setInterval(() => this.send({ t: "heartbeat", ts: new Date().toISOString(), metrics: this.hooks.metrics() }), HEARTBEAT_MS);
        this.log.info("authenticated", { nodeId: this.id.nodeId });
        for (const w of this.waiters.splice(0)) w();
        break;
      }
      case "assign": this.hooks.onAssign(m.assignment); break;
      case "ping": this.send({ t: "pong", ts: m.ts }); break;
      case "error": this.log.warn("control error", { message: m.message }); break;
    }
  }

  /** Control (or a peer through control) wants a local port: only ports of live assignments. */
  private onIncomingStream(stream: MuxStream): boolean {
    const h = stream.header;
    if (h.kind !== "data" && h.kind !== "http") return false;
    if (!this.hooks.allowedPorts().has(h.port)) { this.log.warn("stream to non-allowed port refused", { port: h.port }); return false; }
    const sock = netConnect({ host: "127.0.0.1", port: h.port });
    sock.on("connect", () => pipe(stream, sock));
    sock.on("error", (e) => stream.close(`connect failed: ${e.message}`));
    return true;
  }
}
