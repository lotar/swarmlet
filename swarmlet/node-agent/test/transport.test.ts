// Data listener + dialer: direct TLS with fingerprint pinning, refusal of unknown peers and
// non-allowed ports, and relay fallback when no direct address answers.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type Server } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { makeLogger } from "../../control/log.ts";
import { loadIdentity, type Identity } from "../identity.ts";
import { agentPaths } from "../paths.ts";
import { startDataListener } from "../transport/dataListener.ts";
import { EarlyBuffer } from "../streams.ts";
import { Dialer } from "../transport/dial.ts";
import type { Endpoint } from "../../protocol/types.ts";
import { StreamMux, type MuxStream } from "../../protocol/frame.ts";

const log = makeLogger("t", "error");
let a: Identity, b: Identity;
let echo: Server; let echoPort: number;
let listener: ReturnType<typeof startDataListener>; const LPORT = 47899;
const allowedFps = new Set<string>(); const allowedPorts = new Set<number>();
/** A second listener whose policy accepts a reverse serve offer; the test is the stream's owner. */
let serveListener: ReturnType<typeof startDataListener>; const SERVE_LPORT = 47898; const SERVE_TARGET_PORT = 50200;
const servePorts = new Set<number>();

/**
 * Owner of a served stream, as an assignment runner is in production: wires the socket straight to
 * the echo server and looks at nothing else. So a byte the listener still parsed as a header is a
 * byte the echo server never sees.
 */
function takeOver(_fp: string, _port: number, sock: TLSSocket, early: EarlyBuffer): boolean {
  const up = connect({ host: "127.0.0.1", port: echoPort });
  early.attach((c) => up.write(c));
  sock.on("data", (c: Buffer) => up.write(c));
  up.on("data", (c: Buffer) => sock.write(c));
  up.on("close", () => sock.destroy());
  sock.on("close", () => up.destroy());
  return true;
}

/** The peer's side of a reverse dial: a real client certificate, then the serve header. */
async function servedClient(): Promise<TLSSocket> {
  servePorts.add(SERVE_TARGET_PORT);
  const sock = tlsConnect({ host: "127.0.0.1", port: SERVE_LPORT, cert: a.certPem, key: a.keyPem, rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => { sock.once("secureConnect", () => resolve()); sock.once("error", reject); });
  sock.write(JSON.stringify({ serve: SERVE_TARGET_PORT }) + "\n");
  return sock;
}

/** Writes one frame and waits for exactly that many bytes back; asserts on bytes, never on logs. */
async function echoFrame(sock: TLSSocket, frame: Buffer, timeoutMs = 4000): Promise<Buffer> {
  const got: Buffer[] = [];
  const sink = (c: Buffer) => { got.push(Buffer.from(c)); };
  sock.on("data", sink);
  sock.write(frame);
  const deadline = Date.now() + timeoutMs;
  while (Buffer.concat(got).length < frame.length) {
    const n = Buffer.concat(got).length;
    if (sock.destroyed) throw new Error(`socket destroyed after ${n}/${frame.length} bytes`);
    if (Date.now() > deadline) throw new Error(`echo timed out: ${n}/${frame.length} bytes`);
    await Bun.sleep(20);
  }
  sock.off("data", sink);
  return Buffer.concat(got);
}

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
  listener = startDataListener({ host: "127.0.0.1", port: LPORT, certPem: b.certPem, keyPem: b.keyPem, log, policy: { allowedFingerprints: () => allowedFps, allowedPorts: () => allowedPorts, allowedServePorts: () => new Set<number>(), onServe: () => false } });
  serveListener = startDataListener({ host: "127.0.0.1", port: SERVE_LPORT, certPem: b.certPem, keyPem: b.keyPem, log, policy: { allowedFingerprints: () => new Set<string>(), allowedPorts: () => new Set<number>(), allowedServePorts: () => servePorts, onServe: takeOver } });
  await Bun.sleep(100);
});

afterAll(() => { listener.close(); serveListener.close(); echo.close(); });

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

// Once a serve offer is handed to its owner, the listener must stop looking at the stream: the
// header line parser is left attached otherwise, and engine traffic matches its two trip-wires - a
// chunk past the 512-byte header limit, and a newline, which it re-reads as a header terminator and
// answers by destroying the socket the engine is using.
describe("reverse serve path", () => {
  test("a paired serve stream survives a frame over the 512-byte header limit", async () => {
    const sock = await servedClient();
    // A plain frame first: it forces a round-trip boundary, so the probe frame below always arrives
    // as data the listener's own handler sees on its own.
    const plain = Buffer.alloc(64, 0x41);
    expect((await echoFrame(sock, plain)).equals(plain)).toBe(true);
    const frame = Buffer.alloc(4096, 0x41); // one chunk, no newline anywhere
    expect((await echoFrame(sock, frame)).equals(frame)).toBe(true);
    sock.destroy();
  });

  test("a paired serve stream survives newline bytes inside a frame", async () => {
    const sock = await servedClient();
    const plain = Buffer.alloc(64, 0x42);
    expect((await echoFrame(sock, plain)).equals(plain)).toBe(true);
    // A complete header line, then 600 bytes with no newline, then more newlines: the parser either
    // re-reads this as a header and destroys the stream, or lets it through whole.
    const frame = Buffer.concat([Buffer.from('{"port":1}\n'), Buffer.alloc(600, 0x42), Buffer.from("\nend\n")]);
    expect((await echoFrame(sock, frame)).equals(frame)).toBe(true);
    sock.destroy();
  });
});
