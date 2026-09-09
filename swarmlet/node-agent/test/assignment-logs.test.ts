import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssignmentLogs } from "../assignment-logs.ts";
import { AssignmentRunner } from "../assignments.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} };

test("engine failure evidence survives cleanup and agent recreation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swarmlet-log-retention-"));
  const deps = { stateDir: dir, cfg: () => ({ externals: [] }), log, report() {}, logLine() {}, openRelay: () => null,
    freeRamMiB: async () => 100, certPem: "", keyPem: "" };
  const runner = new AssignmentRunner(deps as never);
  // Exercise the canonical spawn callbacks with a tiny real process, without a model or network.
  const internal = runner as any;
  const x = { a: { id: "failed-engine", kind: "worker", deploymentId: "dep" }, state: "starting", ports: {} };
  try {
    internal.active.set(x.a.id, x);
    await internal.spawn(x, "log-retention", [process.execPath, "-e", 'console.error("engine diagnostic fixture"); process.exit(7)'], {});
    for (let i = 0; i < 100 && !runner.recentLog(x.a.id).some((s) => s.includes("engine exited code=7")); i++) await Bun.sleep(10);
    expect(runner.recentLog(x.a.id).join("\n")).toContain("engine diagnostic fixture");
    await runner.stop(x.a.id, "cleanup");
    expect(runner.snapshot()).toEqual([]);
    for (const instance of [runner, new AssignmentRunner(deps as never)]) {
      const lines = instance.recentLog(x.a.id).join("\n");
      expect(lines).toContain("engine diagnostic fixture");
      expect(lines).toContain("engine exited code=7");
      expect(lines).toContain("[lifecycle] stopped");
    }
  } finally { await runner.stopAll(); rmSync(dir, { recursive: true, force: true }); }
});

test("retained evidence is bounded and assignment IDs cannot traverse paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarmlet-log-limits-"));
  try {
    const logs = new AssignmentLogs(dir, log);
    for (let i = 0; i < 140; i++) logs.append(`id-${i}`, `message-${i}`);
    expect(readdirSync(join(dir, "assignment-logs")).length).toBe(128);
    const id = "../../outside";
    for (let i = 0; i < 100; i++) logs.append(id, `${i}:` + "x".repeat(20_000));
    const files = readdirSync(join(dir, "assignment-logs"));
    expect(files.length).toBe(128);
    expect(files.every((name) => /^[a-f0-9]{64}\.log$/.test(name))).toBe(true);
    expect(files.every((name) => statSync(join(dir, "assignment-logs", name)).size <= 256 * 1024)).toBe(true);
    expect(logs.recent(id, 1)[0]).toContain("99:");
    expect(Buffer.byteLength(logs.recent(id, 1)[0]!)).toBeLessThan(8300);
    expect(logs.recent(id, 0)).toEqual([]);
    expect(logs.recent(id, -1)).toEqual([]);
    expect(logs.recent("absent")).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
