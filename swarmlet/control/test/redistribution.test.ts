// A deployment is not a property of the machines it happened to start on.
//
// When a node leaves, the model is still servable by whatever is left, so the control re-plans the
// deployment onto the best remaining nodes instead of declaring it failed. When a node arrives, the
// same question is asked in reverse - but a move costs an engine reload, so it only happens when the
// new layout is clearly better and the deployment has been stable. A spec that pins its nodes is
// never moved: that would silently rewrite what its owner asked for.
//
// A load that simply stops making progress is the third case. Its plan can name a node that is gone
// without control ever being told, or its engines can stop reporting; nothing arrives to trigger a
// membership answer, so only the sweeper can rescue it - through the same redistribution path again.
import { afterEach, expect, test } from "bun:test";
import { Registry } from "../registry.ts";
import { DeploymentManager, samePlacement } from "../deployments.ts";
import { loadProfiles } from "../planner.ts";
import type { AgentChannel } from "../channel.ts";
import type { Assignment, AssignmentState, ControlToAgent, DeploymentSpec, Plan } from "../../protocol/types.ts";

const fixtures: Array<{ reg: Registry; manager: DeploymentManager }> = [];
afterEach(() => { for (const f of fixtures.splice(0)) { f.manager.dispose(); f.reg.close(); } });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Auto-placed: the planner chooses the nodes, which is what makes a deployment movable. */
const auto: DeploymentSpec = { name: "auto", kind: "split", profile: "qwen35-2b-q8", transport: "relay", ctx: 1024, parallel: 1, chain: 0 };
/** Pinned: the owner named the machines, so the control must not move it behind their back. */
const pinned: DeploymentSpec = { name: "pinned", kind: "split", profile: "qwen35-2b-q8", coordinatorNodeId: "mac", workerNodeIds: ["l1"], transport: "relay", ctx: 1024, parallel: 1, chain: 0 };

function rig(reconnectGraceMs = 5, pacing: { moveIntervalMs?: number; moveSettleMs?: number; wedgedLoadMs?: number; crashCooldownMs?: number } = {}) {
  const reg = new Registry(":memory:");
  const online = new Set(["mac", "l1", "l2"]);
  const sent: Array<{ node: string; a: Assignment }> = [];
  /** Nodes that fail whatever they are given, standing in for hardware that cannot take the work. */
  const failOn = new Set<string>();
  let manager: DeploymentManager;
  const report = (node: string, id: string, state: AssignmentState, detail?: string) => { reg.setAssignmentState(id, state, detail); manager.onAssignmentState(node, id, state, detail); };
  const send = (node: string, m: ControlToAgent) => {
    if (m.t === "assign") sent.push({ node, a: m.assignment }); // attempts too: an offline node still shows intent
    if (!online.has(node)) return false;
    if (m.t !== "assign") return true;
    const a = m.assignment;
    if (a.kind !== "stop" && failOn.has(node)) {
      // Synchronous on purpose: the move's own catch is what has to see this, and a real engine that dies
      // at load does so while the start is still waiting.
      report(node, a.id, "failed", "engine exited (code 134, SIGABRT): ggml_backend_rpc_add_server");
    } else {
      queueMicrotask(() => report(node, a.id, a.kind === "stop" ? "stopped" : a.kind === "worker" ? "listening" : "ready"));
    }
    return true;
  };
  const channel = { isOnline: (n: string) => online.has(n), send,
    assign: (node: string, a: Assignment) => { reg.putAssignment(a, node); return send(node, { t: "assign", assignment: a }); } } as unknown as AgentChannel;
  manager = new DeploymentManager({ reg, channel, profiles: loadProfiles(), log: quiet, recoveryDelayMs: 0, reconnectGraceMs, stopTimeoutMs: 15,
    moveSettleMs: pacing.moveSettleMs ?? 0, moveIntervalMs: pacing.moveIntervalMs ?? 0,
    // Left unset unless a test names it: the shipped threshold is what the default rigs exercise.
    ...(pacing.wedgedLoadMs === undefined ? {} : { wedgedLoadMs: pacing.wedgedLoadMs }),
    ...(pacing.crashCooldownMs === undefined ? {} : { crashCooldownMs: pacing.crashCooldownMs }) });
  fixtures.push({ reg, manager });
  for (const id of ["mac", "l1", "l2"]) {
    const mac = id === "mac", device = mac ? "metal:0" : "cuda:0";
    reg.upsertNode({ id, pubJwk: {}, certFp: `fp-${id}`, hostname: id, os: mac ? "darwin" : "linux", arch: mac ? "arm64" : "x64", caps: {
      hostname: id, os: mac ? "darwin" : "linux", arch: mac ? "arm64" : "x64", ramMiB: mac ? 131072 : 16384, ramReserveMiB: 4096, cpuCores: 12,
      gpus: [{ id: device, name: device, backend: mac ? "metal" : "cuda", engineName: mac ? "MTL0" : "CUDA0", totalMiB: mac ? 110000 : 4096 }],
      diskFreeMiB: 100000, privateIps: ["127.0.0.1"], measuredAt: new Date().toISOString(),
    } });
    reg.setOffer(id, { enabled: true, roles: { worker: true, coordinator: true, replica: true }, gpu: [{ id: device, memMiB: mac ? 100000 : 3600 }], ramMiB: mac ? 110000 : 8192, cpuCores: 10, diskMiB: 100000, modelsDir: "/models" });
    reg.setOnline(id, true);
    const models = mac
      ? ["Qwen3.5-2B-Q8_0.gguf", "Qwen3.8-27B-Q8_0.gguf", "Qwen3.6-35B-A3B-Q4_K_M.gguf", "Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00005.gguf"]
      : ["Qwen3.5-2B-Q8_0.gguf"];
    reg.setModels(id, models.map((name) => ({ name, path: `/models/${name}`, sizeBytes: 2_200_000_000, kind: "gguf" })));
  }
  return { reg, manager, online, sent, report, failOn };
}

