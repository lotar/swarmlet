#!/usr/bin/env bun
// Narrow restart supervisor for the physical proof. It owns exactly one node
// process and restarts that exact argv after a crash.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
function arg(name: string, fallback?: string): string { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) { if (fallback !== undefined) return fallback; throw new Error(`missing ${name}`); } return process.argv[i + 1]!; }
const pidFile = resolve(arg("--pid-file")); const launchId = arg("--launch-id", "local"); const marker = process.argv.indexOf("--");
if (marker < 0 || marker === process.argv.length - 1) throw new Error("expected -- followed by node arguments");
const nodeArgs = process.argv.slice(marker + 1); const nodeIdIndex = nodeArgs.indexOf("--id");
if (nodeIdIndex < 0 || !nodeArgs[nodeIdIndex + 1]) throw new Error("node arguments require --id");
const nodeId = nodeArgs[nodeIdIndex + 1]!;
if (existsSync(pidFile)) {
  try { const old = JSON.parse(readFileSync(pidFile, "utf8")); process.kill(old.supervisorPid, 0); throw new Error(`supervisor already active pid=${old.supervisorPid}`); } catch (e) { if (e instanceof Error && e.message.startsWith("supervisor already")) throw e; rmSync(pidFile, { force: true }); }
}
writeFileSync(pidFile, JSON.stringify({ schemaVersion: 1, nodeId, launchId, supervisorPid: process.pid, startedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
let stopping = false; let child: Bun.Subprocess | undefined;
function stop(): void { stopping = true; child?.kill("SIGTERM"); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
try {
  while (!stopping) {
    child = Bun.spawn([process.execPath, new URL("./node.ts", import.meta.url).pathname, ...nodeArgs], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    const code = await child.exited; child = undefined;
    if (!stopping) { console.error(`[tiny-moe supervisor ${nodeId}] worker exited ${code}; restarting`); await Bun.sleep(100); }
  }
} finally { if (child) { child.kill("SIGTERM"); await child.exited.catch(() => {}); } rmSync(pidFile, { force: true }); }
