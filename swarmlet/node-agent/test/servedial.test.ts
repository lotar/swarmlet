import { describe, expect, test } from "bun:test";
import { createServer, connect as netConnect, type Socket } from "node:net";
import { EarlyBuffer } from "../streams.ts";
import { Dialer } from "../transport/dial.ts";
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
