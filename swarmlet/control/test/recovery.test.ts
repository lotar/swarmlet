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

function rig(path = ":memory:", reconnectGraceMs = 30_000, stopTimeoutMs = 15) {
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
  manager = new DeploymentManager({ reg, channel, profiles: loadProfiles(), log: quiet, recoveryDelayMs: 0, stopTimeoutMs, reconnectGraceMs });
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

test("asymmetric speculative split reaches the actual coordinator assignment", async () => {
  const f = rig();
  const { id } = await f.manager.create({ ...split, workerLayers: [2, 3], speculation: { type: "ngram-simple" } });
  await f.manager.start(id);
  const a = f.sent.find((x) => x.a.kind === "coordinator")!.a;
  expect(a.kind).toBe("coordinator");
  if (a.kind !== "coordinator") throw new Error("coordinator assignment missing");
  expect(a.tensorSplit).toEqual([2, 3, 20]); // 19 coordinator blocks plus the output slot.
  expect(a.env.LLAMA_ARG_LOG_VERBOSITY).toBe("4");
  expect(a.speculation).toEqual({ type: "ngram-simple" });
  expect(a.mtp).toBeUndefined();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
});

test("replica assignment honors planned device and speculation", async () => {
  const f = rig();
  const { id } = await f.manager.create({ name: "spec-replica", kind: "replica", profile: split.profile, replicaNodeId: "mac", ctx: 1024, parallel: 1, speculation: { type: "ngram-simple" } });
  await f.manager.start(id);
  const a = f.sent.find((x) => x.a.kind === "replica")!.a;
  if (a.kind !== "replica") throw new Error("replica assignment missing");
  expect(a.device).toBe("MTL0");
  expect(a.speculation).toEqual({ type: "ngram-simple" });
  expect(f.manager.routing()[0]?.deployments[0]?.id).toBe(id);
});

test("darwin replica carries the whole-model fit gate and, on request, the production server it may stop", async () => {
  const f = rig();
  const profile = loadProfiles().get(split.profile)!;
  const wholeModelMiB = profile.layers * profile.layerMiB + profile.coordinatorHostMiB;
  await f.manager.create({ name: "prod-2b", profile: "external", kind: "external", external: { nodeId: "mac", url: "http://127.0.0.1:8099", healthPath: "/health", modelName: profile.modelName } });
  await f.manager.create({ name: "prod-other", profile: "external", kind: "external", external: { nodeId: "l1", url: "http://127.0.0.1:8098", healthPath: "/health", modelName: "other" } });
  const plain = await f.manager.create({ name: "plain", kind: "replica", profile: split.profile, replicaNodeId: "mac", ctx: 1024, parallel: 1 });
  await f.manager.start(plain.id);
  const p = f.sent.find((x) => x.a.kind === "replica" && x.a.deploymentId === plain.id)!.a;
  if (p.kind !== "replica") throw new Error("replica assignment missing");
  expect(p.fitMiB).toBe(wholeModelMiB);
  expect(p.stopExternal).toBeUndefined();
  await f.manager.stop(plain.id); // a running replica reserves the node's whole offer
  const takeover = await f.manager.create({ name: "takeover", kind: "replica", profile: split.profile, replicaNodeId: "mac", ctx: 1024, parallel: 1, stopExternal: true });
  await f.manager.start(takeover.id);
  const t = f.sent.find((x) => x.a.kind === "replica" && x.a.deploymentId === takeover.id)!.a;
  if (t.kind !== "replica") throw new Error("replica assignment missing");
  expect(t.fitMiB).toBe(wholeModelMiB);
  expect(t.stopExternal).toBe("prod-2b"); // only the external on the replica's own node
});

test("external deployments reject execution options before persisting or starting", async () => {
  const f = rig();
  const external: DeploymentSpec = { name: "external", profile: "external", kind: "external", external: { nodeId: "mac", url: "http://127.0.0.1:8099", healthPath: "/health", modelName: "external" } };
  for (const options of [{ speculation: { type: "ngram-simple" as const } }, { workerLayers: [2, 3] }, { chain: 1 }]) {
    await expect(f.manager.create({ ...external, ...options })).rejects.toThrow("cannot configure");
  }
  expect(f.reg.listDeployments()).toEqual([]);
  f.reg.createDeployment("legacy-external", { ...external, speculation: { type: "ngram-simple" } });
  await expect(f.manager.start("legacy-external")).rejects.toThrow("cannot configure");
  expect(f.sent).toEqual([]);
});

test("offline worker is not falsely stopped; reconnect cleans it before fresh three-node placement", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  expect((f.sent.find((s) => s.a.kind === "coordinator")!.a as import("../../protocol/types.ts").CoordinatorAssignment).env.LLAMA_ARG_LOG_VERBOSITY).toBeUndefined();
  const old = f.reg.listAssignments(id), l1 = old.find((a) => a.nodeId === "l1")!;
  f.online.delete("l1"); f.manager.onOffline("l1");
  expect(f.reg.getDeployment(id)?.state).toBe("loading");
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


test("reconnect grace expires without consuming attempts while required nodes remain absent", async () => {
  const f = rig(":memory:", 5); const { id } = await f.manager.create(split); await f.manager.start(id);
  f.online.delete("l1"); f.manager.onOffline("l1");
  expect(f.reg.getDeployment(id)?.state).toBe("loading");
  await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("failed");
  expect(f.reg.getDeployment(id)?.error).toContain("reconnect grace expired");
  expect(f.reg.deploymentIntent(id).attempts).toBe(0);
  f.online.add("l1"); f.manager.onHello("l1", []); await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
});

test("manual Stop during reconnect grace never restarts and further disconnects keep draining", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  const old = f.reg.listAssignments(id);
  f.online.delete("l1"); f.manager.onOffline("l1"); await settle();
  await expect(f.manager.stop(id)).rejects.toThrow(/cleanup pending/);
  f.manager.onOffline("l1");
  expect(f.reg.getDeployment(id)?.state).toBe("draining");
  f.online.add("l1"); f.manager.onHello("l1", [{ id: old.find(a => a.nodeId === "l1")!.id, state: "listening" }]);
  await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("stopped");
  expect(f.reg.deploymentIntent(id).running).toBe(false);
  expect(f.sent.filter(s => s.a.kind !== "stop")).toHaveLength(3);
});

test("repeated reconnect recoveries consume the retry budget instead of resetting it", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  for (let n = 0; n < 6; n++) {
    f.online.delete("l1"); f.manager.onOffline("l1"); await settle();
    f.online.add("l1"); f.manager.onHello("l1", []); await settle(); await f.manager.reconcile();
  }
  expect(f.reg.deploymentIntent(id).attempts).toBe(5);
  expect(f.reg.getDeployment(id)?.state).toBe("failed");
  expect(f.manager.routing()).toEqual([]);
});

