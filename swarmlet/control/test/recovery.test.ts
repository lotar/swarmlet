import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Registry } from "../registry.ts";
import { DeploymentManager } from "../deployments.ts";
import { loadProfiles } from "../planner.ts";
import { AgentChannel, type ConnData } from "../channel.ts";
import type { Assignment, AssignmentState, ControlToAgent, DeploymentSpec } from "../../protocol/types.ts";

const fixtures: Array<{ reg: Registry; manager: DeploymentManager }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.manager.dispose(); f.reg.close(); } });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const split: DeploymentSpec = { name: "mesh", kind: "split", profile: "qwen35-2b-q8", coordinatorNodeId: "mac", workerNodeIds: ["l1", "l2"], transport: "relay", ctx: 1024, parallel: 1, chain: 0 };

function rig(path = ":memory:") {
  const reg = new Registry(path);
  const online = new Set(["mac", "l1", "l2"]);
  const sent: Array<{ node: string; a: Assignment }> = [];
  let ackStops = true, ackStarts = true;
  let manager: DeploymentManager;
  const report = (node: string, id: string, state: AssignmentState) => { reg.setAssignmentState(id, state); manager.onAssignmentState(node, id, state); };
  const send = (node: string, m: ControlToAgent) => {
    if (!online.has(node)) return false;
    if (m.t !== "assign") return true;
    const a = m.assignment;
    sent.push({ node, a });
    if (a.kind === "stop" && ackStops) queueMicrotask(() => report(node, a.id, "stopped"));
    if (a.kind !== "stop" && ackStarts) queueMicrotask(() => report(node, a.id, a.kind === "worker" ? "listening" : "ready"));
    return true;
  };
  const channel = { isOnline: (n: string) => online.has(n), send,
    assign: (node: string, a: Assignment) => { reg.putAssignment(a, node); return send(node, { t: "assign", assignment: a }); } } as unknown as AgentChannel;
  manager = new DeploymentManager({ reg, channel, profiles: loadProfiles(), log: quiet, recoveryDelayMs: 0, stopTimeoutMs: 15 });
  fixtures.push({ reg, manager });
  for (const id of online) {
    const mac = id === "mac", os = mac ? "darwin" : "linux", device = mac ? "metal:0" : "cuda:0";
    reg.upsertNode({ id, pubJwk: {}, certFp: `fp-${id}`, hostname: id, os, arch: mac ? "arm64" : "x64", caps: {
      hostname: id, os, arch: mac ? "arm64" : "x64", ramMiB: mac ? 131072 : 16384, ramReserveMiB: 4096, cpuCores: 12,
      gpus: [{ id: device, name: device, backend: mac ? "metal" : "cuda", engineName: mac ? "MTL0" : "CUDA0", totalMiB: mac ? 110000 : 4096 }],
      diskFreeMiB: 100000, privateIps: ["127.0.0.1"], measuredAt: new Date().toISOString(),
    } });
    reg.setOffer(id, { enabled: true, roles: { worker: !mac, coordinator: mac, replica: mac }, gpu: [{ id: device, memMiB: mac ? 100000 : 3600 }], ramMiB: mac ? 110000 : 8192, cpuCores: 10, diskMiB: 100000, modelsDir: "/models" });
    reg.setOnline(id, true);
    if (mac) reg.setModels(id, [{ name: "Qwen3.5-2B-Q8_0.gguf", path: "/models/Qwen3.5-2B-Q8_0.gguf", sizeBytes: 2_200_000_000, kind: "gguf" }]);
  }
  return { reg, manager, online, sent, report, setStops: (v: boolean) => { ackStops = v; }, setStarts: (v: boolean) => { ackStarts = v; } };
}

async function settle() { await Bun.sleep(25); }

