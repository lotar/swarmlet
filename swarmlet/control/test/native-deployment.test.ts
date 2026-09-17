import { afterEach, expect, test } from "bun:test";
import { Registry } from "../registry.ts";
import { DeploymentManager } from "../deployments.ts";
import { loadProfiles } from "../planner.ts";
import type { AgentChannel } from "../channel.ts";
import type { Assignment, AssignmentState, ControlToAgent, DeploymentSpec, StageAssignment } from "../../protocol/types.ts";
import type { Qwen35NativeQualification } from "../profiles/qwen35-native.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const nodes = ["l1", "l2", "mac"];
const source = "a".repeat(64), engine = "b".repeat(64);
const binary: Record<string, string> = { l1: "1".repeat(64), l2: "2".repeat(64), mac: "3".repeat(64) };
const cuts = [0, 3, 6, 24];
const shards = nodes.map((node, i) => ({ nodeId: node, modelPath: `/models/stage-${cuts[i]}-${cuts[i + 1]}.gguf`, modelSha256: String(i + 4).repeat(64), start: cuts[i]!, end: cuts[i + 1]! }));
const stages: DeploymentSpec = { name: "native-stages", kind: "stages", profile: "qwen35-2b-q8", stages: shards, ctx: 1024, parallel: 1, chain: 0, transport: "relay" };
const pd: DeploymentSpec = { name: "native-pd", kind: "prefill-decode", profile: "qwen35-2b-q8", prefillNodeId: "mac", decodeNodeId: "l1", modelSha256: source, ctx: 1024, parallel: 1, chain: 0, transport: "relay" };
const qualifications: Qwen35NativeQualification[] = [
  { mode: "stages", sourceSha256: source, sourceSizeBytes: 2048 * 1048576, engine, ctx: 1024, workspaceMiB: 512, hostMiB: 1024, evidenceSha256: "e".repeat(64),
    endpoints: shards.map((s) => ({ binarySha256: binary[s.nodeId]!, artifact: { name: s.modelPath.split("/").at(-1)!, sha256: s.modelSha256, start: s.start, end: s.end } })) },
  { mode: "prefill-decode", sourceSha256: source, sourceSizeBytes: 2048 * 1048576, engine, ctx: 1024, workspaceMiB: 512, hostMiB: 1024, evidenceSha256: "f".repeat(64),
    endpoints: ["mac", "l1"].map((n) => ({ binarySha256: binary[n]!, artifact: { name: "Qwen3.5-2B-Q8_0.gguf", sha256: source, start: 0, end: 24 } })) },
];

function rig() {
  const reg = new Registry(":memory:");
  const online = new Set(nodes), sent: Array<{ nodeId: string; assignment: Assignment }> = [];
  let starts = true;
  let manager: DeploymentManager;
  const report = (nodeId: string, id: string, state: AssignmentState) => { reg.setAssignmentState(id, state); manager.onAssignmentState(nodeId, id, state); };
  const send = (nodeId: string, message: ControlToAgent): boolean => {
    if (!online.has(nodeId)) return false;
    if (message.t !== "assign") return true;
    const assignment = message.assignment;
    sent.push({ nodeId, assignment });
    if (assignment.kind === "stop" || starts) queueMicrotask(() => report(nodeId, assignment.id, assignment.kind === "stop" ? "stopped" : "ready"));
    return true;
  };
  const channel = { isOnline: (nodeId: string) => online.has(nodeId), send,
    assign: (nodeId: string, assignment: Assignment) => { reg.putAssignment(assignment, nodeId); return send(nodeId, { t: "assign", assignment }); } } as unknown as AgentChannel;
  const createManager = () => new DeploymentManager({ reg, channel, profiles: loadProfiles(), nativeQualifications: qualifications, log: quiet, recoveryDelayMs: 0, stopTimeoutMs: 15, reconnectGraceMs: 1000 });
  manager = createManager();
  cleanup.push(() => { manager.dispose(); reg.close(); });
  for (const id of nodes) {
    const mac = id === "mac", os = mac ? "darwin" : "linux", device = mac ? "metal:0" : "cuda:0";
    reg.upsertNode({ id, pubJwk: {}, certFp: `fp-${id}`, hostname: id, os, arch: mac ? "arm64" : "x64", caps: {
      hostname: id, os, arch: mac ? "arm64" : "x64", ramMiB: mac ? 131072 : 16384, ramReserveMiB: 4096, cpuCores: 8,
      gpus: [{ id: device, name: device, backend: mac ? "metal" : "cuda", engineName: mac ? "MTL0" : "CUDA0", totalMiB: mac ? 110000 : 4096 }],
      engine: { proto: "8.1", sha256: { "mesh-stage-worker": binary[id]! }, stages: { engine } },
      diskFreeMiB: 100000, privateIps: ["127.0.0.1"], measuredAt: new Date().toISOString(), publicEndpoints: [{ host: "127.0.0.1", port: 47801 }],
    } });
    reg.setOffer(id, { enabled: true, roles: { worker: true, coordinator: true, replica: true }, gpu: [{ id: device, memMiB: mac ? 100000 : 3600 }], ramMiB: mac ? 110000 : 8192, cpuCores: 8, diskMiB: 100000, modelsDir: "/models" });
    reg.setOnline(id, true);
    const shard = shards.find((s) => s.nodeId === id)!;
    reg.setModels(id, [
      { name: shard.modelPath.split("/").at(-1)!, path: shard.modelPath, sha256: shard.modelSha256, sizeBytes: 1000, kind: "gguf" },
      { name: "Qwen3.5-2B-Q8_0.gguf", path: "/models/Qwen3.5-2B-Q8_0.gguf", sha256: source, sizeBytes: 2048 * 1048576, kind: "gguf" },
    ]);
  }
  return { reg, get manager() { return manager; }, online, sent, report,
    startAcks: (value: boolean) => { starts = value; },
    restart: () => { manager.dispose(); manager = createManager(); manager.restore(); } };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("test condition did not settle"); await Bun.sleep(1); }
}
const stageMessages = (f: ReturnType<typeof rig>) => f.sent.filter((s): s is { nodeId: string; assignment: StageAssignment } => s.assignment.kind === "stage");