test("disconnect during placement cancels old start before any replacement coordinator", async () => {
  const f = rig(); const { id } = await f.manager.create(split); f.setStarts(false);
  const start = f.manager.start(id).catch((e: Error) => e);
  await Bun.sleep(1);
  f.online.delete("l1"); f.manager.onOffline("l1");
  expect(String(await start)).toContain("cancelled");
  expect(f.reg.getDeployment(id)?.state).toBe("loading");
  await settle();
  f.online.add("l1"); f.manager.onHello("l1", []); f.setStarts(true);
  await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(f.sent.filter(s => s.a.kind === "coordinator")).toHaveLength(1);
  expect(f.reg.listAssignments(id).filter(a => a.state !== "stopped")).toHaveLength(3);
});

test("multiple lost nodes require all reconnect acknowledgements before rebuilding", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  f.online.delete("l1"); f.online.delete("l2"); f.manager.onOffline("l1"); f.manager.onOffline("l2");
  await settle();
  f.online.add("l1"); f.manager.onHello("l1", []); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("loading");
  expect(f.reg.deploymentIntent(id).attempts).toBe(0);
  expect(f.manager.routing()).toEqual([]);
  f.online.add("l2"); f.manager.onHello("l2", []); await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(f.reg.listAssignments(id).filter(a => a.state !== "stopped")).toHaveLength(3);
});

