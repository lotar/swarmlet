// The node's only exposed socket: a TLS listener (default 0.0.0.0:47801) that forwards to local
// engine ports. A peer must present a client certificate whose SHA-256 fingerprint is in the
// allowlist control attached to the current assignments, then send one JSON header line
// {"port": N}\n naming an allowed local port. Everything else is dropped.
// Certificates are self-signed and pinned by fingerprint (the control plane binds fingerprints to
// enrolled identities), so chain validation is intentionally off and the fingerprint check is the
// authentication.

import { connect as netConnect, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";
import { normalizeFingerprint } from "../../protocol/sign.ts";
import type { Logger } from "../../control/log.ts";
import { EarlyBuffer } from "../streams.ts";

export interface ListenerPolicy {
  allowedFingerprints: () => Set<string>;
  allowedPorts: () => Set<number>;
  /**
   * Ports this node expects a peer to serve TO it over a reverse connection (the peer's rpc ports).
   * Authorizing separately from allowedPorts keeps the two directions distinct: allowedPorts is
   * "what you may reach on me", this is "what you may hand me from yourself".
   */
  allowedServePorts: () => Set<number>;
  /** Take ownership of a reverse stream. False means nobody is waiting for it: the peer will retry. */
  onServe: (fp: string, port: number, sock: TLSSocket, early: EarlyBuffer) => boolean;
}

export function peerFingerprint(sock: TLSSocket): string | null {
  const cert = sock.getPeerCertificate();
  const fp = (cert as { fingerprint256?: string } | null)?.fingerprint256;
  if (!fp) return null;
  try { return normalizeFingerprint(fp); } catch { return null; }
}

export function startDataListener(opts: { host: string; port: number; certPem: string; keyPem: string; policy: ListenerPolicy; log: Logger }): TlsServer {
  const { policy, log } = opts;
  const server = createTlsServer({ cert: opts.certPem, key: opts.keyPem, requestCert: true, rejectUnauthorized: false }, (sock) => {
    const fp = peerFingerprint(sock);
    const from = `${sock.remoteAddress}:${sock.remotePort}`;
    if (!fp) { log.warn("data listener: no client certificate", { from }); sock.destroy(); return; }
    sock.setNoDelay(true);
    let head = "";
    let local: Socket | null = null;
    const toLocal = new EarlyBuffer();
    const timer = setTimeout(() => { if (!local) { log.warn("data listener: header timeout", { from }); sock.destroy(); } }, 10_000);
    const onData = (chunk: Buffer) => {
      if (local) { toLocal.push(chunk); return; }
      head += chunk.toString("latin1");
      const nl = head.indexOf("\n");
      if (nl < 0) { if (head.length > 512) sock.destroy(); return; }
      clearTimeout(timer);
      let header: { port?: unknown; serve?: unknown } = {};
      try { header = JSON.parse(head.slice(0, nl)) as { port?: unknown; serve?: unknown }; } catch { /* bad header */ }
      const rest = Buffer.from(head.slice(nl + 1), "latin1");
      head = "";
      // {"serve": n}: the peer is the RPC server (it could not be dialled, so it dialled us) and is
      // handing us its port n over this connection. No local connect happens here - the dialer pairs
      // the stream with the engine client connection it could not carry itself.
      if (header.serve !== undefined) {
        // Authorized by the runner against the assignment's own rpc endpoints - a peer may only serve
        // a port this node is actually waiting for, from the fingerprint control named for it.
        const servePort = Number(header.serve);
        if (!Number.isInteger(servePort) || !policy.allowedServePorts().has(servePort)) { log.warn("data listener: serve refused", { from, port: servePort }); sock.destroy(); return; }
        const early = new EarlyBuffer();
        if (rest.length) early.push(rest);
        sock.setNoDelay(true);
        if (!policy.onServe(fp, servePort, sock, early)) { log.warn("data listener: serve unwanted", { from, port: servePort }); sock.destroy(); return; }
        // The assignment owns this stream now, so this handler must not see another byte of it. Left
        // attached it re-reads engine traffic as headers and destroys the stream the engine is using:
        // an rpc load produces both shapes that trip it - over 512 bytes with no newline in them, and
        // newlines inside a frame - so the pairing worked and then the transfer died mid-load.
        sock.off("data", onData);
        log.info("data listener: serve accepted", { from, port: servePort });
        return;
      }
      if (!policy.allowedFingerprints().has(fp)) { log.warn("data listener: peer refused", { from, fp: fp.slice(0, 12) }); sock.destroy(); return; }
      const port = Number(header.port);
      if (!Number.isInteger(port) || !policy.allowedPorts().has(port)) { log.warn("data listener: port refused", { from, port }); sock.destroy(); return; }
      local = netConnect({ host: "127.0.0.1", port });
      local.setNoDelay(true);
      if (rest.length) toLocal.push(rest);
      local.on("connect", () => {
        const l = local!;
        toLocal.attach((c) => { if (!l.write(c)) sock.pause(); });
        l.on("drain", () => sock.resume());
        l.on("data", (c: Buffer) => { if (!sock.write(c)) l.pause(); });
        sock.on("drain", () => l.resume());
      });
      local.on("error", (e) => { log.warn("data listener: local connect failed", { port, err: e.message }); sock.destroy(); });
      local.on("close", () => sock.destroy());
      sock.on("close", () => local?.destroy());
    };
    sock.on("data", onData);
    sock.on("error", () => { /* peer side logs */ });
  });
  server.on("tlsClientError", (e) => log.debug("data listener: tls client error", { err: e.message }));
  server.listen(opts.port, opts.host, () => log.info("data listener up", { host: opts.host, port: opts.port }));
  return server;
}