test("pre-existing failed deployment intent does not indefinitely block an idle node update", async () => {
  const f = rig();
  const { id } = await f.manager.create(stages); await f.manager.start(id); await Bun.sleep(0);
  const broken = f.reg.createDeployment("pre-existing-failure", { ...stages, name: "pre-existing-failure" });
  f.reg.setDeploymentIntent(broken.id, { running: true });
  f.reg.updateDeployment(broken.id, { state: "failed", error: "insufficient memory" });
  expect(f.manager.acquireUpdate("l1")).not.toBeNull();
});

test("update lease waits for inference, withdraws every affected route and preserves running intent", async () => {
  const f = rig();
  const { id } = await f.manager.create(stages);
  await f.manager.start(id);
  await Bun.sleep(0); // queued operation's completion callback
  f.manager.trackInflight(id, 1);
  expect(f.manager.acquireUpdate("l1")).toBeNull();
  expect(f.manager.routing()).toHaveLength(1);
  f.manager.trackInflight(id, -1);
  const lease = f.manager.acquireUpdate("l1");
  expect(lease?.nodeId).toBe("l1");
  expect(f.manager.routing()).toEqual([]);
  expect(f.reg.deploymentIntent(id).running).toBe(true);
  expect(f.manager.acquireUpdate("l2")).toBeNull();
  expect(f.manager.releaseUpdate("l2", lease!.token)).toBe(false);
  expect(f.manager.releaseUpdate("l1", "wrong-token")).toBe(false);
  expect(f.manager.routing()).toEqual([]);
  expect(f.manager.releaseUpdate("l1", lease!.token)).toBe(true);
  expect(f.manager.routing()).toHaveLength(1);
  expect(f.manager.releaseUpdate("l1", lease!.token)).toBe(false);
});

test("updating node cannot enter a new placement and recovery does not spend retry budget during lease", async () => {
  const f = rig();
  const { id } = await f.manager.create(stages);
  await f.manager.start(id);
  await Bun.sleep(0);
  const lease = f.manager.acquireUpdate("l1");
  expect(lease).not.toBeNull();
  await expect(f.manager.planPreview(stages)).rejects.toThrow();
  f.online.delete("l1"); f.reg.setOnline("l1", false); f.manager.onOffline("l1");
  const before = f.reg.deploymentIntent(id).attempts;
  await f.manager.reconcile();
  expect(f.reg.deploymentIntent(id).attempts).toBe(before);
  expect(f.reg.deploymentIntent(id).running).toBe(true);
  f.manager.releaseUpdate("l1", lease!.token);
  expect(f.manager.acquireUpdate("l2")).toBeNull(); // previous deployment still recovering
});

