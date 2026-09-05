import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssignmentRunner } from "../assignments.ts";
import { SupervisedProcess } from "../roles/process.ts";
import type { Assignment } from "../../protocol/types.ts";

function fixture(freeRamMiB: () => Promise<number | undefined>, externals: unknown[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "swarmlet-lifecycle-unit-"));
  const reports: Array<{ id: string; state: string }> = [];
  const runner = new AssignmentRunner({
    cfg: () => ({ enginePath: "/no-engine", externals }) as never,
    stateDir: dir, certPem: "", keyPem: "", freeRamMiB,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    report: (id, state) => reports.push({ id, state }), logLine() {}, openRelay: () => null,
  });
  return { runner, reports, dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("stop waits for pending startup and prevents a late process spawn", async () => {
  let release!: (n: number) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  const f = fixture(() => { entered(); return new Promise<number>((r) => { release = r; }); });
  const spawn = spyOn(SupervisedProcess.prototype, "start").mockImplementation(() => {});
  try {
    f.runner.handle({ id: "late", deploymentId: "dep", kind: "coordinator", fitMiB: 100, rpc: [] } as unknown as Assignment);
    await waiting;
    let stopped = false;
    const stop = f.runner.stop("late", "test").then(() => { stopped = true; });
    await Bun.sleep(1);
    expect(stopped).toBe(false);
    release(200);
    await stop;
    expect(spawn).not.toHaveBeenCalled();
    expect(f.runner.snapshot()).toEqual([]);
    expect(f.reports.at(-1)).toEqual({ id: "late", state: "stopped" });
    expect(f.reports.some((r) => r.state === "ready" || r.state === "loading")).toBe(false);
  } finally { spawn.mockRestore(); f.dispose(); }
});

test("malformed ownership state fails closed and is preserved", async () => {
  const f = fixture(async () => 100);
  const file = join(f.dir, "assignments.json");
  try {
    for (const text of ['[{"id":', '{}', '[{"pid":123}]']) {
      writeFileSync(file, text);
      await expect(f.runner.recover()).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  } finally { f.dispose(); }
});

test("partial external stop retains restore obligation until successful cleanup", async () => {
  const f = fixture(async () => 0, [{ id: "prod", url: "http://127.0.0.1:19999", maintenance: "/unused" }]);
  const internals = f.runner as unknown as { maintenance: (_ext: unknown, verb: string) => Promise<{ code: number; text: string }> };
  const verbs: string[] = [];
  let restored = false;
  const maintenance = spyOn(internals, "maintenance").mockImplementation(async (_ext, verb) => {
    verbs.push(verb);
    return { code: verb === "stop" ? 66 : restored ? 0 : 67, text: "fixture" };
  });
  try {
    f.runner.handle({ id: "partial", deploymentId: "dep", kind: "coordinator", fitMiB: 100, stopExternal: "prod", rpc: [] } as unknown as Assignment);
    for (let i = 0; i < 100 && !verbs.includes("start"); i++) await Bun.sleep(1);
    await Bun.sleep(1);
    expect(verbs.slice(0, 2)).toEqual(["stop", "start"]);
    expect(f.runner.snapshot()[0]?.stoppedExternalId).toBe("prod");
    expect(f.reports.some((r) => r.state === "stopped")).toBe(false);
    restored = true;
    await f.runner.stop("partial", "retry cleanup");
    expect(f.runner.snapshot()).toEqual([]);
    expect(verbs).toEqual(["stop", "start", "start"]);
    expect(f.reports.at(-1)?.state).toBe("stopped");
  } finally { maintenance.mockRestore(); f.dispose(); }
});

test("stop during external health check cannot resurrect watch or ready state", async () => {
  let release!: (r: Response) => void;
  let entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; });
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation((() => { entered(); return new Promise<Response>((r) => { release = r; }); }) as unknown as typeof fetch);
  const f = fixture(async () => 100);
  try {
    f.runner.handle({ id: "watch", deploymentId: "dep", kind: "replica", external: { url: "http://127.0.0.1:19999", healthPath: "/health" } } as Assignment);
    await waiting;
    const stop1 = f.runner.stop("watch", "test"), stop2 = f.runner.stop("watch", "test");
    release(new Response("ok"));
    await Promise.all([stop1, stop2]);
    expect(f.runner.snapshot()).toEqual([]);
    expect(f.reports.filter((r) => r.state === "stopped").length).toBe(1);
    expect(f.reports.some((r) => r.state === "ready")).toBe(false);
  } finally { fetchMock.mockRestore(); f.dispose(); }
});
