// Dialer: gives the engine a 127.0.0.1 port for every remote endpoint in an assignment. Each
// accepted local connection is carried either directly (TLS to the peer's data listener, its
// certificate fingerprint pinned to what control published) or, when no direct address answers,
// through a relay stream on the control channel. The choice is remembered per endpoint and
// re-probed after a failure. This replaces ws-bridge.py, websocat, cloudflared and ssh -L.
// Pinning note: certificates are self-signed per node; the fingerprint check on secureConnect is
// the authentication, so CA chain validation is off on purpose.

import { createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Endpoint } from "../../protocol/types.ts";
import type { MuxStream } from "../../protocol/frame.ts";
import type { Logger } from "../../control/log.ts";
import { peerFingerprint } from "./dataListener.ts";
import { EarlyBuffer } from "../streams.ts";

export interface DialerDeps {
  certPem: string;
  keyPem: string;
  openRelay: (targetNodeId: string, port: number) => MuxStream | null;
  log: Logger;
}

export interface LocalPort { port: number; path: "direct" | "relay" | "inbound" | "unknown"; close: () => void }

/** A stream a peer opened to us in the reverse direction, already authorized by its certificate. */
interface ServedStream { sock: TLSSocket; early: EarlyBuffer }

const DIRECT_TIMEOUT_MS = 4000;
/**
 * How long a local engine connection waits for a reverse stream before falling back to the relay.
 * Only ever paid once per endpoint: the outcome is remembered, so a peer that cannot serve us costs
 * one wait at load time and never again.
 */
const SERVED_WAIT_MS = 4000;
/**
 * Unpaired reverse streams held per (peer, port). Generous on purpose: a stream parked here is idle
 * and cheap, whereas destroying one makes the peer re-offer, and a churning pool never settles into
 * the steady set the engine needs. Past the cap the NEWEST offer is refused, so whichever streams are
 * already waiting stay available.
 */
const SERVED_QUEUE_MAX = 12;

export class Dialer {
  private servers: Server[] = [];
  /** Per endpoint: the direct address that worked last, or "relay". */
  private memo = new Map<string, { host: string; port: number } | "relay" | "inbound">();
  /** Reverse streams offered by peers, keyed by peer fingerprint + port, waiting for an engine client. */
  private served = new Map<string, ServedStream[]>();
  /** Engine connections parked waiting for a reverse stream, keyed the same way. */
  private waiting = new Map<string, Array<(s: ServedStream) => void>>();

  constructor(private readonly deps: DialerDeps) {}

  private key(e: Endpoint): string { return `${e.nodeId}:${e.port}`; }