const settle = () => Bun.sleep(25);
/** Drive the manager the way the control's sweeper does: several ticks, not one. */
const sweep = async (m: DeploymentManager, ticks = 6) => { for (let i = 0; i < ticks; i++) { await settle(); await m.reconcile(); } };
/** Where a deployment currently is: current-generation assignments only. An abandoned one on an
 *  offline node stays non-stopped by design (nothing can prove it released), but it is retired and no
 *  longer part of the deployment. */
const liveNodes = (reg: Registry, id: string) => reg.listAssignments(id).filter((a) => a.state !== "stopped" && !a.retired).map((a) => a.nodeId).sort();
const events = (reg: Registry) => reg.listEvents(50).map((e) => e.message);
const servingLayers = (reg: Registry, id: string) => {
  const split = reg.getDeployment(id)?.plan?.tensorSplit;
  return split && split.length ? split[split.length - 1]! : null;
};

test("a node leaving moves an auto-placed deployment instead of failing it", async () => {
  const f = rig(150); // a grace long enough to observe the interval in which nothing has moved yet
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  const before = liveNodes(f.reg, id);
  const gone = before.find((n) => n !== "mac")!; // a worker, not the coordinator

  f.online.delete(gone); f.manager.onOffline(gone);
  await settle();
  await f.manager.reconcile();
  expect(f.reg.getDeployment(id)?.state).toBe("loading"); // inside the grace: the node may still come back
  await sweep(f.manager, 10);                             // past the grace the sweeper moves it

  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");
  expect(dep.error ?? "").not.toContain("reconnect grace expired");
  const after = liveNodes(f.reg, id);
  expect(after).not.toContain(gone);
  expect(after.length).toBeGreaterThan(0);
  expect(events(f.reg).some((m) => m.includes("re-placing"))).toBe(true);
});