test("native stage assignments pin artifact/ABI/binary and all must be ready before route publication", async () => {
  const f = rig(); f.startAcks(false);
  const { id } = await f.manager.create(stages);
  const started = f.manager.start(id); void started.catch(() => {});
  await until(() => stageMessages(f).length === 3);
  expect(f.reg.getDeployment(id)?.state).toBe("loading");
  expect(f.manager.routing()).toEqual([]);
  expect(f.manager.nativeExecution(id)).toBeNull();
  const dispatched = stageMessages(f);
  for (const [i, message] of dispatched.entries()) {
    expect(message.assignment).toMatchObject({ model: { path: shards[i]!.modelPath, sha256: shards[i]!.modelSha256 }, binarySha256: binary[message.nodeId], ctx: 1024, gpuLayers: 999 });
    expect(message.assignment.identity).toMatchObject({ engine, source_sha256: source, stage_start: String(cuts[i]), stage_end: String(cuts[i + 1]), stage_total: "24" });
  }
  for (const message of dispatched.slice(0, 2)) f.report(message.nodeId, message.assignment.id, "ready");
  await Bun.sleep(1);
  expect(f.manager.routing()).toEqual([]);
  expect(f.manager.nativeExecution(id)).toBeNull();
  f.report(dispatched[2]!.nodeId, dispatched[2]!.assignment.id, "ready");
  await started;
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(f.manager.routing()[0]?.deployments[0]?.nodes).toEqual(nodes);
  expect(f.manager.nativeExecution(id)?.signal.aborted).toBe(false);
});

test("native P/D preserves the controller-qualified binary pair and publishes both nodes", async () => {
  const f = rig(); const { id } = await f.manager.create(pd); await f.manager.start(id);
  expect(stageMessages(f).map((s) => s.nodeId)).toEqual(["mac", "l1"]);
  expect(f.manager.routing()[0]?.deployments[0]?.nodes).toEqual(["mac", "l1"]);
  expect(f.manager.nativeExecution(id)?.plan.stateTransferQualification).toEqual({ sourceBinarySha256: binary.mac!, targetBinarySha256: binary.l1!, evidenceSha256: "f".repeat(64) });
  for (const message of stageMessages(f)) expect(message.assignment.identity).toMatchObject({ model_sha256: source, stage_start: "", stage_end: "", stage_total: "" });
});

test("Stop aborts the native execution lifetime immediately and tears down every context", async () => {
  const f = rig(); const { id } = await f.manager.create(stages); await f.manager.start(id);
  const execution = f.manager.nativeExecution(id)!;
  const old = f.reg.listAssignments(id);
  const stopped = f.manager.stop(id);
  expect(execution.signal.aborted).toBe(true);
  expect(f.manager.nativeExecution(id)).toBeNull();
  expect(f.manager.routing()).toEqual([]);
  await stopped;
  expect(f.reg.getDeployment(id)?.state).toBe("stopped");
  expect(f.reg.deploymentIntent(id).running).toBe(false);
  expect(old.every((a) => f.reg.getAssignment(a.id)?.state === "stopped")).toBe(true);
  expect(f.sent.filter((s) => s.assignment.kind === "stop").map((s) => s.nodeId).sort()).toEqual([...nodes].sort());
  await f.manager.reconcile();
  expect(stageMessages(f)).toHaveLength(3);
});

test("Stop while native contexts load cancels all waiters and never publishes their late readiness", async () => {
  const f = rig(); f.startAcks(false);
  const { id } = await f.manager.create(stages);
  const started = f.manager.start(id); void started.catch(() => {});
  await until(() => stageMessages(f).length === 3);
  await f.manager.stop(id);
  await expect(started).rejects.toThrow(/cancelled/);
  for (const message of stageMessages(f)) f.report(message.nodeId, message.assignment.id, "ready");
  await Bun.sleep(1);
  expect(f.manager.routing()).toEqual([]);
  expect(f.manager.nativeExecution(id)).toBeNull();
  expect(f.reg.deploymentIntent(id).running).toBe(false);
});

