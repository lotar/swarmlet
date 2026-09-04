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

export interface LocalPort { port: number; path: "direct" | "relay" | "unknown"; close: () => void }

const DIRECT_TIMEOUT_MS = 4000;

export class Dialer {
  private servers: Server[] = [];
  /** Per endpoint: the direct address that worked last, or "relay". */
  private memo = new Map<string, { host: string; port: number } | "relay">();

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

  currentPath(e: Endpoint): "direct" | "relay" | "unknown" {
    const m = this.memo.get(this.key(e));
    return m === "relay" ? "relay" : m ? "direct" : "unknown";
  }

  closeAll(): void {
    for (const s of this.servers) s.close();
    this.servers = [];
  }

  private async forward(e: Endpoint, local: Socket): Promise<void> {
    local.setNoDelay(true);
    const early = new EarlyBuffer();
    let closed = false;
    local.on("data", (c: Buffer) => early.push(c));
    local.on("close", () => { closed = true; });
    local.on("error", () => { closed = true; });
    const remembered = this.memo.get(this.key(e));
    if (remembered !== "relay") {
      const candidates = remembered ? [remembered, ...e.direct.filter((d) => d.host !== remembered.host || d.port !== remembered.port)] : e.direct;
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