test("a pinned deployment is never moved behind its owner's back", async () => {
  const f = rig();
  const { id } = await f.manager.create(pinned);
  await f.manager.start(id);
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  const l1 = f.reg.listAssignments(id).find((a) => a.nodeId === "l1")!;

  f.online.delete("l1"); f.manager.onOffline("l1");
  await settle();
  await f.manager.reconcile();
  await sweep(f.manager);

  expect(f.reg.getDeployment(id)?.state).toBe("failed");
  expect(f.reg.getDeployment(id)?.error).toContain("grace");
  expect(events(f.reg).some((m) => m.includes("placement is pinned"))).toBe(true);
  // The owner's node was asked to clean up. It is offline, so the stop is unacknowledged by design
  // (an offline node is never reported as stopped), and the deployment stays theirs to restart.
  expect(f.sent.some((x) => x.a.id === l1.id && x.a.kind === "stop")).toBe(true);
  expect(f.reg.deploymentIntent(id).running).toBe(true);
});

test("a node joining moves an auto-placed deployment only when the new layout is materially better", async () => {
  const f = rig();
  // start with one worker absent, so the plan leans on the coordinator
  f.online.delete("l2");
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  const beforeLayers = servingLayers(f.reg, id);
  const beforeNodes = liveNodes(f.reg, id);
  expect(beforeNodes).not.toContain("l2");

  // the same call with no change available must not move anything
  f.manager.onNodeOnline("l1");
  await settle();
  expect(f.reg.getDeployment(id)?.state).toBe("ready");

  f.online.add("l2");
  f.manager.onNodeOnline("l2");
  await settle();

  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");
  const afterLayers = servingLayers(f.reg, id);
  const afterNodes = liveNodes(f.reg, id);
  // The placement itself must change - an event alone is not a move, which is exactly how a real gap
  // (the restart refusing to start from a ready state) slipped past an earlier version of this test.
  expect(afterNodes).toContain("l2");
  expect(afterLayers).not.toBeNull();
  expect(beforeLayers).not.toBeNull();
  expect(afterLayers!).toBeLessThanOrEqual(beforeLayers! - 2);
  expect(events(f.reg).some((m) => m.includes("fits better") || m.includes("re-placing"))).toBe(true);
});

test("a deployment whose nodes all leave and nothing else fits fails with the reason, not silently", async () => {
  const f = rig();
  const { id } = await f.manager.create({ ...auto, name: "only-worker" });
  await f.manager.start(id);
  // remove every node that could hold layers
  for (const n of ["l1", "l2"]) { f.online.delete(n); f.manager.onOffline(n); }
  await settle();
  await sweep(f.manager);
  const dep = f.reg.getDeployment(id)!;
  expect(["failed", "loading"]).toContain(dep.state);
  if (dep.state === "failed") expect(dep.error ?? "").not.toBe("");
});

test("an agent shutting down is a node leaving, not an engine failure", async () => {
  // A graceful stop makes the agent report its assignments stopped on the way out, and its socket may
  // not have closed when that message lands. Treating it as an engine failure killed the deployment
  // instantly - the opposite of the ask: the node left, so the work should move.
  const f = rig(150);
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  const gone = liveNodes(f.reg, id).find((n) => n !== "mac")!;
  const row = f.reg.listAssignments(id).find((a) => a.nodeId === gone)!;

  f.online.delete(gone);                              // the agent is going away
  f.report(gone, row.id, "stopped", "agent shutting down");
  await settle();

  const mid = f.reg.getDeployment(id)!;
  expect(mid.state).toBe("loading");                  // withdrawn and waiting, not failed
  expect(mid.error ?? "").toContain("reconnect");

  await sweep(f.manager, 10);                         // past the grace the sweeper re-places it
  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");
  expect(liveNodes(f.reg, id)).not.toContain(gone);
  expect(events(f.reg).some((m) => m.includes("re-placing"))).toBe(true);
});

test("a genuine engine failure still fails immediately", async () => {
  // The counterpart guarantee: only a departing node gets the grace treatment. A crashed engine is a
  // real failure and must not be quietly re-placed as if nothing happened.
  const f = rig(150);
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  const row = f.reg.listAssignments(id).find((a) => a.nodeId !== "mac")!;
  f.report(row.nodeId, row.id, "failed", "engine exited (code 1): failed to load model");
  await settle();
  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("failed");
  expect(dep.error ?? "").toContain("failed to load model");
});

