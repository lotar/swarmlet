import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssignmentRunner } from "../assignments.ts";
import { engineInfo } from "../probe/engine.ts";
import { processIdentity } from "../roles/identity.ts";
import { stageStateDirectory } from "../roles/stage.ts";
import type { NativeStageIdentity, StageAssignment } from "../../protocol/types.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} };
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const engine = "a".repeat(64), model = "b".repeat(64);
const identity: NativeStageIdentity = { schema: 1, engine, model_sha256: model, source_sha256: model,
  ctx: 1024, cache_k: "f32", cache_v: "f32", ubatch: 1, flash_attn: "disabled", stage_start: "", stage_end: "", stage_total: "" };

function fixture(options: { wrongHealth?: boolean; wrongProbe?: boolean; wrongPid?: boolean; delay?: number; free?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "swarmlet-stage-lifecycle-"));
  const enginePath = join(home, "engine"), stateDir = join(home, "state");
  mkdirSync(enginePath); mkdirSync(stateDir);
  const binaryPath = join(enginePath, "mesh-stage-worker");
  writeFileSync(binaryPath, `#!/usr/bin/env bun
import { createHash } from 'node:crypto';
const binary = createHash('sha256').update(new Uint8Array(await Bun.file(import.meta.path).arrayBuffer())).digest('hex');
if (process.argv[2] === '--identity') {
 console.log(JSON.stringify({schema:1, engine:'${engine}', binary_sha256:${options.wrongProbe ? "'0'.repeat(64)" : "binary"}})); process.exit(0);
}
const identity = ${JSON.stringify(options.wrongHealth ? { ...identity, engine: "d".repeat(64) } : identity)};
await Bun.sleep(${options.delay ?? 0});
Bun.serve({hostname:'127.0.0.1',port:Number(process.argv[5]),fetch(req){return Response.json({identity,binary_sha256:binary,n_embd:2048,n_vocab:248320,session:'',position:0,evaluated_tokens:0,pid:${options.wrongPid ? "1" : "process.pid"}});}});
console.log('fake native worker ready');
`);
  chmodSync(binaryPath, 0o700);
  writeFileSync(join(enginePath, "llama-server"), "fixture presence only");
  writeFileSync(join(enginePath, "sha256.txt"), `${"f".repeat(64)}  mesh-stage-worker\n${"e".repeat(64)}  llama-server\n`);
  const reports: Array<{ id: string; state: string; detail?: string }> = [];
  const runner = new AssignmentRunner({ cfg: () => ({ enginePath, externals: [] }) as never,
    stateDir, certPem: "", keyPem: "", freeRamMiB: async () => options.free ?? 8192, log,
    report: (id, state, detail) => reports.push({ id, state, detail }), logLine() {}, openRelay: () => null });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("reserved"); } });
  const port = reservation.port!; reservation.stop(true);
  const assignment: StageAssignment = { kind: "stage", id: "stage_test", deploymentId: "d", model: { path: join(home, "model.gguf"), sha256: model },
    port, ctx: 1024, gpuLayers: 999, identity, binarySha256: sha(binaryPath), fitMiB: 128, allow: [], enforce: { ramMiB: 8192, cpuCores: 2 } };
  return { home, enginePath, stateDir, binaryPath, runner, reports, assignment,
    async dispose() { await runner.stopAll(); rmSync(home, { recursive: true, force: true }); } };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("fixture condition timed out"); await Bun.sleep(10); }
}

