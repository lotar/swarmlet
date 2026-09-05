#!/usr/bin/env bun
// Compile once per OS; the service and desktop package consume this exact artifact.
// bun run node-agent/build.ts [darwin] [linux] (default: both)
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["darwin", "linux"];
const bunTarget: Record<string, string> = { darwin: "bun-darwin-arm64", linux: "bun-linux-x64" };
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "unknown";
};
const revision = process.env.SWARMLET_BUILD_REVISION ?? `${git("rev-parse", "HEAD")}${git("status", "--porcelain", "--untracked-files=no") ? "-dirty" : ""}`;
for (const t of targets) {
  const bt = bunTarget[t];
  if (!bt) throw new Error(`unknown target ${t}`);
  const out = join(ROOT, "dist", "agent", t);
  mkdirSync(out, { recursive: true });
  const bin = join(out, "swarmlet-node");
  console.log(`compiling ${t} -> ${bin}`);
  const p = Bun.spawn(["bun", "build", "--compile", "--minify", `--target=${bt}`, join(ROOT, "node-agent", "main.ts"), "--outfile", bin], { stdout: "inherit", stderr: "inherit", cwd: ROOT });
  if ((await p.exited) !== 0) throw new Error(`compile failed for ${t}`);
  const sha256 = createHash("sha256").update(readFileSync(bin)).digest("hex");
  writeFileSync(join(out, "agent-build.json"), JSON.stringify({ revision, target: bt, bun: Bun.version, sha256, builtAt: new Date().toISOString() }, null, 2) + "\n");
  const engine = process.env.SWARMLET_ENGINE_DIST || join(ROOT, "engine", "dist", t);
  // Clear old engine files even when this build has no engine: never silently ship stale ones.
  rmSync(join(out, "engine"), { recursive: true, force: true });
  if (existsSync(engine)) { cpSync(engine, join(out, "engine"), { recursive: true }); console.log(`engine copied from ${engine}`); }
  else console.log(`note: no engine dist for ${t} (build it with engine/build.sh ${t})`);
}