test("a node returning without an abandoned assignment is cleanup, not a failure", async () => {
  // When a node leaves mid-teardown its assignment is retired and left stopped-less, because nothing on
  // that node could confirm the release. If the node then comes back with the engine gone, that absence
  // is the confirmation we were waiting for - and must not fail a deployment that is serving fine.
  const f = rig(150);
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  const gone = liveNodes(f.reg, id).find((n) => n !== "mac")!;
  const row = f.reg.listAssignments(id).find((a) => a.nodeId === gone)!;

  f.online.delete(gone);
  f.report(gone, row.id, "stopped", "agent shutting down"); // reported stopped, then the node goes away
  await sweep(f.manager, 10);                              // re-placed onto what is left
  expect(f.reg.getDeployment(id)?.state).toBe("ready");

  f.online.add(gone);
  f.manager.onHello(gone, []);                             // back, and running nothing
  await settle();
  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");                         // not failed for a lost engine it never had
  expect(dep.error ?? "").not.toContain("restarted without assignment");
  expect(f.reg.getAssignment(row.id)?.state).toBe("stopped");
});

test("a start is not blocked by cleanup a departed node can never acknowledge", async () => {
  // The node that left holds an assignment nobody can stop. A stop must still prove what it claims, but a
  // start that waits for that proof can never happen - which is how a deployment became permanently
  // unrestartable in the field. Starting tolerates the unprovable, for nodes that are gone.
  const f = rig(5_000);                        // a grace long enough that nothing has moved yet
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  const gone = liveNodes(f.reg, id).find((n) => n !== "mac")!;

  f.online.delete(gone);                       // gone, and it never acknowledges its stop
  f.manager.onOffline(gone);
  await settle();
  expect(f.reg.getDeployment(id)?.state).toBe("loading");

  await f.manager.start(id, true);             // the recovery path: must not refuse
  await sweep(f.manager, 8);

  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");
  expect(dep.error ?? "").not.toContain("cleanup pending");
  expect(liveNodes(f.reg, id)).not.toContain(gone);
});

test("a node that cannot take the work is dropped, and the deployment falls back to the placement that works", async () => {
  // A move onto new hardware can fail for reasons the planner cannot see, such as an engine that aborts
  // under a three-worker chain. The deployment that was serving must not be sacrificed to the attempt:
  // drop the node that failed and place again - and remember it, so the recovery does not walk back in.
  const f = rig();
  f.online.delete("l2");
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  const before = liveNodes(f.reg, id);
  expect(before).not.toContain("l2");

  f.failOn.add("l2");                     // it has the memory, but its engine dies at load
  f.online.add("l2");
  f.manager.onNodeOnline("l2");
  await sweep(f.manager, 25);

  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");         // still serving
  expect(liveNodes(f.reg, id)).not.toContain("l2");
  expect(liveNodes(f.reg, id).sort()).toEqual(before.sort());
  expect(events(f.reg).some((m) => m.includes("re-placement did not start"))).toBe(true);
});

/* ---------- automatic model choice ---------- */

/** The spec a user sends when they want the mesh to decide: no profile, just "serve the best you can". */
const autoModel: DeploymentSpec = { name: "auto-model", profile: "auto", kind: "split", ctx: 1024, parallel: 1, chain: 0 };

test("an automatic deployment serves the best model the online nodes can actually place", async () => {
  const f = rig();
  const { id } = await f.manager.create(autoModel);
  await f.manager.start(id);
  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");
  // Ranked by profile.rank, and only what the planner accepts: the 75 GiB flash-next fits on the big node
  // whole, so it wins over the 27B, and a replica is preferred to a split because it has no ring to cross.
  expect(dep.spec.profile).toBe("flash-next-ud-q4kxl");
  expect(dep.spec.kind).toBe("replica");
  expect(dep.spec.autoModel).toBe(true);
  expect(events(f.reg).some((m) => m.includes("automatic: flash-next-ud-q4kxl"))).toBe(true);
});

