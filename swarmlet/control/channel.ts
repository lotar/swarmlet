// Agent channel: one WebSocket per node. Text frames are protocol messages, binary frames are
// multiplexed streams (protocol/frame.ts). Auth is a nonce challenge signed by the node's enrolled
// key. Relay: an agent opens {kind:"relay", target, port} and control bridges it to a
// {kind:"data", port, from} stream on the target node.

import type { ServerWebSocket } from "bun";
import { bridge, StreamMux, type MuxStream } from "../protocol/frame.ts";
import { canonicalize, importPublicJwk, normalizeFingerprint } from "../protocol/sign.ts";
import { parseAgentMessage } from "../protocol/validate.ts";
import type { AgentToControl, Assignment, AssignmentState, ControlToAgent, HelloMsg, StreamHeader } from "../protocol/types.ts";
import type { Logger } from "./log.ts";
import type { Registry } from "./registry.ts";

export interface ConnData {
  nonce: string;
  nodeId: string | null;
  authed: boolean;
  mux: StreamMux | null;
  agentVersion: string;
  lastSeen: number;
}

export interface ChannelHooks {
  /** Assignment state change reported by a node. */
  onAssignmentState?: (nodeId: string, id: string, state: AssignmentState, detail?: string) => void;
  onLog?: (nodeId: string, assignmentId: string, line: string) => void;
  onHello?: (nodeId: string, hello: HelloMsg) => void;
  onOffline?: (nodeId: string) => void;
}

const encoder = new TextEncoder();