  /** Listen on 127.0.0.1:0 and forward every connection to `e`. Resolves with the local port. */
  async open(e: Endpoint): Promise<LocalPort> {
    const server = createServer((local) => { void this.forward(e, local); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    this.servers.push(server);
    const port = (server.address() as { port: number }).port;
    return { port, path: this.currentPath(e), close: () => server.close() };
  }

  currentPath(e: Endpoint): "direct" | "relay" | "inbound" | "unknown" {
    const m = this.memo.get(this.key(e));
    if (m === "relay" || m === "inbound") return m;
    return m ? "direct" : "unknown";
  }

  private servedKey(fp: string, port: number): string { return `${fp}:${port}`; }

  /**
   * Accept a reverse stream from a peer. Paired immediately with a waiting engine connection when one
   * exists, otherwise held until one arrives - the peer keeps a stream spare, so the pairing is
   * normally instant at load time.
   */
  acceptServed(fp: string, port: number, sock: TLSSocket, early: EarlyBuffer): boolean {
    const k = this.servedKey(fp, port);
    const waiter = this.waiting.get(k)?.shift();
    if (waiter) { waiter({ sock, early }); return true; }
    const queue = this.served.get(k) ?? [];
    if (queue.length >= SERVED_QUEUE_MAX) {
      // Refuse the newest rather than evicting the oldest: the peer's pool is what keeps re-offering.
      this.deps.log.warn("served queue full, refusing offer", { port, depth: queue.length });
      sock.destroy();
      return true;
    }
    // Parked and paused: the peer may speak the moment it sends its header, and a byte read here with
    // nobody to hand it to would be a byte the engine never sees. Paused, it waits in the socket until
    // the engine connection arrives and pairs it.
    sock.pause();
    queue.push({ sock, early });
    this.served.set(k, queue);
    return true;
  }

  /** An engine connection's side of the pairing: wait briefly for a reverse stream for this endpoint. */
  private takeServed(e: Endpoint): Promise<ServedStream | null> {
    const k = this.servedKey(e.certFp, e.port);
    const ready = this.served.get(k)?.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const q = this.waiting.get(k);
        if (q) { const i = q.indexOf(waiter); if (i >= 0) q.splice(i, 1); }
        resolve(null);
      }, SERVED_WAIT_MS);
      timer.unref?.();
      const waiter = (s: ServedStream) => { clearTimeout(timer); resolve(s); };
      const q = this.waiting.get(k) ?? [];
      q.push(waiter);
      this.waiting.set(k, q);
    });
  }

  /** Carry an engine connection over a reverse stream. Byte flow is identical to a direct dial. */
  private pipeServed(e: Endpoint, served: ServedStream, local: Socket, buffered: EarlyBuffer): void {
    const { sock } = served;
    this.memo.set(this.key(e), "inbound");
    this.deps.log.info("inbound serve paired", { node: e.nodeId, port: e.port });
    // A queued stream was paused when it was accepted; the engine is on the other end of it now.
    sock.resume();
    // Two early buffers, and they are not interchangeable: `buffered` holds what the engine wrote
    // before the pairing existed (it belongs on the peer stream), while `served.early` holds what the
    // peer sent after its header (it belongs on the engine connection).
    buffered.attach((c) => { if (!sock.write(c)) local.pause(); });
    sock.on("drain", () => local.resume());
    sock.on("data", (c: Buffer) => { if (!local.write(c)) sock.pause(); });
    local.on("drain", () => sock.resume());
    served.early.attach((c) => { if (!local.write(c)) sock.pause(); });
    sock.on("close", () => local.destroy());
    sock.on("error", () => local.destroy());
    local.on("close", () => sock.destroy());
  }

  closeAll(): void {
    for (const s of this.servers) s.close();
    this.servers = [];
    for (const q of this.served.values()) for (const s of q) s.sock.destroy();
    this.served.clear();
    this.waiting.clear();
  }

  private async forward(e: Endpoint, local: Socket): Promise<void> {
    local.setNoDelay(true);
    const early = new EarlyBuffer();
    let closed = false;
    local.on("data", (c: Buffer) => early.push(c));
    local.on("close", () => { closed = true; });
    local.on("error", () => { closed = true; });
    const remembered = this.memo.get(this.key(e));
    // When the peer offers to serve us, its stream is normally parked before the engine connects, so
    // this costs nothing - whereas trying its addresses first burns a full timeout on each, on exactly
    // the networks where nothing answers.
    let waitedForServed = false;
    if (e.inbound && remembered === undefined) {
      waitedForServed = true;
      const served = await this.takeServed(e);
      if (served) { this.pipeServed(e, served, local, early); return; }
    }
    if (remembered === "inbound") {
      const served = await this.takeServed(e);
      if (served) { this.pipeServed(e, served, local, early); return; }
    }
    if (remembered === undefined || (remembered !== "relay" && remembered !== "inbound")) {
      const last = remembered;
      const candidates = last ? [last, ...e.direct.filter((d) => d.host !== last.host || d.port !== last.port)] : e.direct;
      for (const addr of candidates) {
        if (closed) return;
        const sock = await this.tryDirect(e, addr);
        if (!sock) continue;
        this.memo.set(this.key(e), addr);
        sock.write(JSON.stringify({ port: e.port }) + "\n");
        early.attach((c) => { if (!sock.write(c)) local.pause(); });
        sock.on("drain", () => local.resume());
        sock.on("data", (c: Buffer) => { if (!local.write(c)) sock.pause(); });
        local.on("drain", () => sock.resume());
        sock.on("close", () => local.destroy());
        sock.on("error", () => local.destroy());
        local.on("close", () => sock.destroy());
        if (closed) sock.destroy();
        return;
      }
    }
    // Nothing answered outbound: a peer that cannot be dialled may still serve us by dialling in.
    if (remembered !== "relay" && !waitedForServed) {
      const served = await this.takeServed(e);
      if (served) { this.pipeServed(e, served, local, early); return; }
    }
    if (!e.relay) { this.deps.log.warn("no direct path and relay not allowed", { node: e.nodeId, port: e.port }); local.destroy(); return; }
    const stream = this.deps.openRelay(e.nodeId, e.port);
    if (!stream) { this.deps.log.warn("relay unavailable (control channel down)", { node: e.nodeId }); local.destroy(); return; }
    this.deps.log.info("relay stream opened", { node: e.nodeId, port: e.port, stream: stream.id });
    this.memo.set(this.key(e), "relay");
    early.attach((c) => stream.write(new Uint8Array(c.buffer, c.byteOffset, c.byteLength)));
    stream.onData((c) => { if (!closed) local.write(Buffer.from(c)); });
    stream.onEnd(() => { if (!closed) local.destroy(); });
    local.on("close", () => stream.close("local closed"));
    if (closed) stream.close("local closed");
  }

  private tryDirect(e: Endpoint, addr: { host: string; port: number }): Promise<TLSSocket | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: TLSSocket | null) => { if (!settled) { settled = true; resolve(v); } };
      const sock = tlsConnect({ host: addr.host, port: addr.port, cert: this.deps.certPem, key: this.deps.keyPem, rejectUnauthorized: false });
      const timer = setTimeout(() => { if (!settled) { sock.destroy(); done(null); } }, DIRECT_TIMEOUT_MS);
      sock.once("secureConnect", () => {
        clearTimeout(timer);
        const fp = peerFingerprint(sock);
        if (fp !== e.certFp) { this.deps.log.warn("direct path refused: fingerprint mismatch", { node: e.nodeId, host: addr.host }); sock.destroy(); done(null); return; }
        sock.setNoDelay(true);
        done(sock);
      });
      sock.once("error", (err: Error) => { clearTimeout(timer); if (!settled) this.deps.log.debug("direct path failed", { node: e.nodeId, host: addr.host, err: err.message }); done(null); });
    });
  }
}