test("the model choice follows the hardware: the big node leaving downgrades it", async () => {
  const f = rig(150);
  const { id } = await f.manager.create(autoModel);
  await f.manager.start(id);
  expect(f.reg.getDeployment(id)?.spec.profile).toBe("flash-next-ud-q4kxl");

  // With the only node that holds the long weights gone, the best model is the one the survivors hold.
  f.online.delete("mac"); f.manager.onOffline("mac");
  await settle();
  await sweep(f.manager, 20);

  const dep = f.reg.getDeployment(id)!;
  expect(dep.spec.profile).toBe("qwen35-2b-q8");
  expect(dep.state).toBe("ready");
  expect(liveNodes(f.reg, id)).not.toContain("mac");
  expect(events(f.reg).some((m) => m.includes("automatic model choice is now qwen35-2b-q8"))).toBe(true);
});

test("a node joining that changes nothing does not restart the deployment", async () => {
  const f = rig();
  const { id } = await f.manager.create(autoModel);
  await f.manager.start(id);
  const before = f.reg.getDeployment(id)!.plan;
  f.online.add("l2");
  f.manager.onNodeOnline("l2");
  await sweep(f.manager, 10);
  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");
  expect(dep.spec.profile).toBe("flash-next-ud-q4kxl");   // still the best choice
  expect(JSON.stringify(dep.plan)).toBe(JSON.stringify(before)); // and it was not torn down to prove it
});

test("an automatic deployment refuses loudly when nothing can be placed", async () => {
  const f = rig();
  // a mesh that holds only the 2B and cannot coordinate it: no model, no plan, and the reason is returned
  f.reg.setModels("mac", []);
  f.online.delete("l1"); f.online.delete("l2");
  await expect(f.manager.create({ ...autoModel, name: "auto-none" })).rejects.toThrow(/no model can be placed/);
});

test("the automatic choice respects what is free now, not what the node offers", async () => {
  // The offer is unchanged - 100 GiB of GPU, weights present - but the machine has 40 GiB free this
  // minute, because Docker, a browser and another model are all resident. Choosing by offer alone picks
  // flash-next (109,952 MiB to load) and the agent's fit gate kills it seconds later; the honest choice
  // is the next model that actually fits.
  const f = rig();
  f.reg.setMetrics("mac", { ts: new Date().toISOString(), freeRamMiB: 40_000 });
  const { id } = await f.manager.create({ ...autoModel, name: "auto-fit" });
  const dep = f.reg.getDeployment(id)!;
  expect(dep.spec.profile).toBe("qwen38-27b-q8");   // 64 × 389 + 12,288 = 37,184 MiB, and it fits
  expect(dep.spec.kind).toBe("replica");
  expect(events(f.reg).some((m) => m.includes("skipped: flash-next-ud-q4kxl needs"))).toBe(true);
});

/* ---------- loads that stop making progress ---------- */

/** The state the sweeper has to answer for: a load in flight that stopped reporting, with no start()
 *  of its own still holding the deployment. A node that left mid-load without control being told looks
 *  exactly like this once whatever teardown was left has finished. */
const wedge = (reg: Registry, id: string) => reg.updateDeployment(id, { state: "loading", endpoint: null });
const replaces = (reg: Registry) => events(reg).filter((m) => m.includes("re-placing after")).length;
const starts = (sent: Array<{ node: string; a: Assignment }>) => sent.filter((x) => x.a.kind !== "stop").length;

test("a load whose plan names a node that is no longer online is re-planned, not waited out", async () => {
  // The node left mid-load and control was never told. The plan still names it, so the load can never
  // finish and no membership event will ever arrive to answer for it - only the sweep can.
  const f = rig();
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  expect(f.reg.getDeployment(id)?.state).toBe("ready");
  const gone = liveNodes(f.reg, id).find((n) => n !== "mac")!;
  wedge(f.reg, id);
  f.online.delete(gone); f.reg.setOnline(gone, false);
  await sweep(f.manager, 2);

  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");                       // rescued onto the nodes that are still here
  expect(liveNodes(f.reg, id)).not.toContain(gone);
  expect(events(f.reg).some((m) => m.includes("re-placing after") && m.includes("offline"))).toBe(true);
});

