#!/usr/bin/env bun
// Compile the node agent into single-file binaries for both platforms.
//   bun run node-agent/build.ts [darwin] [linux]      (default: both)
// Output: swarmlet/dist/agent/<target>/swarmlet-node (+ engine/ copied from engine/dist/<target> when present).

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["darwin", "linux"];
const bunTarget: Record<string, string> = { darwin: "bun-darwin-arm64", linux: "bun-linux-x64" };

for (const t of targets) {
  const bt = bunTarget[t];
  if (!bt) throw new Error(`unknown target ${t}`);
  const out = join(ROOT, "dist", "agent", t);
  mkdirSync(out, { recursive: true });
  const bin = join(out, "swarmlet-node");
  console.log(`compiling ${t} -> ${bin}`);
  const p = Bun.spawn(["bun", "build", "--compile", "--minify", `--target=${bt}`, join(ROOT, "node-agent", "main.ts"), "--outfile", bin], { stdout: "inherit", stderr: "inherit", cwd: ROOT });
  if ((await p.exited) !== 0) throw new Error(`compile failed for ${t}`);
  const engine = join(ROOT, "engine", "dist", t);
  if (existsSync(engine)) { cpSync(engine, join(out, "engine"), { recursive: true }); console.log(`engine copied from ${engine}`); }
  else console.log(`note: no engine dist for ${t} (build it with engine/build.sh ${t})`);
}
