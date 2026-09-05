// End-to-end on one machine, no real model: a control plane plus two full node agents (real
// identity, probes, data listener, dialer, assignment runner, local API) with the fake engine in
// e2e/fake-engine. Exercises enrollment -> offers -> split deployment (planner, worker + coordinator
// assignments, direct TLS path with pinning, relay fallback) -> OpenAI request through the router
// -> stop -> cleanup; plus a replica deployment and the external (health-only) kind.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadControlConfig, type ControlConfig } from "../control/config.ts";
import { bootControl } from "../control/server.ts";
import { AgentRuntime } from "../node-agent/main.ts";
import { saveNodeConfig } from "../node-agent/config.ts";
import type { Deployment, Offer } from "../protocol/types.ts";

const FAKE = new URL("./fake-engine/", import.meta.url).pathname;
process.env.SWARMLET_SERVER_PORT_BASE = "8300"; // stay clear of a live control plane's 8100+ on this machine
let cfg: ControlConfig;
let ctl: Awaited<ReturnType<typeof bootControl>>;
let base: string;
const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${cfg.adminToken}`, "content-type": "application/json", ...(init.headers ?? {}) } });
const agents: AgentRuntime[] = [];
let sweeper: ReturnType<typeof setInterval>;
function startSweeper(): void {
  sweeper = setInterval(() => {
    ctl.channel.sweep();
    void ctl.deployments.reconcile();
  }, 100);
}
async function waitUntil(check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not converge");
    await Bun.sleep(100);
  }
}
async function restartControl(): Promise<void> {
  const port = ctl.server.port!;
  clearInterval(sweeper);
  ctl.deployments.dispose();
  ctl.channel.shuttingDown = true;
  ctl.tunnels.close();
  ctl.server.stop(true);
  // Let websocket close callbacks finish before closing this connection to the persisted DB.
  await Bun.sleep(100);
  ctl.reg.close();
  cfg.port = port;
  ctl = await bootControl(cfg);
  startSweeper();
  await waitUntil(() => agents.every((a) => ctl.channel.isOnline(a.id.nodeId)));
}
async function assertRouted(id: string, model = "qwen3.5-2b", expected = "echo:recovery rpc=ok"): Promise<void> {
  const response = await api("/v1/chat/completions", {
    method: "POST", headers: { "x-swarmlet-deployment": id },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "recovery" }] }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-swarmlet-deployment")).toBe(id);
  const body = await response.json() as { choices: Array<{ message: { content: string } }> };
  expect(body.choices[0]?.message.content).toBe(expected);
}

async function makeNode(name: string, roles: Offer["roles"], withModel: boolean, uiPort: number, dataPort: number): Promise<AgentRuntime> {
  const home = mkdtempSync(join(tmpdir(), `swarmlet-e2e-${name}-`));
  const models = join(home, "models"); mkdirSync(models, { recursive: true });
  if (withModel) { writeFileSync(join(models, "Qwen3.5-2B-Q8_0.gguf"), "not a real model"); }
  process.env.SWARMLET_ENGINE = FAKE;
  const rt = new AgentRuntime(home);
  rt.cfg.uiPort = uiPort; rt.cfg.dataPort = dataPort; rt.cfg.enginePath = FAKE;
  saveNodeConfig(rt.paths, rt.cfg);
  await rt.start();
  const gpu = rt.caps?.gpus[0];
  rt.cfg.offer = { enabled: true, roles, gpu: gpu ? [{ id: gpu.id, memMiB: Math.min(4096, gpu.totalMiB) }] : [], ramMiB: 4096, cpuCores: 2, diskMiB: 1024, modelsDir: models };
  saveNodeConfig(rt.paths, rt.cfg);
  rt.models = await (await import("../node-agent/probe/index.ts")).listModels(models);
  const { code } = (await (await api("/api/join-codes", { method: "POST" })).json()) as { code: string };
  await rt.join(base, code);
  await rt.client!.whenConnected();
  agents.push(rt);
  return rt;
}

async function waitState(id: string, states: string[], timeoutMs: number): Promise<Deployment> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = (await (await api(`/api/deployments/${id}`)).json()) as Deployment;
    if (states.includes(d.state)) return d;
    if (Date.now() > deadline) throw new Error(`deployment ${id} stuck in ${d.state}: ${d.error ?? ""}`);
    await Bun.sleep(200);
  }
}

beforeAll(async () => {
  chmodSync(join(FAKE, "ggml-rpc-server"), 0o755); chmodSync(join(FAKE, "llama-server"), 0o755);
  cfg = loadControlConfig({ dataDir: mkdtempSync(join(tmpdir(), "swarmlet-e2e-control-")), port: 0, host: "127.0.0.1", logLevel: "warn" });
  ctl = await bootControl(cfg);
  base = `http://127.0.0.1:${ctl.server.port}`;
  cfg.publicUrl = base;
  startSweeper();
});

