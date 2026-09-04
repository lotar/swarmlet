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
    if (!fp || !policy.allowedFingerprints().has(fp)) { log.warn("data listener: peer refused", { from, fp: fp?.slice(0, 12) }); sock.destroy(); return; }
    sock.setNoDelay(true);
    let head = "";
    let local: Socket | null = null;
    const toLocal = new EarlyBuffer();
    const timer = setTimeout(() => { if (!local) { log.warn("data listener: header timeout", { from }); sock.destroy(); } }, 10_000);
    sock.on("data", (chunk: Buffer) => {
      if (local) { toLocal.push(chunk); return; }
      head += chunk.toString("latin1");
      const nl = head.indexOf("\n");
      if (nl < 0) { if (head.length > 512) sock.destroy(); return; }
      clearTimeout(timer);
      let port = 0;
      try { port = Number((JSON.parse(head.slice(0, nl)) as { port?: unknown }).port); } catch { /* bad header */ }
      if (!Number.isInteger(port) || !policy.allowedPorts().has(port)) { log.warn("data listener: port refused", { from, port }); sock.destroy(); return; }
      const rest = Buffer.from(head.slice(nl + 1), "latin1");
      head = "";
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
    });
    sock.on("error", () => { /* peer side logs */ });
  });
  server.on("tlsClientError", (e) => log.debug("data listener: tls client error", { err: e.message }));
  server.listen(opts.port, opts.host, () => log.info("data listener up", { host: opts.host, port: opts.port }));
  return server;
}