test("unsafe native execution failure withdraws the route, aborts its signal and recovers with fresh contexts", async () => {
  const f = rig(); const { id } = await f.manager.create(stages); await f.manager.start(id);
  const old = f.reg.listAssignments(id), lifetime = f.manager.nativeExecution(id)!.signal;
  const failed = f.manager.nativeExecutionFailed(id, "native reset could not prove an empty worker");
  expect(lifetime.aborted).toBe(true);
  expect(f.manager.routing()).toEqual([]);
  await failed;
  expect(f.reg.getDeployment(id)?.state).toBe("failed");
  expect(old.every((a) => f.reg.getAssignment(a.id)?.state === "stopped")).toBe(true);
  await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  const fresh = f.reg.listAssignments(id).filter((a) => !a.retired);
  expect(fresh).toHaveLength(3);
  expect(fresh.every((a) => !old.some((o) => o.id === a.id))).toBe(true);
  expect(f.manager.nativeExecution(id)!.signal).not.toBe(lifetime);
  expect(f.manager.nativeExecution(id)!.signal.aborted).toBe(false);
});

test("late cleanup failure from an old native lifetime cannot withdraw a fresh generation", async () => {
  const f = rig(); const { id } = await f.manager.create(stages); await f.manager.start(id);
  const old = f.manager.nativeExecution(id)!.signal;
  await f.manager.stop(id);
  await f.manager.start(id);
  const fresh = f.manager.nativeExecution(id)!.signal;
  expect(old.aborted).toBe(true);
  expect(fresh).not.toBe(old);
  await f.manager.nativeExecutionFailed(id, "late reset failure from retired generation", old);
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(f.manager.nativeExecution(id)!.signal).toBe(fresh);
  expect(fresh.aborted).toBe(false);
  expect(f.manager.routing()[0]?.deployments[0]?.id).toBe(id);
  expect(stageMessages(f)).toHaveLength(6);
});

test("recovery waits for every native node rather than consuming attempts when only the first is online", async () => {
  const f = rig(); const { id } = await f.manager.create(stages); await f.manager.start(id);
  await f.manager.nativeExecutionFailed(id, "force fresh native placement");
  // The legacy Plan coordinator is l1; l2 and mac are only in nativeExecution.endpoints.
  f.online.delete("mac"); f.reg.setOnline("mac", false);
  await f.manager.reconcile();
  expect(f.reg.deploymentIntent(id).attempts).toBe(0);
  expect(stageMessages(f)).toHaveLength(3);
  expect(f.manager.routing()).toEqual([]);
  f.online.add("mac"); f.reg.setOnline("mac", true);
  await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(stageMessages(f)).toHaveLength(6);
});

test("disconnecting a non-first native stage invalidates execution and cleans every old context before recovery", async () => {
  const f = rig(); const { id } = await f.manager.create(stages); await f.manager.start(id);
  const old = f.reg.listAssignments(id), lifetime = f.manager.nativeExecution(id)!.signal;
  f.online.delete("l2"); f.reg.setOnline("l2", false); f.manager.onOffline("l2");
  expect(lifetime.aborted).toBe(true);
  expect(f.manager.routing()).toEqual([]);
  await Bun.sleep(30);
  await f.manager.reconcile();
  expect(f.reg.deploymentIntent(id).attempts).toBe(1);   // the plan named l2, so recovery re-plans instead of waiting for it
  expect(stageMessages(f)).toHaveLength(3);
  f.online.add("l2"); f.reg.setOnline("l2", true);
  f.manager.onHello("l2", old.filter((a) => a.nodeId === "l2").map((a) => ({ id: a.id, state: "ready" as const })));
  await until(() => old.every((a) => f.reg.getAssignment(a.id)?.state === "stopped"));
  await f.manager.reconcile();
  expect(f.manager.routing()[0]?.deployments[0]?.nodes).toEqual(nodes);
  expect(f.reg.listAssignments(id).filter((a) => !a.retired).every((a) => !old.some((o) => o.id === a.id))).toBe(true);
});

test("a fresh manager withdraws persisted native routes and replaces every previous assignment", async () => {
  const f = rig(); const { id } = await f.manager.create(stages); await f.manager.start(id);
  const old = f.reg.listAssignments(id), lifetime = f.manager.nativeExecution(id)!.signal;
  f.restart();
  expect(lifetime.aborted).toBe(true);
  expect(f.manager.routing()).toEqual([]);
  expect(f.manager.nativeExecution(id)).toBeNull();
  expect(f.reg.getDeployment(id)?.endpoint).toBeUndefined();
  await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  expect(f.reg.listAssignments(id).filter((a) => !a.retired).every((a) => !old.some((o) => o.id === a.id))).toBe(true);
  expect(f.manager.nativeExecution(id)!.signal.aborted).toBe(false);
});