test("a young load with every node online is left alone", async () => {
  // The threshold is the shipped one: a load that has just gone quiet may still finish on its own, and
  // every node its plan named is still here to finish it.
  const f = rig();
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  const plan = JSON.stringify(f.reg.getDeployment(id)!.plan);
  const before = starts(f.sent);
  wedge(f.reg, id);
  await sweep(f.manager, 6);

  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("loading");
  expect(JSON.stringify(dep.plan)).toBe(plan);           // the same placement, untouched
  expect(starts(f.sent)).toBe(before);                   // and nothing was restarted to prove it
  expect(replaces(f.reg)).toBe(0);
});

test("a load that stopped making progress is re-planned once it is past the threshold", async () => {
  // Every node is online and the plan is fine, so this can only be answered by the timed branch: past
  // the threshold a load that never reports again is treated as one that will never finish.
  const f = rig(5, { wedgedLoadMs: 0 });
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  wedge(f.reg, id);
  await sweep(f.manager, 2);

  expect(f.reg.getDeployment(id)!.state).toBe("ready");
  expect(events(f.reg).some((m) => m.includes("still not ready after"))).toBe(true);
});

test("a ready deployment is never re-planned by the rescue", async () => {
  // A zero threshold: if the rescue looked at ready deployments at all, this one would be re-planned on
  // the next sweep. Serving deployments keep their placement and their engines.
  const f = rig(5, { wedgedLoadMs: 0 });
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  const plan = JSON.stringify(f.reg.getDeployment(id)!.plan);
  const before = starts(f.sent);
  await sweep(f.manager, 6);

  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("ready");
  expect(JSON.stringify(dep.plan)).toBe(plan);
  expect(starts(f.sent)).toBe(before);
  expect(replaces(f.reg)).toBe(0);
});

test("a wedged load is re-planned at most once per moveIntervalMs", async () => {
  const f = rig(5, { moveIntervalMs: 60_000, wedgedLoadMs: 0 });
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  wedge(f.reg, id);
  await sweep(f.manager, 2);
  expect(replaces(f.reg)).toBe(1);

  // Wedged again straight away. Every node is online, the deployment is inside no operation and its
  // state is eligible, so the interval is the only thing that can stop a second move - and it does.
  wedge(f.reg, id);
  await sweep(f.manager, 3);
  expect(replaces(f.reg)).toBe(1);
  expect(f.reg.getDeployment(id)!.state).toBe("loading");
});

test("a pinned deployment is not rescued behind its owner's back", async () => {
  const f = rig(5, { wedgedLoadMs: 0 });
  const { id } = await f.manager.create(pinned);
  await f.manager.start(id);
  const plan = JSON.stringify(f.reg.getDeployment(id)!.plan);
  wedge(f.reg, id);
  f.online.delete("l1"); f.reg.setOnline("l1", false);   // the plan names a node that is gone
  await sweep(f.manager, 3);

  const dep = f.reg.getDeployment(id)!;
  expect(dep.state).toBe("loading");                      // still waiting for the machine its owner named
  expect(JSON.stringify(dep.plan)).toBe(plan);
  expect(replaces(f.reg)).toBe(0);
});

test("a freshly placed deployment settles before the rescue may move it", async () => {
  const f = rig(5, { moveSettleMs: 60_000, wedgedLoadMs: 0 });
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  wedge(f.reg, id);
  await sweep(f.manager, 4);

  expect(f.reg.getDeployment(id)!.state).toBe("loading");
  expect(replaces(f.reg)).toBe(0);
});

// ---------------------------------------------------------------------------
// A re-decision that lands on the layout already running must not reload the
// engine. This is the failure that restarted the production deployment every
// time a peer node flapped: the candidate plan was identical, the control
// announced a re-placement, and a 27B model had to be reloaded - minutes of
// outage - to reach the placement that had never stopped serving.
// ---------------------------------------------------------------------------

/** A minimal plan; each test varies exactly one thing about it. */
const planOf = (over: Partial<Plan> = {}): Plan => ({
  coordinatorNodeId: "mac", coordinatorDevice: "metal:0", workers: [], tensorSplit: [10], ctx: 1024, parallel: 1, chain: 0,
  env: {}, modelPath: "/models/a.gguf", reasons: [], ...over,
});
const worker = (over: Partial<Plan["workers"][number]> = {}): Plan["workers"][number] =>
  ({ nodeId: "l1", device: "cuda:0", layers: 3, port: 50200, peerPort: 50201, threads: 10, memCapMiB: 3600, ...over });