test("offline worker is not falsely stopped; reconnect cleans it before fresh three-node placement", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  const old = f.reg.listAssignments(id), l1 = old.find((a) => a.nodeId === "l1")!;
  f.online.delete("l1"); f.manager.onOffline("l1");
  expect(f.reg.getDeployment(id)?.state).toBe("failed");
  expect(f.manager.routing()).toEqual([]);
  await settle();
  expect(f.reg.getAssignment(l1.id)?.state).toBe("listening");
  await f.manager.reconcile();
  expect(f.reg.deploymentIntent(id).attempts).toBe(0);
  f.online.add("l1"); f.manager.onHello("l1", [{ id: l1.id, state: "listening" }]); await settle();
  expect(f.reg.getAssignment(l1.id)?.state).toBe("stopped");
  const stoppedAt = f.sent.findIndex((s) => s.a.id === l1.id && s.a.kind === "stop");
  await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  const live = f.reg.listAssignments(id).filter((a) => a.state !== "stopped");
  expect(live.map((a) => a.nodeId).sort()).toEqual(["l1", "l2", "mac"]);
  expect(live.every((a) => !old.some((o) => o.id === a.id))).toBe(true);
  expect(f.sent.findIndex((s) => s.a.id === live.find((a) => a.nodeId === "l1")!.id)).toBeGreaterThan(stoppedAt);
  f.report("l1", l1.id, "failed"); await settle();
  expect(f.reg.getDeployment(id)?.state).toBe("ready"); // late old-generation failure cannot poison replacement
});

test("stop while loading cancels the start and never resurrects the route", async () => {
  const f = rig(); const { id } = await f.manager.create(split); f.setStarts(false);
  const start = f.manager.start(id).catch((e: Error) => e);
  await Bun.sleep(1);
  await f.manager.stop(id); expect(String(await start)).toContain("cancelled");
  for (const row of f.reg.listAssignments(id)) f.report(row.nodeId, row.id, "ready");
  await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("stopped");
  expect(f.reg.deploymentIntent(id).running).toBe(false);
  expect(f.sent.filter((s) => s.a.kind === "coordinator")).toHaveLength(0);
  expect(f.manager.routing()).toEqual([]);
});

test("stop timeout retains ownership and delete refuses to discard an unacknowledged engine", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id); f.setStops(false);
  await expect(f.manager.stop(id)).rejects.toThrow(/cleanup pending acknowledgement/);
  expect(f.reg.listAssignments(id).every((a) => a.state !== "stopped")).toBe(true);
  expect(f.reg.getDeployment(id)?.state).toBe("draining");
  await expect(f.manager.remove(id)).rejects.toThrow(/stop the deployment first/);
  expect(f.reg.getDeployment(id)).not.toBeNull();
  f.setStops(true); await f.manager.stop(id); await f.manager.remove(id);
  expect(f.reg.getDeployment(id)).toBeNull();
});

test("agent restart absence proves cleanup and permits recovery", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  f.manager.onHello("l1", []); await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(f.reg.listAssignments(id).filter((a) => a.state !== "stopped")).toHaveLength(3);
});

test("clean agent shutdown reporting stopped still fails and recovers a desired-running mesh", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  const row = f.reg.listAssignments(id).find((a) => a.nodeId === "l1")!;
  f.report("l1", row.id, "stopped"); expect(f.reg.getDeployment(id)?.state).toBe("failed");
  await settle(); f.manager.onHello("l1", []); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
});

test("offline manual stop completes after reconnect acknowledgement and remains deletable", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  const l1 = f.reg.listAssignments(id).find((a) => a.nodeId === "l1")!;
  f.online.delete("l1"); await expect(f.manager.stop(id)).rejects.toThrow(/cleanup pending/);
  expect(f.reg.getDeployment(id)?.state).toBe("draining");
  f.online.add("l1"); f.manager.onHello("l1", [{ id: l1.id, state: "listening" }]); await settle();
  await f.manager.reconcile(); expect(f.reg.getDeployment(id)?.state).toBe("stopped");
  await f.manager.remove(id); expect(f.reg.getDeployment(id)).toBeNull();
});

test("authenticated agents cannot mutate another node's assignment via state reports or hello", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  const l1 = f.reg.listAssignments(id).find((a) => a.nodeId === "l1")!;
  let calls = 0;
  const channel = new AgentChannel(f.reg, quiet, { onAssignmentState: () => { calls++; } });
  const ws = { data: { ...channel.newConnData(), authed: true, nodeId: "l2" }, send() {}, close() {} } as unknown as ServerWebSocket<ConnData>;
  await channel.message(ws, JSON.stringify({ t: "assignment", id: l1.id, state: "stopped" }));
  expect(calls).toBe(0); expect(f.reg.getAssignment(l1.id)?.state).toBe("listening");
  const l2 = f.reg.getNode("l2")!;
  await channel.message(ws, JSON.stringify({ t: "hello", proto: 1, agentVersion: "test", caps: l2.caps, offer: l2.offer, models: [], assignments: [{ id: l1.id, state: "failed" }] }));
  expect(f.reg.getAssignment(l1.id)?.state).toBe("listening");
});

