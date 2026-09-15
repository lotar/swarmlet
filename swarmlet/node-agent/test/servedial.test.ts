import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { EarlyBuffer } from "../streams.ts";
import { Dialer } from "../transport/dial.ts";
import { ServeDialer } from "../transport/servedial.ts";
import { startDataListener } from "../transport/dataListener.ts";
import { loadIdentity, type Identity } from "../identity.ts";
import { agentPaths } from "../paths.ts";
import type { Endpoint } from "../../protocol/types.ts";

const FP = "AA:BB";
const e: Endpoint = { nodeId: "worker-1", certFp: FP, port: 50200, direct: [], relay: false };

/** A socketpair standing in for a peer's reverse stream: [our side, the peer's side]. */
async function socketPair(): Promise<[Socket, Socket]> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const accepted = new Promise<Socket>((r) => server.once("connection", r));
  const peer = netConnect(port, "127.0.0.1");
  const ours = await accepted;
  return [ours, peer];
}

function dialer() {
  return new Dialer({
    certPem: "", keyPem: "",
    openRelay: () => null,
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  } as never);
}

const openLocal = async (d: Dialer) => {
  const lp = await d.open(e);
  const local = netConnect(lp.port, "127.0.0.1");
  await new Promise<void>((r) => local.once("connect", () => r()));
  return { lp, local };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("reverse dial", () => {
  test("a stream offered first is paired with the engine connection that arrives later", async () => {
    const d = dialer();
    const [ours, peer] = await socketPair();
    d.acceptServed(FP, 50200, ours as never, new EarlyBuffer());
    const { lp, local } = await openLocal(d);
    local.write("ping");
    const got = await new Promise<Buffer>((r) => peer.once("data", (c) => r(c as Buffer)));
    expect(got.toString()).toBe("ping");
    peer.write("pong");
    const back = await new Promise<Buffer>((r) => local.once("data", (c) => r(c as Buffer)));
    expect(back.toString()).toBe("pong");
    // The engine's own view of the path, which is what the assignment log reports.
    expect(d.currentPath(e)).toBe("inbound");
    expect(lp.path).toBe("unknown"); // recorded at open() time, before pairing
    d.closeAll();
  });

  test("an engine connection waits for a stream that arrives afterwards", async () => {
    const d = dialer();
    const { local } = await openLocal(d);
    const [ours, peer] = await socketPair();
    await wait(150);
    d.acceptServed(FP, 50200, ours as never, new EarlyBuffer());
    local.write("late");
    const got = await new Promise<Buffer>((r) => peer.once("data", (c) => r(c as Buffer)));
    expect(got.toString()).toBe("late");
    expect(d.currentPath(e)).toBe("inbound");
    d.closeAll();
  });

  test("a stream for another port is not paired with this endpoint", async () => {
    const d = dialer();
    const [ours] = await socketPair();
    d.acceptServed(FP, 9999, ours as never, new EarlyBuffer()); // different port
    const { lp } = await openLocal(d);
    expect(d.currentPath(e)).toBe("unknown"); // nothing paired: this endpoint is still unresolved
    expect(lp.port).toBeGreaterThan(0);
    d.closeAll();
  });
});

// The tests below drive the whole reverse path end to end - a real ServeDialer sweeping its
// candidate addresses, a real data listener accepting the offer, and a real Dialer pairing the
// stream with the engine connection - because the defects they cover are in exactly that handover,
// not in the Dialer's bookkeeping. Assertions are byte counts, contents and socket state only -
// never log lines: a stream destroyed during the handover still logs "stream offered" and
// "serve accepted".

const silent = { info: () => {}, warn: () => {}, debug: () => {} };
let worker: Identity; // serves its own rpc port out: the ServeDialer side
let coord: Identity; // accepts the served stream: data listener + Dialer

beforeAll(async () => {
  worker = await loadIdentity(agentPaths(mkdtempSync(join(tmpdir(), "sw-servedial-w-"))));
  coord = await loadIdentity(agentPaths(mkdtempSync(join(tmpdir(), "sw-servedial-c-"))));
});

async function waitFor(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} never became true`);
    await wait(20);
  }
}

/** Waits until `have()` holds at least n bytes; reports the shortfall itself, never a log line. */
async function atLeast(have: () => Buffer, n: number, what: string, dead: () => boolean = () => false): Promise<void> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const got = have().length;
    if (got >= n) return;
    if (dead()) throw new Error(`${what} closed after ${got}/${n} bytes`);
    if (Date.now() > deadline) throw new Error(`timed out: ${what} got ${got}/${n} bytes`);
    await wait(20);
  }
}

interface EngineConn { local: Socket; path: () => "direct" | "relay" | "inbound" | "unknown"; bytes: () => Buffer }

/**
 * One engine round trip over the paired stream: the served rpc server must receive exactly `frame`,
 * and the engine connection exactly that many bytes back.
 */
async function roundTrip(engine: EngineConn, rpcBytes: () => Buffer, frame: Buffer): Promise<void> {
  const rpcHad = rpcBytes().length;
  const engineHad = engine.bytes().length;
  engine.local.write(frame);
  await atLeast(rpcBytes, rpcHad + frame.length, "the served rpc server", () => engine.local.destroyed);
  expect(rpcBytes().subarray(rpcHad).equals(frame)).toBe(true);
  await atLeast(engine.bytes, engineHad + frame.length, "the engine connection", () => engine.local.destroyed);
  expect(engine.bytes().subarray(engineHad).equals(frame)).toBe(true);
}

/**
 * A worker's rpc port served to a coordinator over the real modules. `max: 1` on the ServeDialer
 * keeps the pool exact, so `serve.count` says precisely whether the stream the sweep announced is
 * still open.
 */
async function reverseRig() {
  const rpcChunks: Buffer[] = [];
  // Stand-in for ggml-rpc-server: records every byte that reaches it and echoes it back.
  const rpc = createServer((s) => { s.on("data", (c: Buffer) => { rpcChunks.push(Buffer.from(c)); s.write(c); }); });
  await new Promise<void>((r) => rpc.listen(0, "127.0.0.1", () => r()));
  const rpcPort = (rpc.address() as { port: number }).port;

  const dial = new Dialer({ certPem: coord.certPem, keyPem: coord.keyPem, openRelay: () => null, log: silent } as never);
  const listener = startDataListener({
    host: "127.0.0.1", port: 0, certPem: coord.certPem, keyPem: coord.keyPem, log: silent as never,
    policy: {
      allowedFingerprints: () => new Set<string>(),
      allowedPorts: () => new Set<number>(),
      allowedServePorts: () => new Set([rpcPort]),
      onServe: (fp, port, sock, early) => dial.acceptServed(fp, port, sock, early),
    },
  });
  await new Promise<void>((r) => listener.once("listening", () => r()));
  const dataPort = (listener.address() as { port: number }).port;

  const serve = new ServeDialer({ certPem: worker.certPem, keyPem: worker.keyPem, log: silent, max: 1 });
  serve.start({ nodeId: "coord", certFp: coord.certFp, port: rpcPort, direct: [{ host: "127.0.0.1", port: dataPort }], relay: false }, rpcPort);

  const ep: Endpoint = { nodeId: "worker-1", certFp: worker.certFp, port: rpcPort, direct: [], relay: false, inbound: true };
  return {
    serve,
    rpcBytes: () => Buffer.concat(rpcChunks),
    /** The engine's own connection to the served port, paired through the Dialer. */
    async engine(): Promise<EngineConn> {
      const lp = await dial.open(ep);
      const local = netConnect(lp.port, "127.0.0.1");
      await new Promise<void>((r) => local.once("connect", () => r()));
      const chunks: Buffer[] = [];
      local.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      return { local, path: () => dial.currentPath(ep), bytes: () => Buffer.concat(chunks) };
    },
    close() { serve.stop(); listener.close(); rpc.close(); dial.closeAll(); },
  };
}

describe("reverse stream carries bytes", () => {
  test("the sweep spares the winning address: a 1 KiB frame with no newline reaches the engine", async () => {
    const rig = await reverseRig();
    try {
      await waitFor(() => rig.serve.count === 1, "the stream the sweep announced must stay open");
      // The losing candidates are destroyed in the same tick the header is written; the winner must
      // not be one of them, and the close event that would drop `count` to 0 lands long before this.
      await wait(200);
      expect(rig.serve.count).toBe(1);
      const engine = await rig.engine();
      const frame = Buffer.alloc(1024, 0x52); // one chunk, no newline anywhere
      await roundTrip(engine, rig.rpcBytes, frame);
      // And the stream must outlive that frame: a parser still watching it kills it in this tick.
      await roundTrip(engine, rig.rpcBytes, Buffer.alloc(64, 0x53));
      expect(engine.path()).toBe("inbound");
    } finally { rig.close(); }
  });

  test("newline bytes in engine traffic are not re-read as the serve header", async () => {
    const rig = await reverseRig();
    try {
      await waitFor(() => rig.serve.count === 1, "the stream the sweep announced must stay open");
      const engine = await rig.engine();
      // A complete header line, then 600 bytes with no newline, then more newlines: both shapes the
      // stale parser trips on, in the frame that leaves the pairing alive on the first round trip.
      const frame = Buffer.concat([Buffer.from('{"port":1}\n'), Buffer.alloc(600, 0x46), Buffer.from("\nBODY\n")]);
      await roundTrip(engine, rig.rpcBytes, frame);
      await roundTrip(engine, rig.rpcBytes, Buffer.from("tail\n"));
    } finally { rig.close(); }
  });

  test("a served stream stays usable across 12 engine round trips in both directions", async () => {
    const rig = await reverseRig();
    try {
      await waitFor(() => rig.serve.count === 1, "the stream the sweep announced must stay open");
      const engine = await rig.engine();
      let sent = 0;
      for (let i = 1; i <= 12; i++) {
        // 112 bytes each, no newline: the shape that accumulated past the header limit at frame 6.
        const frame = Buffer.from(`frame-${i}-${"q".repeat(100)}`);
        sent += frame.length;
        await roundTrip(engine, rig.rpcBytes, frame);
      }
      expect(rig.rpcBytes().length).toBe(sent);
      // Still usable at the end, not merely usable once.
      expect(engine.local.destroyed).toBe(false);
      expect(engine.path()).toBe("inbound");
    } finally { rig.close(); }
  });
});