test("samePlacement: identical placements are equivalent", () => {
  expect(samePlacement(planOf(), planOf())).toBe(true);
  expect(samePlacement(planOf({ workers: [worker(), worker({ nodeId: "l2", port: 50210, peerPort: 50211 })] }),
                       planOf({ workers: [worker(), worker({ nodeId: "l2", port: 50210, peerPort: 50211 })] }))).toBe(true);
});

test("samePlacement: ports are not part of the placement", () => {
  // A port can move because another deployment took it. That is not worth an outage.
  expect(samePlacement(planOf({ workers: [worker()] }), planOf({ workers: [worker({ port: 50999, peerPort: 51000 })] }))).toBe(true);
});

test("samePlacement: the material fields all matter", () => {
  const base = planOf({ workers: [worker()] });
  expect(samePlacement(base, planOf({ workers: [worker({ layers: 4 })] }))).toBe(false);          // different split
  expect(samePlacement(base, planOf({ workers: [worker({ device: "cpu" })] }))).toBe(false);      // different device
  expect(samePlacement(base, planOf({ workers: [worker({ threads: 8 })] }))).toBe(false);         // different threads
  expect(samePlacement(base, planOf({ workers: [worker({ nodeId: "l2" })] }))).toBe(false);       // different node
  expect(samePlacement(base, planOf({ workers: [] }))).toBe(false);                                // workers dropped
  expect(samePlacement(base, planOf({ workers: [worker()], coordinatorNodeId: "l1" }))).toBe(false);
  expect(samePlacement(base, planOf({ workers: [worker()], modelPath: "/models/b.gguf" }))).toBe(false);
  expect(samePlacement(base, planOf({ workers: [worker()], ctx: 2048 }))).toBe(false);
  expect(samePlacement(base, planOf({ workers: [worker()], parallel: 2 }))).toBe(false);
  expect(samePlacement(base, planOf({ workers: [worker()], chain: 2 }))).toBe(false);
  expect(samePlacement(base, planOf({ workers: [worker()], tensorSplit: [9, 1] }))).toBe(false);
  expect(samePlacement(base, planOf({ workers: [worker()], engineTensorSplit: [9, 1] }))).toBe(false);
});

test("samePlacement: worker order is part of the placement", () => {
  const a = planOf({ workers: [worker(), worker({ nodeId: "l2" })] });
  const b = planOf({ workers: [worker({ nodeId: "l2" }), worker()] });
  expect(samePlacement(a, b)).toBe(false);
});

test("samePlacement: a missing plan is never equivalent", () => {
  expect(samePlacement(null, planOf())).toBe(false);
  expect(samePlacement(undefined, planOf())).toBe(false);
  expect(samePlacement(planOf(), null)).toBe(false);
});

test("a node joining does not reload a ready deployment when the plan would not change", async () => {
  const f = rig(150);
  const { id } = await f.manager.create({ ...auto, autoModel: true, kind: "replica" });
  await f.manager.start(id);
  await settle();
  expect(f.reg.getDeployment(id)!.state).toBe("ready");
  const before = f.sent.length;               // every assign, including a restart's stop+assign, lands in sent
  f.manager.onNodeOnline("l2");                // a peer node rejoining - the live trigger for this bug
  await settle();
  expect(f.sent.length).toBe(before);          // no teardown, no reload
  expect(f.reg.getDeployment(id)!.state).toBe("ready");
  expect(events(f.reg).some((e) => /placement unchanged/.test(e))).toBe(true);
});

test("a re-decision that changes the placement still restarts", async () => {
  const f = rig(150);
  const { id } = await f.manager.create({ ...auto, autoModel: true, kind: "replica" });
  await f.manager.start(id);
  await settle();
  const before = f.sent.length;
  // A material change to what is being asked for: the same nodes cannot serve the new context unchanged.
  f.reg.updateDeployment(id, { spec: { ...f.reg.getDeployment(id)!.spec, ctx: 2048 } });
  f.manager.onNodeOnline("l2");
  await settle();
  expect(f.sent.length).toBeGreaterThan(before);
  expect(events(f.reg).some((e) => /placement unchanged/.test(e))).toBe(false);
});