test("control restart preserves intent, withdraws stale relay route, and replaces all old assignments", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  const oldIds = f.reg.listAssignments(id).map((a) => a.id);
  f.manager.restore(); expect(f.manager.routing()).toEqual([]);
  await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(f.reg.listAssignments(id).filter((a) => oldIds.includes(a.id)).every((a) => a.state === "stopped")).toBe(true);
});

test("manual stop persists across restart and subsequent reconnect", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id); await f.manager.stop(id);
  const starts = f.sent.filter((s) => s.a.kind !== "stop").length;
  f.manager.restore(); f.manager.onHello("l1", []); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("stopped");
  expect(f.sent.filter((s) => s.a.kind !== "stop")).toHaveLength(starts);
});

test("crash after durable Stop intent but before state write cannot resurrect a persisted ready route", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  f.reg.setDeploymentIntent(id, { running: false }); f.manager.restore();
  expect(f.manager.routing()).toEqual([]); expect(f.reg.getDeployment(id)?.state).toBe("draining");
  for (const node of f.online) f.manager.onHello(node, f.reg.listAssignments(id).filter((a) => a.nodeId === node).map((a) => ({ id: a.id, state: a.state as AssignmentState })));
  await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("stopped");
});

test("recovery attempts are bounded and explicit Start resets exhausted retry budget", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  f.reg.setModels("mac", []); f.manager.restore();
  for (let n = 0; n < 8; n++) await f.manager.reconcile();
  expect(f.reg.deploymentIntent(id).attempts).toBe(5);
  expect(f.reg.getDeployment(id)?.state).toBe("failed");
  expect(f.reg.listEvents().some((e) => e.message.includes("explicit Start required"))).toBe(true);
  await expect(f.manager.start(id)).rejects.toThrow(/no plan/);
  expect(f.reg.deploymentIntent(id).attempts).toBe(0);
});

test("automatic placement that failed before producing any plan recovers when node offers return", async () => {
  const f = rig(); const { id } = await f.manager.create({ ...split, coordinatorNodeId: undefined, workerNodeIds: undefined });
  f.online.clear(); await expect(f.manager.start(id)).rejects.toThrow(/no plan/);
  expect(f.reg.getDeployment(id)?.plan).toBeUndefined();
  await f.manager.reconcile(); expect(f.reg.deploymentIntent(id).attempts).toBe(0);
  for (const node of ["mac", "l1", "l2"]) f.online.add(node);
  await f.manager.reconcile(); expect(f.reg.getDeployment(id)?.state).toBe("ready");
});

test("external duplicated assignment rows converge to one watch without stopping the external engine", async () => {
  const f = rig(); const spec: DeploymentSpec = { name: "prod", kind: "external", profile: "external", external: { nodeId: "mac", url: "http://127.0.0.1:8099", healthPath: "/health", modelName: "model" } };
  const { id } = await f.manager.create(spec); await f.manager.start(id);
  const row = f.reg.listAssignments(id)[0]!;
  f.reg.putAssignment({ ...row.body, id: "duplicate" }, "mac", "ready");
  f.manager.onHello("mac", f.reg.listAssignments(id).map((a) => ({ id: a.id, state: "ready" as const }))); await settle();
  expect(f.reg.listAssignments(id).filter((a) => a.state !== "stopped")).toHaveLength(1);
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  await expect(f.manager.create({ ...spec, name: "duplicate-endpoint" })).rejects.toThrow(/already registered/);
  await expect(f.manager.create({ ...spec, name: "alias", external: { ...spec.external!, url: "http://localhost:8099/" } })).rejects.toThrow(/already registered/);
});

