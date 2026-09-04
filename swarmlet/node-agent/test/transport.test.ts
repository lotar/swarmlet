// Data listener + dialer: direct TLS with fingerprint pinning, refusal of unknown peers and
// non-allowed ports, and relay fallback when no direct address answers.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Server } from "node:net";
import { makeLogger } from "../../control/log.ts";
import { loadIdentity, type Identity } from "../identity.ts";
import { agentPaths } from "../paths.ts";
import { startDataListener } from "../transport/dataListener.ts";
import { Dialer } from "../transport/dial.ts";
import type { Endpoint } from "../../protocol/types.ts";
import { StreamMux, type MuxStream } from "../../protocol/frame.ts";

const log = makeLogger("t", "error");
let a: Identity, b: Identity;
let echo: Server; let echoPort: number;
let listener: ReturnType<typeof startDataListener>; const LPORT = 47899;
const allowedFps = new Set<string>(); const allowedPorts = new Set<number>();

async function roundTrip(port: number, msg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port });
    const t = setTimeout(() => { s.destroy(); reject(new Error("timeout")); }, 5000);
    s.on("connect", () => s.write(msg));
    s.on("data", (d) => { clearTimeout(t); s.destroy(); resolve(d.toString()); });
    s.on("error", (e) => { clearTimeout(t); reject(e); });
    s.on("close", () => { clearTimeout(t); reject(new Error("closed")); });
  });
}

beforeAll(async () => {
  a = await loadIdentity(agentPaths(mkdtempSync(join(tmpdir(), "sw-a-"))));
  b = await loadIdentity(agentPaths(mkdtempSync(join(tmpdir(), "sw-b-"))));
  echo = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  echoPort = (echo.address() as { port: number }).port;
  listener = startDataListener({ host: "127.0.0.1", port: LPORT, certPem: b.certPem, keyPem: b.keyPem, log, policy: { allowedFingerprints: () => allowedFps, allowedPorts: () => allowedPorts } });
  await Bun.sleep(100);
});

afterAll(() => { listener.close(); echo.close(); });

describe("direct TLS path", () => {
  test("pinned fingerprint + allowlisted peer + allowed port: bytes flow", async () => {
    allowedFps.add(a.certFp); allowedPorts.add(echoPort);
    const dialer = new Dialer({ certPem: a.certPem, keyPem: a.keyPem, openRelay: () => null, log });
    const ep: Endpoint = { nodeId: "b", certFp: b.certFp, port: echoPort, direct: [{ host: "127.0.0.1", port: LPORT }], relay: false };
    const lp = await dialer.open(ep);
    expect(await roundTrip(lp.port, "hello")).toBe("hello");
    expect(dialer.currentPath(ep)).toBe("direct");
    dialer.closeAll();
  });

  test("wrong pinned fingerprint is refused by the dialer", async () => {
    const dialer = new Dialer({ certPem: a.certPem, keyPem: a.keyPem, openRelay: () => null, log });
    const ep: Endpoint = { nodeId: "b", certFp: "0".repeat(64), port: echoPort, direct: [{ host: "127.0.0.1", port: LPORT }], relay: false };
    const lp = await dialer.open(ep);
    await expect(roundTrip(lp.port, "x")).rejects.toThrow();
    dialer.closeAll();
  });

  test("unknown client certificate is dropped by the listener", async () => {
    allowedFps.delete(a.certFp);
    const dialer = new Dialer({ certPem: a.certPem, keyPem: a.keyPem, openRelay: () => null, log });
    const ep: Endpoint = { nodeId: "b", certFp: b.certFp, port: echoPort, direct: [{ host: "127.0.0.1", port: LPORT }], relay: false };
    const lp = await dialer.open(ep);
    await expect(roundTrip(lp.port, "x")).rejects.toThrow();
    allowedFps.add(a.certFp);
    dialer.closeAll();
  });

  test("port not in the allowlist is refused", async () => {
    const dialer = new Dialer({ certPem: a.certPem, keyPem: a.keyPem, openRelay: () => null, log });
    const ep: Endpoint = { nodeId: "b", certFp: b.certFp, port: 1, direct: [{ host: "127.0.0.1", port: LPORT }], relay: false };
    const lp = await dialer.open(ep);
    await expect(roundTrip(lp.port, "x")).rejects.toThrow();
    dialer.closeAll();
  });
});

describe("relay fallback", () => {
  test("no direct address answers: the dialer opens a relay stream and bytes flow through it", async () => {
    // fake relay: openRelay returns a mux stream whose peer side is wired to the echo server
    let peer!: StreamMux;
    const me = new StreamMux((f) => queueMicrotask(() => peer.handleFrame(f)), () => false, 1);
    peer = new StreamMux((f) => queueMicrotask(() => me.handleFrame(f)), (s: MuxStream) => {
      const sock = connect({ host: "127.0.0.1", port: echoPort });
      sock.on("data", (d: Buffer) => s.write(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)));
      s.onData((c) => sock.write(Buffer.from(c)));
      s.onEnd(() => sock.destroy());
      return true;
    }, 0);
    const dialer = new Dialer({ certPem: a.certPem, keyPem: a.keyPem, openRelay: (target, port) => me.open({ kind: "relay", target, port, from: "a" }), log });
    const ep: Endpoint = { nodeId: "b", certFp: b.certFp, port: echoPort, direct: [{ host: "127.0.0.1", port: 1 }], relay: true };
    const lp = await dialer.open(ep);
    expect(await roundTrip(lp.port, "via relay")).toBe("via relay");
    expect(dialer.currentPath(ep)).toBe("relay");
    dialer.closeAll();
  });
});