afterAll(async () => {
  clearInterval(sweeper);
  ctl.deployments.dispose();
  ctl.channel.shuttingDown = true;
  for (const a of agents) { await a.runner.stopAll(); a.client?.stop(); }
  ctl.server.stop(true);
});

describe("mesh e2e (fake engine)", () => {
  let alpha: AgentRuntime, beta: AgentRuntime;
  const hasGpu = () => (alpha.caps?.gpus.length ?? 0) > 0;

  test("two agents enroll with roles and models", async () => {
    alpha = await makeNode("alpha", { worker: true, coordinator: true, replica: true }, true, 47810, 47811);
    beta = await makeNode("beta", { worker: true, coordinator: false, replica: false }, false, 47820, 47821);
    const nodes = ((await (await api("/api/nodes")).json()) as { nodes: Array<{ id: string; online: boolean; models: unknown[]; offer: Offer }> }).nodes;
    expect(nodes.filter((n) => n.online).length).toBe(2);
    expect(nodes.find((n) => n.id === alpha.id.nodeId)?.models.length).toBe(1);
    const st = (await (await fetch("http://127.0.0.1:47810/api/status")).json()) as { connected: boolean; nodeId: string };
    expect(st.connected).toBe(true);
    expect(st.nodeId).toBe(alpha.id.nodeId);
  });

  test("split deployment: plan, workers, coordinator, route a request, stop", async () => {
    if (!hasGpu()) { console.warn("no GPU on this machine: split test skipped"); return; }
    const spec = { name: "e2e-split", profile: "qwen35-2b-q8", kind: "split", coordinatorNodeId: alpha.id.nodeId, workerNodeIds: [beta.id.nodeId], ctx: 2048, parallel: 1, chain: 0 };
    const preview = await (await api("/api/deployments/plan-preview", { method: "POST", body: JSON.stringify(spec) })).json() as { tensorSplit?: number[]; error?: string };
    expect(preview.error).toBeUndefined();
    expect(preview.tensorSplit?.length).toBe(2);
    const { id } = (await (await api("/api/deployments", { method: "POST", body: JSON.stringify(spec) })).json()) as { id: string };
    expect((await api(`/api/deployments/${id}/start`, { method: "POST" })).status).toBe(200);
    const dep = await waitState(id, ["ready", "failed"], 60_000);
    expect(dep.error).toBeUndefined();
    expect(dep.state).toBe("ready");
    expect(dep.endpoint?.modelName).toBe("qwen3.5-2b");
    // the fake coordinator round-tripped a line through the dialed rpc port to the fake worker
    const r = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "qwen3.5-2b", messages: [{ role: "user", content: "hi" }] }) });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { choices: Array<{ message: { content: string } }> };
    expect(out.choices[0]?.message.content).toBe("echo:hi rpc=ok");
    expect(r.headers.get("x-swarmlet-deployment")).toBe(id);
    // streaming passthrough
    const s = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "qwen3.5-2b", stream: true, messages: [{ role: "user", content: "yo" }] }) });
    const text = await s.text();
    expect(text).toContain("data: [DONE]");
    // Participants consume the same split model through their own localhost API.
    for (const [port, route] of [[47810, "local"], [47820, "mesh"]] as const) {
      const catalog = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json() as { data: Array<{ id: string; route: string; created: number }> };
      expect(catalog.data.find((m) => m.id === "qwen3.5-2b")?.route).toBe(route);
      expect(catalog.data.every((m) => Number.isInteger(m.created) && m.created > 0)).toBe(true);
      const reply = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen3.5-2b", stream: true, messages: [{ role: "user", content: "participant" }] }) });
      expect(reply.status).toBe(200);
      expect(reply.headers.get("x-swarmlet-route")).toBe(route);
      expect(await reply.text()).toContain("data: [DONE]");
    }
    // the coordinator reports which path it used for the worker
    const asg = ((await (await api(`/api/deployments/${id}`)).json()) as { assignments: Array<{ body: { kind: string }; detail: string | null }> }).assignments;
    const coord = asg.find((a) => a.body.kind === "coordinator");
    expect(coord?.detail).toMatch(/rpc0=(direct|relay)/);
    const models = (await (await api("/v1/models")).json()) as { data: Array<{ id: string }> };
    expect(models.data.map((m) => m.id)).toContain("qwen3.5-2b");
    expect((await api(`/api/deployments/${id}/stop`, { method: "POST" })).status).toBe(200);
    const stopped = await waitState(id, ["stopped"], 30_000);
    expect(stopped.state).toBe("stopped");
    expect(alpha.runner.snapshot().length).toBe(0);
    expect(beta.runner.snapshot().length).toBe(0);
    const r404 = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "qwen3.5-2b", messages: [] }) });
    expect(r404.status).toBe(404);
  });

  test("replica deployment on the node holding the model", async () => {
    const spec = { name: "e2e-replica", profile: "qwen35-2b-q8", kind: "replica", replicaNodeId: alpha.id.nodeId, ctx: 2048, parallel: 2 };
    const { id } = (await (await api("/api/deployments", { method: "POST", body: JSON.stringify(spec) })).json()) as { id: string; error?: string };
    expect(id).toBeDefined();
    await api(`/api/deployments/${id}/start`, { method: "POST" });
    const dep = await waitState(id, ["ready", "failed"], 60_000);
    expect(dep.state).toBe("ready");
    const r = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "qwen3.5-2b", messages: [{ role: "user", content: "rep" }] }) });
    expect(((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("echo:rep rpc=none");
    await api(`/api/deployments/${id}/stop`, { method: "POST" });
    await waitState(id, ["stopped"], 30_000);
  });

  test("external deployment is health-checked and routed", async () => {
    // an "external" server = a fake llama-server we start by hand on alpha's machine
    const proc = Bun.spawn([join(FAKE, "llama-server"), "--port", "8199", "--alias", "ext"], { env: { ...process.env, FAKE_LOAD_MS: "10" }, stdout: "ignore", stderr: "ignore" });
    try {
    await Bun.sleep(600);
    const spec = { name: "flashnext-prod", profile: "external", kind: "external", external: { nodeId: alpha.id.nodeId, url: "http://127.0.0.1:8199", healthPath: "/health", modelName: "ext-model" } };
    const { id } = (await (await api("/api/deployments", { method: "POST", body: JSON.stringify(spec) })).json()) as { id: string };
    await api(`/api/deployments/${id}/start`, { method: "POST" });
    const dep = await waitState(id, ["ready", "failed"], 30_000);
    expect(dep.state).toBe("ready");
    const r = await api("/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "ext-model", messages: [{ role: "user", content: "x" }] }) });
    expect(r.status).toBe(200);
    await restartControl();
    await waitState(id, ["ready"], 30_000);
    await assertRouted(id, "ext-model", "echo:recovery rpc=none");
    expect(alpha.runner.snapshot().filter((a) => a.deploymentId === id)).toHaveLength(1);
    alpha.client!.stop();
    await waitUntil(() => !ctl.channel.isOnline(alpha.id.nodeId));
    alpha.connect();
    await alpha.client!.whenConnected();
    await waitState(id, ["ready"], 30_000);
    expect(alpha.runner.snapshot().filter((a) => a.deploymentId === id)).toHaveLength(1);
    await api(`/api/deployments/${id}/stop`, { method: "POST" });
    await waitState(id, ["stopped"], 30_000);
    } finally { proc.kill(); }
  }, 120_000);

  test("relay mesh recovers after actual disconnect and persisted control restart; offline stop stays stopped", async () => {
    if (!hasGpu()) return;
    const spec = { name: "e2e-recovery", profile: "qwen35-2b-q8", kind: "split", coordinatorNodeId: alpha.id.nodeId, workerNodeIds: [beta.id.nodeId], ctx: 2048, transport: "relay" };
    const { id } = await (await api("/api/deployments", { method: "POST", body: JSON.stringify(spec) })).json() as { id: string };
    await api(`/api/deployments/${id}/start`, { method: "POST" });
    await waitState(id, ["ready"], 60_000);
    await assertRouted(id);
    const originalIds = agents.flatMap((a) => a.runner.snapshot().filter((x) => x.deploymentId === id).map((x) => x.id));
    beta.client!.stop(); // real WebSocket loss, leaving the offline worker alive
    await waitUntil(() => !ctl.channel.isOnline(beta.id.nodeId));
    await waitState(id, ["failed"], 30_000);
    expect(beta.runner.snapshot().some((a) => a.deploymentId === id)).toBe(true);
    beta.connect();
    await beta.client!.whenConnected();
    await waitState(id, ["ready"], 60_000);
    await assertRouted(id);
    const recovered = agents.flatMap((a) => a.runner.snapshot().filter((x) => x.deploymentId === id));
    expect(recovered).toHaveLength(2);
    expect(recovered.every((a) => !originalIds.includes(a.id))).toBe(true);

    const beforeRestart = recovered.map((a) => a.id);
    await restartControl();
    await waitState(id, ["ready"], 60_000);
    await assertRouted(id);
    const restarted = agents.flatMap((a) => a.runner.snapshot().filter((x) => x.deploymentId === id));
    expect(restarted).toHaveLength(2);
    expect(restarted.every((a) => !beforeRestart.includes(a.id))).toBe(true);

    beta.client!.stop();
    await waitUntil(() => !ctl.channel.isOnline(beta.id.nodeId));
    await waitState(id, ["failed"], 30_000);
    const stopResponse = api(`/api/deployments/${id}/stop`, { method: "POST" });
    await waitUntil(() => !ctl.reg.deploymentIntent(id).running);
    beta.connect();
    await beta.client!.whenConnected();
    expect((await stopResponse).status).toBe(200);
    await waitState(id, ["stopped"], 30_000);
    await waitUntil(() => agents.every((a) => !a.runner.snapshot().some((x) => x.deploymentId === id)));
    await restartControl();
    await Bun.sleep(6000); // exceed first recovery backoff
    expect((await waitState(id, ["stopped"], 1000)).state).toBe("stopped");
    expect(agents.flatMap((a) => a.runner.snapshot()).filter((a) => a.deploymentId === id)).toHaveLength(0);
    expect(ctl.reg.deploymentIntent(id).running).toBe(false);
  }, 240_000);

  test("worker crash fails the deployment and cleans up", async () => {
    if (!hasGpu()) return;
    const spec = { name: "e2e-crash", profile: "qwen35-2b-q8", kind: "split", coordinatorNodeId: alpha.id.nodeId, workerNodeIds: [beta.id.nodeId], ctx: 2048 };
    const { id } = (await (await api("/api/deployments", { method: "POST", body: JSON.stringify(spec) })).json()) as { id: string };
    await api(`/api/deployments/${id}/start`, { method: "POST" });
    await waitState(id, ["ready"], 60_000);
    const pid = beta.runner.snapshot()[0]?.pid;
    expect(pid).toBeDefined();
    process.kill(pid!, "SIGKILL");
    const dep = await waitState(id, ["failed"], 30_000);
    expect(dep.error).toMatch(/failed/);
    await api(`/api/deployments/${id}/stop`, { method: "POST" });
    for (let i = 0; i < 100 && alpha.runner.snapshot().length; i++) await Bun.sleep(100);
    expect(alpha.runner.snapshot().length).toBe(0);
  });
});
