// A worker whose router will not map it can never be dialled, so it dials IN instead.
//
// The coordinator is the natural acceptor: it is the side that holds the model and the engine's RPC
// client, and in the common asymmetric case it is also the side that managed to obtain a gateway
// mapping (node-agent/nat.ts). So the worker connects out to the coordinator's published address,
// announces {"serve": <its own rpc port>}, and then serves that local port over the connection. The
// coordinator pairs the stream with the engine client connection it could not carry itself
// (transport/dial.ts), and bytes then flow exactly as they would over a direct dial - same listener,
// same pinned certificate, same latency, only the direction of the TCP connect differs.
//
// More than one stream is maintained because llama-server opens several RPC connections per worker;
// idle TLS connections cost nothing measurable, and having them already in place means the pairing
// is instant rather than waiting for a fresh dial at load time.

import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { connect as netConnect, type Socket } from "node:net";
import { peerFingerprint } from "./dataListener.ts";
import type { Endpoint } from "../../protocol/types.ts";

export type ServeLog = { info: (m: string, d?: Record<string, unknown>) => void; warn: (m: string, d?: Record<string, unknown>) => void; debug?: (m: string, d?: Record<string, unknown>) => void };

const DIAL_TIMEOUT_MS = 3_000;
const RETRY_MS = 3_000;

export class ServeDialer {
  private running = false;
  private readonly open = new Set<TLSSocket>();
  private timer?: ReturnType<typeof setInterval>;
  private filling = false;
  private target?: Endpoint;
  private servePort = 0;

  constructor(private readonly deps: { certPem: string; keyPem: string; log: ServeLog; max?: number }) {}

  /** Begin maintaining serve streams for `servePort` towards the peer described by `target`. */
  start(target: Endpoint, servePort: number): void {
    if (this.running) return;
    this.running = true;
    this.target = target;
    this.servePort = servePort;
    void this.fill();
    // Top up periodically: a stream the peer never needed is closed by the peer, and a peer that
    // was unreachable at load time may become reachable later.
    this.timer = setInterval(() => { void this.fill(); }, RETRY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    for (const s of this.open) s.destroy();
    this.open.clear();
  }

  /** Streams currently established (for logging and tests). */
  get count(): number { return this.open.size; }

  private async fill(): Promise<void> {
    const target = this.target;
    if (!target || this.filling) return;
    this.filling = true;
    const want = (this.deps.max ?? 4) - this.open.size;
    if (want <= 0) return;
    const socks = await Promise.all(Array.from({ length: want }, () => this.connectOne(target)));
    let opened = 0;
    for (const sock of socks) {
      if (!sock) continue;
      if (!this.running) { sock.destroy(); continue; }
      opened++;
      this.open.add(sock);
      sock.on("close", () => { this.open.delete(sock); });
      sock.on("error", () => { this.open.delete(sock); });
    }
    if (opened === 0 && this.running && this.open.size === 0) this.deps.log.debug?.("serve: no address answered", { node: target.nodeId });
    this.filling = false;
  }

  /**
   * Every advertised address is tried at once: on the networks this exists for, most of them are
   * unroutable, and trying them in sequence would spend the engine's whole load window on timeouts.
   * The first connection that authenticates wins and the rest are dropped.
   */
  private connectOne(target: Endpoint): Promise<TLSSocket | null> {
    if (!target.direct.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let pending = target.direct.length;
      const losers: TLSSocket[] = [];
      const done = (v: TLSSocket | null) => {
        if (settled) { v?.destroy(); return; }
        settled = true;
        // The winner is in `losers` too - every candidate is parked there before it can win - so this
        // must spare it or the stream is destroyed in the same tick it is announced.
        for (const s of losers) { if (s !== v) s.destroy(); }
        resolve(v);
      };
      for (const addr of target.direct) {
        const sock = tlsConnect({ host: addr.host, port: addr.port, cert: this.deps.certPem, key: this.deps.keyPem, rejectUnauthorized: false });
        losers.push(sock);
        const miss = () => { if (--pending === 0) done(null); };
        const timer = setTimeout(() => { sock.destroy(); miss(); }, DIAL_TIMEOUT_MS);
        sock.once("secureConnect", () => {
          clearTimeout(timer);
          // Same pinning as the outbound direct path: the peer must be the node control published.
          if (peerFingerprint(sock) !== target.certFp) {
            this.deps.log.warn("serve: fingerprint mismatch", { node: target.nodeId, host: addr.host });
            sock.destroy(); miss(); return;
          }
          sock.setNoDelay(true);
          sock.write(JSON.stringify({ serve: this.servePort }) + "\n");
          this.attachLocal(sock);
          this.deps.log.info("serve: stream offered", { node: target.nodeId, port: this.servePort, host: addr.host });
          done(sock);
        });
        sock.once("error", () => { clearTimeout(timer); miss(); });
      }
    });
  }

  /**
   * Serve the local engine port over an established stream.
   *
   * Everything arriving before the local socket can accept it is held, not dropped: the peer starts
   * speaking the moment it has the stream, and a chunk lost in the gap between the header and the
   * local connect is enough to hang the rpc handshake forever - which is exactly what the first
   * version of this did. The local connect is retried, because a worker may offer streams before its
   * rpc server is listening.
   */
  private attachLocal(sock: TLSSocket): void {
    const pending: Buffer[] = [];
    let local: Socket | null = null;
    let sink: ((c: Buffer) => void) | null = null;
    let connecting = false;
    // The local rpc-server connection is opened lazily, on the peer's first byte. Connecting every
    // parked stream up front does not work: ggml-rpc-server services a limited number of clients, so
    // a pool of idle connections displaces the one that matters, the stream dies, the worker re-offers
    // and the pool never settles. An unpaired stream now costs one idle TLS connection and nothing else.
    const connectLocal = () => {
      if (connecting || local || !this.running || sock.destroyed) return;
      connecting = true;
      const l = netConnect({ host: "127.0.0.1", port: this.servePort });
      l.setNoDelay(true);
      l.on("connect", () => {
        connecting = false;
        local = l;
        sink = (c) => { if (!l.write(c)) sock.pause(); };
        for (const c of pending.splice(0)) sink(c);
        l.on("data", (c: Buffer) => { if (!sock.write(c)) l.pause(); });
        sock.on("drain", () => l.resume());
      });
      l.on("error", () => {
        connecting = false;
        local = null;
        l.destroy();
        // The rpc-server may not be listening yet; hold the peer's bytes and try again.
        if (this.running && !sock.destroyed) { const t = setTimeout(connectLocal, 500); t.unref?.(); }
      });
      l.on("close", () => sock.destroy());
    };
    sock.on("data", (c: Buffer) => {
      if (sink) { sink(c); return; }
      pending.push(Buffer.from(c));
      connectLocal();
    });
    sock.on("close", () => local?.destroy());
    sock.on("error", () => local?.destroy());
  }
}