test("boot retires duplicate external deployments and reconnect reuses the surviving watch", async () => {
  const f = rig(); const spec: DeploymentSpec = { name: "prod", kind: "external", profile: "external", external: { nodeId: "mac", url: "http://127.0.0.1:8099", healthPath: "/health", modelName: "model" } };
  const { id } = await f.manager.create(spec); await f.manager.start(id);
  f.reg.createDeployment("duplicate-deployment", { ...spec, name: "duplicate" });
  f.reg.setDeploymentIntent("duplicate-deployment", { running: true });
  f.reg.updateDeployment("duplicate-deployment", { state: "ready" });
  const row = f.reg.listAssignments(id)[0]!;
  f.reg.putAssignment({ ...row.body, id: "duplicate-watch", deploymentId: "duplicate-deployment" }, "mac", "ready");
  f.manager.restore();
  expect(f.manager.routing()).toEqual([]);
  f.manager.onHello("mac", f.reg.listAssignments().map((a) => ({ id: a.id, state: "ready" as const }))); await settle();
  expect(f.manager.routing()[0]?.deployments).toHaveLength(1);
  expect(f.reg.listAssignments().filter((a) => a.state !== "stopped")).toHaveLength(1);
  f.online.delete("mac"); f.manager.onOffline("mac"); expect(f.manager.routing()).toEqual([]);
  f.online.add("mac"); f.manager.onHello("mac", f.reg.listAssignments().filter((a) => a.state !== "stopped").map((a) => ({ id: a.id, state: "ready" as const })));
  expect(f.manager.routing()[0]?.deployments).toHaveLength(1);
});

test("boot recovers external intent without a dispatched watch or with only retired watches", async () => {
  for (const retired of [false, true]) {
    const f = rig(); const spec: DeploymentSpec = { name: "prod", kind: "external", profile: "external", external: { nodeId: "mac", url: "http://127.0.0.1:8099", healthPath: "/health", modelName: "model" } };
    const { id } = await f.manager.create(spec);
    if (retired) {
      await f.manager.start(id); await f.manager.stop(id);
      expect(f.reg.listAssignments(id).every((a) => a.retired)).toBe(true);
    }
    f.reg.setDeploymentIntent(id, { running: true }); // crash after durable Start but before dispatch
    f.reg.updateDeployment(id, { state: "placing" });
    f.manager.restore(); expect(f.reg.getDeployment(id)?.state).toBe("failed");
    f.reg.setOnline("mac", false); await f.manager.reconcile();
    expect(f.reg.deploymentIntent(id).attempts).toBe(0); // authenticated socket alone is insufficient
    f.reg.setOnline("mac", true); f.manager.onHello("mac", []); await f.manager.reconcile();
    expect(f.reg.getDeployment(id)?.state).toBe("ready");
    expect(f.reg.listAssignments(id).filter((a) => !a.retired)).toHaveLength(1);
  }
});

test("hello cleans unknown and failed-deployment workers instead of losing their ownership", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  f.reg.setDeploymentIntent(id, { running: false }); f.reg.updateDeployment(id, { state: "failed" });
  const row = f.reg.listAssignments(id).find((a) => a.nodeId === "l1")!;
  f.manager.onHello("l1", [{ id: row.id, state: "listening" }, { id: "unknown", state: "listening" }]); await settle();
  expect(f.sent.some((s) => s.a.kind === "stop" && s.a.id === "unknown")).toBe(true);
  expect(f.reg.getAssignment(row.id)?.state).toBe("stopped");
});

test("registry migration retains active intent and does not opt old failures or manual stops into recovery", () => {
  const path = join(mkdtempSync(join(tmpdir(), "swarmlet-intent-")), "registry.sqlite");
  const initial = new Registry(path);
  for (const state of ["ready", "loading", "placing", "failed", "stopped", "planned"] as const) { initial.createDeployment(state, split); initial.updateDeployment(state, { state }); }
  initial.close();
  const old = new Database(path); old.run("DROP TABLE deployment_intent"); old.close();
  const f = rig(path);
  for (const state of ["ready", "loading", "placing"]) expect(f.reg.deploymentIntent(state).running).toBe(true);
  for (const state of ["failed", "stopped", "planned"]) expect(f.reg.deploymentIntent(state).running).toBe(false);
});