test("Stop waits for an offline node's reconnect acknowledgement within its timeout", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  const l1 = f.reg.listAssignments(id).find(a => a.nodeId === "l1")!;
  f.online.delete("l1");
  let outcome = "pending";
  const stopping = f.manager.stop(id).then(() => { outcome = "stopped"; }, () => { outcome = "rejected"; });
  await Bun.sleep(2);
  expect(outcome).toBe("pending");
  f.online.add("l1"); f.manager.onHello("l1", [{ id: l1.id, state: "listening" }]);
  await stopping;
  expect(outcome).toBe("stopped");
  expect(f.reg.getDeployment(id)?.state).toBe("stopped");
  expect(f.reg.listAssignments(id).every(a => a.state === "stopped")).toBe(true);
});


test("reconnect inside grace allows bounded cleanup to finish after the reconnect deadline", async () => {
  const f = rig(":memory:", 10, 100); const { id } = await f.manager.create(split); await f.manager.start(id);
  const old = f.reg.listAssignments(id); f.setStops(false);
  f.online.delete("l1"); f.manager.onOffline("l1");
  f.online.add("l1"); f.manager.onHello("l1", [{ id: old.find(a => a.nodeId === "l1")!.id, state: "listening" }]);
  await f.manager.reconcile();
  await Bun.sleep(15); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("loading");
  expect(f.manager.routing()).toEqual([]);
  for (const a of old) f.report(a.nodeId, a.id, "stopped");
  f.setStops(true); await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(f.reg.listAssignments(id).filter(a => a.state !== "stopped")).toHaveLength(3);
});

test("reconnected nodes cannot keep recovery loading forever without stop acknowledgements", async () => {
  const f = rig(":memory:", 1000, 5); const { id } = await f.manager.create(split); await f.manager.start(id);
  const old = f.reg.listAssignments(id); f.setStops(false);
  f.online.delete("l1"); f.manager.onOffline("l1");
  f.online.add("l1"); f.manager.onHello("l1", [{ id: old.find(a => a.nodeId === "l1")!.id, state: "listening" }]);
  await f.manager.reconcile(); await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("failed");
  expect(f.reg.getDeployment(id)?.error).toContain("reconnect cleanup deadline");
  expect(f.reg.listAssignments(id).filter(a => a.state !== "stopped")).toHaveLength(3);
  expect(f.sent.filter(s => s.a.kind !== "stop")).toHaveLength(3);
  expect(f.manager.routing()).toEqual([]);
});

test("RPC crash reported during disconnect recovery does not bypass the reconnect grace", async () => {
  const f = rig(); const { id } = await f.manager.create(split); await f.manager.start(id);
  const coordinator = f.reg.listAssignments(id).find(a => a.body.kind === "coordinator")!;
  f.online.delete("l1"); f.manager.onOffline("l1");
  // Failure can arrive before queued teardown has retired the coordinator assignment.
  f.report(coordinator.nodeId, coordinator.id, "failed");
  expect(f.reg.getDeployment(id)?.state).toBe("loading");
  expect(f.manager.routing()).toEqual([]);
  await settle(); f.online.add("l1"); f.manager.onHello("l1", []); await settle(); await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
});

