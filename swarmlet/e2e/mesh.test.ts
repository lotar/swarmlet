// End-to-end on one machine, no real model: a control plane plus two full node agents (real
// identity, probes, data listener, dialer, assignment runner, local API) with the fake engine in
// e2e/fake-engine. Exercises enrollment -> offers -> split deployment (planner, worker + coordinator
// assignments, direct TLS path with pinning, relay fallback) -> OpenAI request through the router
// -> stop -> cleanup; plus a replica deployment and the external (health-only) kind.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** argv the GPU-less node's fake llama-server was started with (written by the wrapper's FAKE_ARGV_FILE). */
let cpuOnlyArgvFile = "";

async function makeNode(name: string, roles: Offer["roles"], withModel: boolean, uiPort: number, dataPort: number, opts: { cpuOnly?: boolean } = {}): Promise<AgentRuntime> {
  const home = mkdtempSync(join(tmpdir(), `swarmlet-e2e-${name}-`));
  const models = join(home, "models"); mkdirSync(models, { recursive: true });
  if (withModel) { writeFileSync(join(models, "Qwen3.5-2B-Q8_0.gguf"), "not a real model"); }
  let engine = FAKE;
  if (opts.cpuOnly) {
    // A machine without a GPU: wrappers run the same fake engine with no GPU listed and record llama-server's argv.
    engine = join(home, "engine"); mkdirSync(engine);
    cpuOnlyArgvFile = join(home, "llama-server.argv");
    for (const bin of ["llama-server", "ggml-rpc-server"]) {
      writeFileSync(join(engine, bin), `#!/bin/sh\nFAKE_NO_GPU=1 FAKE_ARGV_FILE=${JSON.stringify(cpuOnlyArgvFile)} exec ${JSON.stringify(join(FAKE, bin))} "$@"\n`);
      chmodSync(join(engine, bin), 0o755);
    }
  }
  process.env.SWARMLET_ENGINE = engine;
  const rt = new AgentRuntime(home);
  process.env.SWARMLET_ENGINE = FAKE;
  rt.cfg.uiPort = uiPort; rt.cfg.dataPort = dataPort; rt.cfg.enginePath = engine;
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

  test("saved layer layout persists across control restart and applies through the real agent wire", async () => {
    if (!hasGpu()) throw new Error("distribution acceptance requires the available test GPU");
    const spec = { name: "saved-layout", profile: "qwen35-2b-q8", kind: "split", coordinatorNodeId: alpha.id.nodeId, workerNodeIds: [beta.id.nodeId], workerLayers: [2], ctx: 1024, parallel: 1, chain: 0 };
    const { id } = await (await api('/api/deployments', { method: 'POST', body: JSON.stringify(spec) })).json() as {id:string};
    await api(`/api/deployments/${id}/start`, {method:'POST'});
    expect((await waitState(id,['ready','failed'],15000)).state).toBe('ready');
    const saved={coordinatorNodeId:alpha.id.nodeId,workerNodeIds:[beta.id.nodeId],workerLayers:[3]};
    expect((await fetch(`${base}/api/deployments/${id}/distribution`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(saved)})).status).toBe(401);
    expect((await api(`/api/deployments/${id}/distribution`,{method:'PUT',body:JSON.stringify(saved)})).status).toBe(200);
    let current=await (await api(`/api/deployments/${id}`)).json() as Deployment;
    expect(current.spec.workerLayers).toEqual([2]);expect(current.savedDistribution).toEqual(saved);
    await assertRouted(id);
    await restartControl();
    expect((await waitState(id,['ready'],25000)).state).toBe('ready');
    current=await (await api(`/api/deployments/${id}`)).json() as Deployment;
    expect(current.savedDistribution).toEqual(saved);expect(current.spec.workerLayers).toEqual([2]);
    expect((await api(`/api/deployments/${id}/distribution`,{method:'PUT',body:JSON.stringify({...saved,workerLayers:[99]})})).status).toBe(400);
    expect((await api(`/api/deployments/${id}/distribution/apply`,{method:'POST'})).status).toBe(202);
    current=await waitState(id,['ready','failed'],15000);
    expect(current.state).toBe('ready');expect(current.plan!.tensorSplit).toEqual([3,21]);expect(current.plan!.engineTensorSplit).toEqual([3,22]);
    await assertRouted(id);
    await api(`/api/deployments/${id}/stop`,{method:'POST'});await waitState(id,['stopped'],10000);
  },60000);

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

  // Owner rule: CPU-only compute is allowed only on a machine without a usable GPU.
  test("a node with a usable GPU refuses a CPU-only offer through its local API", async () => {
    if (!hasGpu()) return;
    const before = structuredClone(alpha.cfg.offer);
    const r = await fetch("http://127.0.0.1:47810/api/offer", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...before, gpu: [] }) });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { errors: string[] };
    expect(body.errors.join("\n")).toMatch(/CPU-only offers are allowed only on machines without a usable GPU/);
    expect(alpha.cfg.offer).toEqual(before);
    expect(ctl.reg.getNode(alpha.id.nodeId)?.offer?.gpu).toEqual(before.gpu);
  });

  test("a node without a GPU serves a CPU-only replica: offer accepted, planned on CPU, engine started with --device none -ngl 0", async () => {
    // 4784x: the fixtures in e2e/ listen on 47820 and 4783x, so a fixture left running cannot take these ports
    const gamma = await makeNode("gamma", { worker: false, coordinator: false, replica: true }, true, 47840, 47841, { cpuOnly: true });
    // capabilities and the offer follow authentication on the wire
    await waitUntil(() => { const n = ctl.reg.getNode(gamma.id.nodeId); return !!n?.caps && !!n?.offer; });
    const node = ctl.reg.getNode(gamma.id.nodeId)!;
    expect(node.caps!.gpus).toEqual([]);
    expect(node.offer!.enabled).toBe(true);
    expect(node.offer!.gpu).toEqual([]);
    const spec = { name: "e2e-cpu-replica", profile: "qwen35-2b-q8", kind: "replica", replicaNodeId: gamma.id.nodeId, ctx: 2048, parallel: 1 };
    const preview = (await (await api("/api/deployments/plan-preview", { method: "POST", body: JSON.stringify(spec) })).json()) as { coordinatorDevice?: string; error?: string };
    expect(preview.error).toBeUndefined();
    expect(preview.coordinatorDevice).toBe("CPU");
    const { id } = (await (await api("/api/deployments", { method: "POST", body: JSON.stringify(spec) })).json()) as { id: string };
    expect((await api(`/api/deployments/${id}/start`, { method: "POST" })).status).toBe(200);
    const dep = await waitState(id, ["ready", "failed"], 60_000);
    expect(dep.error).toBeUndefined();
    expect(dep.state).toBe("ready");
    expect(dep.plan!.coordinatorDevice).toBe("CPU");
    // The fake engine exits on "--device CPU" like the real one, so reaching ready already proves the recipe;
    // the recorded argv pins the exact flags.
    const argv = readFileSync(cpuOnlyArgvFile, "utf8").split("\n");
    expect(argv[argv.indexOf("--device") + 1]).toBe("none");
    expect(argv[argv.indexOf("-ngl") + 1]).toBe("0");
    const r = await api("/v1/chat/completions", { method: "POST", headers: { "x-swarmlet-deployment": id }, body: JSON.stringify({ model: "qwen3.5-2b", messages: [{ role: "user", content: "cpu" }] }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-swarmlet-node")).toBe(gamma.id.nodeId);
    expect(((await r.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toBe("echo:cpu rpc=none");
    await api(`/api/deployments/${id}/stop`, { method: "POST" });
    await waitState(id, ["stopped"], 30_000);
    await waitUntil(() => gamma.runner.snapshot().length === 0);
  });

  test("fleet HTTP apply runs two budgeted replicas through real node agents", async () => {
    const original = structuredClone(alpha.cfg.offer), ids: string[] = [];
    try {
      alpha.cfg.offer = { ...original, ramMiB: 8192, gpu: original.gpu.map(g => ({ ...g, memMiB: 8192 })) };
      alpha.client!.sendOffer();
      await waitUntil(() => ctl.reg.getNode(alpha.id.nodeId)?.offer?.ramMiB === 8192);
      expect(ctl.reg.getNode(alpha.id.nodeId)!.caps!.allocationVersion).toBe(1);
      for (const name of ['fleet-one', 'fleet-two']) {
        const response = await api('/api/deployments', { method: 'POST', body: JSON.stringify({ name, profile: 'qwen35-2b-q8', kind: 'replica', ctx: 2048 }) });
        ids.push((await response.json() as { id: string }).id);
      }
      const response = await api('/api/fleet/preview', { method: 'POST', body: JSON.stringify({ items: ids.map(deploymentId => ({ deploymentId, mode: 'balanced' })), poolNodeIds: [alpha.id.nodeId] }) });
      expect(response.status).toBe(200);
      const run = await response.json() as import('../control/fleet.ts').FleetRun;
      expect(run.canApply, JSON.stringify({ errors: run.entries.map(e => e.error), warnings: run.warnings })).toBe(true);
      expect((await api('/api/fleet/' + run.id + '/apply', { method: 'POST' })).status).toBe(202);
      await waitUntil(() => ctl.reg.fleetRun(run.id)?.status !== 'applying', 60000);
      expect(ctl.reg.fleetRun(run.id)!.status).toBe('succeeded');
      for (const id of ids) {
        expect(ctl.reg.getDeployment(id)!.spec.allocations![0]!.cpuCores).toBe(1);
        await assertRouted(id, 'qwen3.5-2b', 'echo:recovery rpc=none');
      }
    } finally {
      for (const id of ids) await api('/api/deployments/' + id + '/stop', { method: 'POST' });
      alpha.cfg.offer = original; alpha.client!.sendOffer();
      await waitUntil(() => ctl.reg.getNode(alpha.id.nodeId)?.offer?.ramMiB === original.ramMiB);
    }
  }, 90000);

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