test("stage assignment supervises a real CPU subprocess, keeps raw workers out of inference and clears capsule directory", async () => {
  const f = fixture();
  try {
    f.runner.handle(f.assignment);
    await waitFor(() => f.reports.some(r => r.state === "ready" || r.state === "failed"));
    expect(f.reports.find(r => r.state === "failed")).toBeUndefined();
    const snapshot = f.runner.snapshot()[0]!;
    expect(snapshot.pid).toBeGreaterThan(0);
    expect(f.runner.allowedPorts().has(f.assignment.port)).toBe(true);
    expect(f.runner.inferenceTargets()).toEqual([]);
    const directory = stageStateDirectory(f.stateDir, f.assignment.id);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    writeFileSync(join(directory, "owned.state"), "private capsule");
    await f.runner.stop(f.assignment.id, "test");
    expect(f.runner.snapshot()).toEqual([]);
    expect(existsSync(directory)).toBe(false);
    expect(f.runner.allowedPorts().has(f.assignment.port)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${f.assignment.port}/health`)).rejects.toThrow();
    expect(f.reports.at(-1)?.state).toBe("stopped");
  } finally { await f.dispose(); }
});

test("native binary and fit checks reject before spawning", async () => {
  for (const bad of ["binary", "fit"] as const) {
    const f = fixture({ free: bad === "fit" ? 0 : 8192 });
    try {
      f.runner.handle({ ...f.assignment, ...(bad === "binary" ? { binarySha256: "0".repeat(64) } : {}) });
      await waitFor(() => f.reports.some(r => r.state === "failed"));
      expect(f.runner.snapshot()[0]?.pid).toBeUndefined();
      expect(f.reports.some(r => r.state === "ready")).toBe(false);
      expect(f.reports.find(r => r.state === "failed")?.detail).toContain(bad === "binary" ? "binary differs" : "does not fit");
    } finally { await f.dispose(); }
  }
});

test("loaded native identity mismatch never reports ready and stops the child", async () => {
  const f = fixture({ wrongHealth: true });
  try {
    f.runner.handle(f.assignment);
    await waitFor(() => f.reports.some(r => r.state === "failed"));
    expect(f.reports.some(r => r.state === "ready")).toBe(false);
    expect(f.reports.find(r => r.state === "failed")?.detail).toContain("identity mismatch");
    await f.runner.stop(f.assignment.id, "test");
    expect(existsSync(stageStateDirectory(f.stateDir, f.assignment.id))).toBe(false);
  } finally { await f.dispose(); }
});

test("native probe trusts executable digest plus ABI and discards stale manifest advertisements", async () => {
  const f = fixture(), bad = fixture({ wrongProbe: true });
  try {
    const good = await engineInfo(f.enginePath, log);
    expect(good?.stages).toEqual({ engine });
    expect(good?.sha256["mesh-stage-worker"]).toBe(sha(f.binaryPath));
    expect(good?.sha256["mesh-stage-worker"]).not.toBe("f".repeat(64));
    const rejected = await engineInfo(bad.enginePath, log);
    expect(rejected?.stages).toBeUndefined();
    expect(rejected?.sha256["mesh-stage-worker"]).toBeUndefined();
  } finally { await f.dispose(); await bad.dispose(); }
});

test("recovery stops the recorded real child before deleting private capsule files", async () => {
  const f = fixture();
  const directory = stageStateDirectory(f.stateDir, f.assignment.id);
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "old.state"), "old private state");
  const child = Bun.spawn([f.binaryPath, f.assignment.model.path, model, directory, String(f.assignment.port), "999", "1024"], { stdout: "ignore", stderr: "ignore" });
  const exited = child.exited; // Reap our fixture child while the recovery loop observes its PID.
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${f.assignment.port}/health`)).ok) break; } catch { /* child still starting */ }
      if (Date.now() > deadline) throw new Error("recovery child did not start");
      await Bun.sleep(10);
    }
    const recorded = processIdentity(child.pid)!;
    writeFileSync(join(f.stateDir, "assignments.json"), JSON.stringify([{ id: f.assignment.id, deploymentId: "d", kind: "stage", pid: child.pid, processIdentity: recorded, state: "ready", ports: {} }]));
    await f.runner.recover();
    await exited;
    expect(existsSync(directory)).toBe(false);
    expect(JSON.parse(readFileSync(join(f.stateDir, "assignments.json"), "utf8"))).toEqual([]);
  } finally { if (child.exitCode === null) { child.kill(); await exited; } await f.dispose(); }
});

test("an occupied native port cannot be mistaken for the newly assigned process", async () => {
  const f = fixture();
  const other = Bun.serve({ hostname: "127.0.0.1", port: f.assignment.port,
    fetch() { return Response.json({ identity, binary_sha256: f.assignment.binarySha256, n_embd: 2048, n_vocab: 248320, session: "", position: 0, evaluated_tokens: 0, pid: process.pid }); } });
  try {
    f.runner.handle(f.assignment);
    await waitFor(() => f.reports.some(r => r.state === "failed"));
    expect(f.reports.some(r => r.state === "ready")).toBe(false);
    expect(f.runner.snapshot()[0]?.pid).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${f.assignment.port}/health`)).ok).toBe(true);
  } finally { other.stop(true); await f.dispose(); }
});

test("matching native health from a wrong PID fails readiness", async () => {
  const f = fixture({ wrongPid: true });
  try {
    f.runner.handle(f.assignment);
    await waitFor(() => f.reports.some(r => r.state === "failed"));
    expect(f.reports.some(r => r.state === "ready")).toBe(false);
    expect(f.reports.find(r => r.state === "failed")?.detail).toContain("process");
  } finally { await f.dispose(); }
});