function randomNonce(): string {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class AgentChannel {
  private conns = new Map<string, ServerWebSocket<ConnData>>();
  private logs = new Map<string, string[]>();
  /** Set by the process shutdown path: connection closes are then not node failures. */
  shuttingDown = false;

  constructor(private readonly reg: Registry, private readonly log: Logger, private readonly hooks: ChannelHooks = {}) {}

  newConnData(): ConnData {
    return { nonce: randomNonce(), nodeId: null, authed: false, mux: null, agentVersion: "", lastSeen: Date.now() };
  }

  isOnline(nodeId: string): boolean { return this.conns.has(nodeId); }
  onlineNodeIds(): string[] { return [...this.conns.keys()]; }

  send(nodeId: string, msg: ControlToAgent): boolean {
    const ws = this.conns.get(nodeId);
    if (!ws) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  assign(nodeId: string, assignment: Assignment): boolean {
    this.reg.putAssignment(assignment, nodeId, "sent");
    return this.send(nodeId, { t: "assign", assignment });
  }

  /** Open a stream to a node's local port (router HTTP forwarding, control-initiated data). */
  openStream(nodeId: string, header: StreamHeader): MuxStream | null {
    const ws = this.conns.get(nodeId);
    if (!ws?.data.mux) return null;
    return ws.data.mux.open(header);
  }

  recentLogs(assignmentId: string): string[] { return this.logs.get(assignmentId) ?? []; }

  // ---------- Bun websocket handlers ----------

  open(ws: ServerWebSocket<ConnData>): void {
    ws.send(JSON.stringify({ t: "challenge", nonce: ws.data.nonce } satisfies ControlToAgent));
  }

  async message(ws: ServerWebSocket<ConnData>, raw: string | Buffer): Promise<void> {
    ws.data.lastSeen = Date.now();
    if (typeof raw !== "string") {
      if (!ws.data.authed || !ws.data.mux) { ws.close(1008, "not authenticated"); return; }
      try { ws.data.mux.handleFrame(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)); }
      catch (e) { this.log.warn("bad frame", { nodeId: ws.data.nodeId, err: (e as Error).message }); }
      return;
    }
    const parsed = parseAgentMessage(raw);
    if (!parsed.ok) { this.log.warn("bad message", { nodeId: ws.data.nodeId, errors: parsed.errors }); ws.send(JSON.stringify({ t: "error", message: parsed.errors.join("; ") })); return; }
    const m = parsed.value;
    if (!ws.data.authed) {
      if (m.t !== "auth") { ws.close(1008, "auth first"); return; }
      await this.authenticate(ws, m);
      return;
    }
    const nodeId = ws.data.nodeId!;
    switch (m.t) {
      case "hello": {
        ws.data.agentVersion = m.agentVersion;
        this.reg.setOnline(nodeId, true, m.agentVersion);
        this.reg.setCaps(nodeId, m.caps);
        this.reg.setOffer(nodeId, m.offer);
        this.reg.setModels(nodeId, m.models);
        for (const a of m.assignments) this.reg.setAssignmentState(a.id, a.state, "reported at hello");
        this.reg.event("online", `${m.caps.hostname} online (agent ${m.agentVersion})`, { nodeId });
        this.hooks.onHello?.(nodeId, m);
        break;
      }
      case "heartbeat": this.reg.setMetrics(nodeId, m.metrics, m.caps); break;
      case "offer": this.reg.setOffer(nodeId, m.offer); this.reg.event("offer", "offer updated", { nodeId }); break;
      case "models": this.reg.setModels(nodeId, m.models); break;
      case "assignment": {
        const row = this.reg.setAssignmentState(m.id, m.state, m.detail);
        this.reg.event("assignment", `${m.id} ${m.state}${m.detail ? ": " + m.detail : ""}`, { nodeId, deploymentId: row?.deploymentId });
        this.hooks.onAssignmentState?.(nodeId, m.id, m.state, m.detail);
        break;
      }
      case "log": {
        const buf = this.logs.get(m.assignmentId) ?? [];
        buf.push(m.line); if (buf.length > 400) buf.splice(0, buf.length - 400);
        this.logs.set(m.assignmentId, buf);
        this.hooks.onLog?.(nodeId, m.assignmentId, m.line);
        break;
      }
      case "pong": break;
      case "auth": break; // already authenticated
    }
  }

  close(ws: ServerWebSocket<ConnData>): void {
    const nodeId = ws.data.nodeId;
    ws.data.mux?.closeAll("node disconnected");
    if (nodeId && this.conns.get(nodeId) === ws) {
      this.conns.delete(nodeId);
      this.reg.setOnline(nodeId, false);
      if (this.shuttingDown) return; // control is restarting; nodes reconnect and re-report
      this.reg.event("offline", "disconnected", { nodeId });
      this.hooks.onOffline?.(nodeId);
    }
  }

  /** Send a ping to every node; drop connections silent for longer than `staleMs`. */
  sweep(staleMs = 30_000): void {
    const cutoff = Date.now() - staleMs;
    for (const [nodeId, ws] of this.conns) {
      if (ws.data.lastSeen < cutoff) { this.log.warn("stale connection dropped", { nodeId }); ws.close(1001, "stale"); continue; }
      ws.send(JSON.stringify({ t: "ping", ts: new Date().toISOString() } satisfies ControlToAgent));
    }
  }

  // ---------- internals ----------

  private async authenticate(ws: ServerWebSocket<ConnData>, m: Extract<AgentToControl, { t: "auth" }>): Promise<void> {
    const node = this.reg.getNode(m.nodeId);
    const fail = (why: string) => { this.log.warn("auth failed", { nodeId: m.nodeId, why }); ws.close(1008, why); };
    if (!node) return fail("unknown node (enroll first)");
    if (m.nonce !== ws.data.nonce) return fail("nonce mismatch");
    let fp: string;
    try { fp = normalizeFingerprint(m.certFp); } catch { return fail("bad fingerprint"); }
    if (fp !== node.certFp) return fail("certificate fingerprint changed (re-enroll)");
    const pub = await importPublicJwk(node.pubJwk);
    const data = encoder.encode(canonicalize({ nodeId: m.nodeId, nonce: m.nonce, certFp: fp }));
    let ok = false;
    try { ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, Uint8Array.from(atob(m.signature), (c) => c.charCodeAt(0)), data); } catch { ok = false; }
    if (!ok) return fail("bad signature");
    const prev = this.conns.get(m.nodeId);
    if (prev && prev !== ws) { prev.data.nodeId = null; prev.close(1000, "replaced by a newer connection"); }
    ws.data.nodeId = m.nodeId;
    ws.data.authed = true;
    ws.data.mux = new StreamMux((f) => ws.send(f), (stream) => this.onAgentStream(m.nodeId, stream), 0);
    this.conns.set(m.nodeId, ws);
    ws.send(JSON.stringify({ t: "welcome", nodeId: m.nodeId, serverTime: new Date().toISOString() } satisfies ControlToAgent));
  }

  /** A node opened a stream towards control: only relays are accepted. */
  private onAgentStream(fromNodeId: string, stream: MuxStream): boolean {
    const h = stream.header;
    if (h.kind !== "relay") { this.log.warn("unexpected stream kind from agent", { fromNodeId, kind: h.kind }); return false; }
    if (h.from !== fromNodeId) return false;
    const target = this.conns.get(h.target);
    if (!target?.data.mux) { this.log.debug("relay target offline", { fromNodeId, target: h.target }); return false; }
    const right = target.data.mux.open({ kind: "data", port: h.port, from: fromNodeId });
    bridge(stream, right);
    return true;
  }
}
