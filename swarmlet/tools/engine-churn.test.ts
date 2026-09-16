// The harness that would have caught 2026-09-16 on its own.
//
// The failure it exists for: a serving node restarted its engine ~102 times in 24 hours (median spacing
// ~15 minutes) because a peer node flapped and the control re-decided the placement on every reconnect.
// Each restart is 1-5 minutes of outage for whoever is mid-request, and nothing on the box reported it.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const HERE = import.meta.dir;
const HARNESS = join(HERE, "engine-churn.mjs");

interface Report {
  spawns: number; exits: number; gracefulExits: number; restartsPerHour: number; rateIsMeaningful: boolean;
  ungracefulExits: Array<{ kind: string; code: number | null; signal: string | null; why: string | null }>;
  perHour: Record<string, number>; longestNoEngineSeconds: number; verdict: string; assignmentFailures: unknown[];
}

/** Run the harness as a subprocess - the tool's contract is its exit code and its JSON, not its internals. */
function run(fixture: string): { code: number; report: Report | null; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [HARNESS, "--log", join(HERE, "fixtures", fixture), "--json"], { encoding: "utf8" });
    return { code: 0, report: JSON.parse(stdout) as Report, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    const stdout = err.stdout ?? "";
    let report: Report | null = null;
    try { report = JSON.parse(stdout) as Report; } catch { /* non-zero exit with no JSON is itself a case below */ }
    return { code: err.status ?? -1, report, stdout };
  }
}

test("a log with restart churn AND a crash exits 2 and names both", () => {
  const { code, report } = run("churny.log");
  expect(code).toBe(2);
  expect(report).not.toBeNull();
  expect(report!.spawns).toBe(20);
  expect(report!.restartsPerHour).toBeGreaterThan(1);
  expect(report!.rateIsMeaningful).toBe(true);
  expect(report!.ungracefulExits.length).toBe(2);
  expect(Object.keys(report!.perHour).length).toBeGreaterThanOrEqual(4);
  expect(report!.verdict).toBe("ungraceful-exit");
});

test("an engine that aborted is reported with its signal and the engine's own reason", () => {
  const { code, report } = run("crashy.log");
  expect(code).toBe(2);
  const crash = report!.ungracefulExits[0]!;
  expect(crash.kind).toBe("coordinator");
  expect(crash.code).toBe(134);
  expect(crash.signal).toBe("SIGABRT");
  expect(String(crash.why)).toMatch(/ggml_backend_rpc_add_server/);
  // The node's Mac app updater fails its signature check every ~30s and says nothing about the engine:
  // it must not be counted as churn, and a window this short must not be reported as a rate.
  expect(report!.spawns).toBe(3);
  expect(report!.rateIsMeaningful).toBe(false);
});

test("a quiet log is clean and exits 0", () => {
  const { code, report } = run("clean.log");
  expect(code).toBe(0);
  expect(report!.verdict).toBe("clean");
  expect(report!.spawns).toBe(1);
  expect(report!.ungracefulExits.length).toBe(0);
});

test("restarts are bucketed into the right hours across a midnight boundary", () => {
  const { code, report } = run("midnight.log");
  expect(code).toBe(2);                       // three restarts in a little over an hour is churn
  expect(report!.verdict).toBe("churn");
  expect(report!.spawns).toBe(4);
  const hours = Object.keys(report!.perHour).sort();
  const days = new Set(hours.map((h) => h.slice(0, 10)));
  expect(days.size).toBe(2);                  // 23:xxZ on one day, 00:xxZ and 01:xxZ on the next
  expect(hours.map((h) => h.slice(11, 13)).sort()).toEqual(["00", "01", "23"]);
  expect(report!.longestNoEngineSeconds).toBeGreaterThan(0);
});

test("an unreadable log is an input error, not a clean bill of health", () => {
  try {
    execFileSync(process.execPath, [HARNESS, "--log", "/nonexistent/agent.err.log"], { encoding: "utf8", stdio: "pipe" });
    throw new Error("expected a non-zero exit");
  } catch (e) {
    expect((e as { status?: number }).status).toBe(1);
  }
});

test("the threshold is configurable, and the shipped default is the strict one", () => {
  const loose = execFileSync(process.execPath, [HARNESS, "--log", join(HERE, "fixtures", "midnight.log"), "--max-restarts-per-hour", "10", "--json"], { encoding: "utf8" });
  expect((JSON.parse(loose) as Report).verdict).toBe("clean");
});
