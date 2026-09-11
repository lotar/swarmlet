// The agent must notice a control link that went silent (half-open TCP path) and dial again on its
// own, instead of staying "connected" until the kernel abandons the socket. A fake control server
// completes the challenge/welcome handshake and then either keeps pinging or says nothing more.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentClient } from "../agent.ts";
import { loadIdentity } from "../identity.ts";
import { agentPaths } from "../paths.ts";
import { makeLogger } from "../../control/log.ts";
import type { Capabilities, Offer } from "../../protocol/types.ts";

const log = makeLogger("test", "error");
const caps: Capabilities = { allocationVersion: 1, os: "linux", arch: "x64", hostname: "fake", ramMiB: 8192, ramReserveMiB: 4096, cpuCores: 4, gpus: [], diskFreeMiB: 1024, privateIps: [], measuredAt: new Date().toISOString() };
const offer: Offer = { enabled: false, roles: { worker: false, coordinator: false, replica: false }, gpu: [], ramMiB: 0, cpuCores: 0, diskMiB: 0, modelsDir: "" };
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const clients: AgentClient[] = [];

/** A control stand-in: handshake, then pings every `pingMs` (0 = silent forever). */
function fakeControl(pingMs: number): { url: string; connections: () => number } {
  let connections = 0;
  const server = Bun.serve<{ timer?: ReturnType<typeof setInterval> }>({
    hostname: "127.0.0.1", port: 0,
    fetch(req, srv) { return srv.upgrade(req, { data: {} }) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(ws) {
        connections++;
        ws.send(JSON.stringify({ t: "challenge", nonce: `n${connections}` }));
      },
      message(ws, raw) {
        const m = JSON.parse(String(raw)) as { t: string; nodeId?: string };
        if (m.t === "auth") {
          ws.send(JSON.stringify({ t: "welcome", nodeId: m.nodeId }));
          if (pingMs > 0) ws.data.timer = setInterval(() => ws.send(JSON.stringify({ t: "ping", ts: new Date().toISOString() })), pingMs);
        }
      },
      close(ws) { if (ws.data.timer) clearInterval(ws.data.timer); },
    },
  });
  servers.push(server);
  return { url: `ws://127.0.0.1:${server.port}/agent`, connections: () => connections };
}

async function client(url: string, staleMs: number): Promise<AgentClient> {
  const id = await loadIdentity(agentPaths(mkdtempSync(join(tmpdir(), "swarmlet-link-"))));
  const c = new AgentClient(url, id, {
    caps: () => caps, offer: () => offer, models: () => [], metrics: () => ({ ts: new Date().toISOString(), cpuPct: 0 }),
    assignments: () => [], onAssign: () => {}, allowedPorts: () => new Set(),
  }, log, { staleMs });
  clients.push(c);
  c.start();
  await c.whenConnected();
  return c;
}

afterAll(() => { for (const c of clients) c.stop(); for (const s of servers) s.stop(true); });

describe("agent control link watchdog", () => {
  test("a link that goes silent is dropped and dialed again; the discarded socket does not double-connect", async () => {
    const ctl = fakeControl(0);
    const c = await client(ctl.url, 400);
    expect(ctl.connections()).toBe(1);
    // silence longer than staleMs: the heartbeat tick (2 s) notices and reconnects
    const deadline = Date.now() + 8_000;
    while (ctl.connections() < 2 && Date.now() < deadline) await Bun.sleep(50);
    expect(ctl.connections()).toBe(2);
    await c.whenConnected();
    expect(c.connected).toBe(true);
    // the old socket's close event must not schedule a third dial; a new silence period reconnects once more
    await Bun.sleep(2_600);
    expect(ctl.connections()).toBeLessThanOrEqual(3);
  }, 20_000);

  test("a link that keeps receiving pings is kept", async () => {
    const ctl = fakeControl(100);
    const c = await client(ctl.url, 400);
    await Bun.sleep(3_000);
    expect(ctl.connections()).toBe(1);
    expect(c.connected).toBe(true);
  }, 10_000);
});