const savedLayout = { coordinatorNodeId: 'mac', workerNodeIds: ['l2','l1'], workerLayers: [2,3] };
async function distributionSettled(check:()=>boolean) {
  const deadline=Date.now()+1500;
  while(!check()){if(Date.now()>deadline)throw new Error('distribution did not settle');await Bun.sleep(2);}
}
test('saved distribution survives registry reopen without changing active spec, route or recovery intent',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'swarmlet-distribution-')),'control.sqlite');
  const f=rig(path);const {id}=await f.manager.create(split);await f.manager.start(id);
  const before=f.reg.getDeployment(id)!;const assignments=f.reg.listAssignments(id).map(a=>a.id);
  const result=f.manager.saveDistribution(id,savedLayout);
  expect(result.plan.tensorSplit).toEqual([2,3,19]);
  expect(f.reg.getDeployment(id)!.spec).toEqual(before.spec);
  expect(f.reg.getDeployment(id)!.endpoint).toEqual(before.endpoint);
  expect(f.reg.listAssignments(id).map(a=>a.id)).toEqual(assignments);
  expect(f.reg.deploymentIntent(id).running).toBe(true);
  const disk=new Registry(path);
  expect(disk.getDeployment(id)!.savedDistribution).toEqual(savedLayout);
  expect(disk.getDeployment(id)!.spec).toEqual(before.spec);disk.close();
});
test('invalid distribution cannot overwrite the saved layout or stop a running deployment',async()=>{
  const f=rig();const {id}=await f.manager.create(split);await f.manager.start(id);
  f.manager.saveDistribution(id,savedLayout);const count=f.sent.length;
  for(const bad of [{...savedLayout,workerLayers:[99,3]},{...savedLayout,workerLayers:[1.5,3]},{...savedLayout,workerNodeIds:['l1','l1']},{...savedLayout,extra:true}]){
    expect(()=>f.manager.saveDistribution(id,bad)).toThrow();
  }
  expect(f.reg.getDeployment(id)!.savedDistribution).toEqual(savedLayout);
  expect(f.reg.getDeployment(id)!.state).toBe('ready');expect(f.sent.length).toBe(count);
});
test('Apply retires old assignments before publishing the saved exact distribution',async()=>{
  const f=rig();const {id}=await f.manager.create(split);await f.manager.start(id);
  const old=f.reg.listAssignments(id).map(a=>a.id);f.manager.saveDistribution(id,savedLayout);
  f.manager.applyDistribution(id);
  expect(()=>f.manager.applyDistribution(id)).toThrow(/progress/);
  await distributionSettled(()=>f.reg.getDeployment(id)?.state==='ready' && f.reg.getDeployment(id)?.spec.workerNodeIds?.[0]==='l2');
  const d=f.reg.getDeployment(id)!;expect(d.plan!.tensorSplit).toEqual([2,3,19]);expect(d.plan!.engineTensorSplit).toEqual([2,3,20]);
  expect(f.reg.listAssignments(id).filter(a=>old.includes(a.id)).every(a=>a.retired&&a.state==='stopped')).toBe(true);
  expect(f.reg.listAssignments(id).filter(a=>!a.retired).map(a=>a.nodeId)).toEqual(['l2','l1','mac']);
  await settle();
});
test('Apply revalidates current offers and active requests before teardown',async()=>{
  const f=rig();const {id}=await f.manager.create(split);await f.manager.start(id);f.manager.saveDistribution(id,savedLayout);
  const sent=f.sent.length;f.manager.trackInflight(id,1);expect(()=>f.manager.applyDistribution(id)).toThrow(/active requests/);f.manager.trackInflight(id,-1);
  f.online.delete('l1');expect(()=>f.manager.applyDistribution(id)).toThrow();
  expect(f.sent.length).toBe(sent);expect(f.reg.getDeployment(id)!.state).toBe('ready');
});
test('failed teardown preserves both the active spec and saved distribution',async()=>{
  const f=rig();const {id}=await f.manager.create(split);await f.manager.start(id);f.manager.saveDistribution(id,savedLayout);f.setStops(false);
  f.manager.applyDistribution(id);
  await distributionSettled(()=>!!f.reg.getDeployment(id)?.error?.startsWith('Apply distribution:'));
  expect(f.reg.getDeployment(id)!.spec).toEqual(split);expect(f.reg.getDeployment(id)!.savedDistribution).toEqual(savedLayout);
  expect(f.reg.listAssignments(id)).toHaveLength(3);
  expect(f.reg.listAssignments(id).every(a=>a.retired && a.state!=='stopped')).toBe(true);await settle();
});

test('Stop during Apply cancels its pending restart',async()=>{
  const f=rig();const {id}=await f.manager.create(split);await f.manager.start(id);
  f.manager.saveDistribution(id,savedLayout);
  const starts=f.sent.filter(x=>x.a.kind!=='stop').length;
  f.manager.applyDistribution(id);
  await f.manager.stop(id);await settle();
  expect(f.reg.getDeployment(id)!.state).toBe('stopped');
  expect(f.reg.deploymentIntent(id).running).toBe(false);
  expect(f.reg.getDeployment(id)!.spec).toEqual(split);
  expect(f.sent.filter(x=>x.a.kind!=='stop')).toHaveLength(starts);
});
