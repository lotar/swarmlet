import { expect, test } from "bun:test";
import { Registry } from "../registry.ts";
import { AgentChannel } from "../channel.ts";
import { fleetNode } from "./fleet-fixture.ts";

const log = { info() {}, warn() {}, debug() {}, error() {} };

/** A connection as `sweep()` sees it: a socket, its ConnData, and counters for what control did to it. */
function conn(silentForMs: number) {
  const sent: string[] = [];
  const ws = {
    data: { authed: true, nodeId: null as string | null, lastSeen: Date.now() - silentForMs, agentVersion: "0.1.0", mux: null, unresponsiveAt: undefined as number | undefined },
    sent,
    closed: 0,
    send(v: string) { sent.push(v); return 1; },
    close() { this.closed++; },
  };
  return ws;
}

function setup() {
  const reg = new Registry(":memory:");
  const node = fleetNode("n1");
  reg.upsertNode({ ...node, caps: node.caps! });
  const calls = { offline: 0, online: 0 };
  const channel = new AgentChannel(reg, log, {
    onOffline: () => { calls.offline++; },
    onNodeOnline: () => { calls.online++; },
  });
  const attach = (ws: ReturnType<typeof conn>) => { ws.data.nodeId = node.id; (channel as unknown as { conns: Map<string, unknown> }).conns.set(node.id, ws); };
  return { reg, channel, calls, attach, nodeId: node.id };
}

test("a quiet node loses its route but not its socket", () => {
  // Live case, 2026-09-16: a node reconnected ~100x/day for five days, every time 30s after its hello,
  // because the control closed a socket that was open but silent. Losing the route is correct; losing the
  // session is what turned one missed ping into a five-day outage of its update path.
  const { reg, channel, calls, attach, nodeId } = setup();
  const ws = conn(60_000);
  attach(ws);
  channel.sweep(30_000);
  expect(channel.isOnline(nodeId)).toBe(false);            // no route: callers must not place work here
  expect(reg.getNode(nodeId)?.online).toBe(false);         // and the registry says so too
  expect(calls.offline).toBe(1);                           // the deployment layer was told
  expect(ws.closed).toBe(0);                               // but the socket survives
  expect(reg.listEvents(20).map((e) => e.message).some((m) => /unresponsive/.test(m))).toBe(true);
  reg.close();
});

test("when it speaks again the same socket is a route again, with no reconnect", () => {
  const { reg, channel, calls, attach, nodeId } = setup();
  const ws = conn(60_000);
  attach(ws);
  channel.sweep(30_000);
  expect(channel.isOnline(nodeId)).toBe(false);

  ws.data.lastSeen = Date.now();                            // a heartbeat, a pong, anything
  channel.sweep(30_000);
  expect(channel.isOnline(nodeId)).toBe(true);
  expect(reg.getNode(nodeId)?.online).toBe(true);
  expect(calls.online).toBe(1);
  expect(ws.closed).toBe(0);                                // never dropped, never reconnected
  expect(reg.listEvents(20).map((e) => e.message).some((m) => /responsive again/.test(m))).toBe(true);
  reg.close();
});

test("only a connection silent far past the window is actually closed", () => {
  const { reg, channel, attach } = setup();
  const ws = conn(60_000);
  attach(ws);
  channel.sweep(30_000);                                    // marked unresponsive, socket kept
  expect(ws.closed).toBe(0);
  ws.data.unresponsiveAt = Date.now() - 5_000;              // it has now been quiet well past the reap factor
  channel.sweep(1_000, 1);
  expect(ws.closed).toBe(1);                                // a genuinely half-open connection is still reaped
  reg.close();
});

test("a healthy node is pinged and left alone", () => {
  const { reg, channel, calls, attach, nodeId } = setup();
  const ws = conn(0);
  attach(ws);
  channel.sweep(30_000);
  expect(channel.isOnline(nodeId)).toBe(true);
  expect(calls.offline).toBe(0);
  expect(ws.closed).toBe(0);
  expect(ws.sent.some((s) => /"t":"ping"/.test(s))).toBe(true);
  reg.close();
});