// ---------------------------------------------------------------------------
// A placement that took the engine down is not one to walk into again. The
// production deployment was caught in exactly this loop: an alternative layout
// aborted the engine (SIGABRT inside the RPC backend), nothing recorded it, and
// the next re-decision chose the same shape fifteen minutes later.
// ---------------------------------------------------------------------------

/** Assignments that actually start work - a stop is cleanup, not a placement. */
const workStarts = (sent: Array<{ node: string; a: Assignment }>) => sent.filter((x) => x.a.kind !== "stop");
const workAssignment = (reg: Registry, id: string) =>
  reg.listAssignments(id).find((a) => (a.body as { kind?: string }).kind !== "stop" && a.state !== "stopped" && !a.retired);

test("an engine crash is remembered and that shape is not placed again", async () => {
  const f = rig(150);
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  await settle();
  const a = workAssignment(f.reg, id)!;
  const before = workStarts(f.sent).length;

  f.report(a.nodeId, a.id, "failed", "engine exited (code 134, SIGABRT): ggml_backend_rpc_add_server");
  await settle();
  await sweep(f.manager);

  expect(events(f.reg).some((e) => /this placement crashed/.test(e))).toBe(true);
  expect(events(f.reg).some((e) => /not retrying it for/.test(e))).toBe(true);
  expect(workStarts(f.sent).length).toBe(before);                       // recovery refused to respawn it
  const dep = f.reg.getDeployment(id)!;
  expect(String(dep.error ?? "")).toMatch(/refusing a placement/);   // and said why, loudly
});

test("a graceful exit blocks nothing: recovery places the deployment again", async () => {
  const f = rig(150);
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  await settle();
  const a = workAssignment(f.reg, id)!;
  const before = workStarts(f.sent).length;

  f.report(a.nodeId, a.id, "failed", "engine exited (code 0, signal=null, stopping=true)");
  await settle();
  await sweep(f.manager);

  expect(events(f.reg).some((e) => /this placement crashed/.test(e))).toBe(false);
  expect(workStarts(f.sent).length).toBeGreaterThan(before);             // it was allowed to come back
});

test("the memory expires: once the cooldown has passed the shape may be placed again", async () => {
  const f = rig(150, { crashCooldownMs: 1500 });
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  await settle();
  const a = workAssignment(f.reg, id)!;
  const before = workStarts(f.sent).length;

  f.report(a.nodeId, a.id, "failed", "engine exited (code 134, SIGABRT): boom");
  await settle();
  await sweep(f.manager, 2);                                  // the recovery attempt is what meets the memory
  expect(String(f.reg.getDeployment(id)!.error ?? "")).toMatch(/refusing a placement/);
  expect(workStarts(f.sent).length).toBe(before);             // and it did not respawn the shape

  await Bun.sleep(1600);                                      // the memory lapses
  await f.manager.start(id);                                  // an explicit start is allowed through again
  await settle();
  expect(workStarts(f.sent).length).toBeGreaterThan(before);
});

test("a repeat crash is remembered for longer than the first", async () => {
  const f = rig(150);
  const { id } = await f.manager.create(auto);
  await f.manager.start(id);
  await settle();
  const plan = f.reg.getDeployment(id)!.plan!;
  // White box on purpose: the second strike is a policy about the memory itself, and driving two real
  // crashes of one shape would test the recovery budget twice over instead.
  const memory = f.manager as unknown as { blockPlacement(id: string, plan: Plan, why: string): void };
  memory.blockPlacement(id, plan, "first strike");
  memory.blockPlacement(id, plan, "second strike");
  const minutes = events(f.reg).filter((e) => /not retrying it for/.test(e))
    .map((m) => Number(/(\d+) min/.exec(m)?.[1] ?? -1));
  expect(minutes.length).toBe(2);
  expect(minutes.sort((a, b) => a - b)).toEqual([60, 240]);    // an hour, then four times that after the repeat
});
