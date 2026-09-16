#!/usr/bin/env bun
// engine-churn - how often does this node stop and restart a serving engine, and why?
//
// Why this exists: a serving node can be perfectly healthy at any instant and still be useless, because
// the thing that matters is how often the engine is STOPPED. Reloading a 27B model takes 1-5 minutes, so
// every restart is an outage for whoever is mid-request. On 2026-09-16 this ran unnoticed for hours: the
// node agent log shows ~15 graceful engine restarts between 06:00Z and 08:45Z, plus two SIGABRTs, and
// nothing on the box reported it. This tool reports it.
//
// Read-only by construction: it parses a log file and can optionally ask the control plane (GET only).
//
// Usage:
//   engine-churn.mjs [--log <path>] [--json] [--max-restarts-per-hour <n>] [--since <ISO|-Nh>]
// Exit: 0 clean, 2 churn above threshold or any ungraceful exit, 1 bad input.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
if (flag("--help") || flag("-h")) {
  console.log(`engine-churn - detect engine restart churn on a serving node

  --log <path>                log to read (default ~/.swarmlet/logs/agent.err.log)
  --json                      machine-readable output
  --max-restarts-per-hour <n> fail when the rate exceeds this (default 1)
  --since <ISO|-Nh>           only consider entries newer than this (e.g. -3h)
Exit codes: 0 clean, 2 churn, 1 bad input.`);
  process.exit(0);
}

const logPath = String(flag("--log", join(homedir(), ".swarmlet", "logs", "agent.err.log")));
const asJson = Boolean(flag("--json", false));
const maxPerHour = Number(flag("--max-restarts-per-hour", 1));
const sinceArg = flag("--since", undefined);
if (!Number.isFinite(maxPerHour) || maxPerHour < 0) { console.error(`engine-churn: --max-restarts-per-hour must be a number >= 0`); process.exit(1); }

let sinceMs = null;
if (typeof sinceArg === "string") {
  const rel = /^-(\d+(?:\.\d+)?)h$/.exec(sinceArg);
  if (rel) sinceMs = Date.now() - Number(rel[1]) * 3600_000;
  else {
    const t = Date.parse(sinceArg);
    if (Number.isNaN(t)) { console.error(`engine-churn: --since must be an ISO timestamp or -<hours>h`); process.exit(1); }
    sinceMs = t;
  }
}

let text, mtimeMs;
try { text = readFileSync(logPath, "utf8"); mtimeMs = statSync(logPath).mtimeMs; }
catch (e) { console.error(`engine-churn: cannot read ${logPath}: ${e.message}`); process.exit(1); }

// "[agent] replica-as-deadbeef: spawn {..}" / "coordinator-as-deadbeef: exited {..}"
const LIFECYCLE = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+\w+\s+\[agent\]\s+([a-z]+)-as-([0-9a-f]+):\s+(spawn|exited)\s+(\{.*)$/;
const FAILED = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+error\s+\[agent\]\s+assignment failed\s+(\{.*)$/;
// The node's Mac app updater fails its signature check every ~30s and says nothing about the engine.
const NOISE = /Mac app update failed|update deferred/;

const spawns = [];
const exits = [];
const failures = [];
// The log lines carry a time but no date, and the file may span days. Take the newest timestamp - the one
// the file ends on - as the file's own day (from its mtime), then walk the lines BACKWARDS, stepping the day
// back whenever the clock jumps forward. Anchoring on "today" instead would walk into the future.
const raw = [];
{
  let previous = null;
  for (const line of text.split("\n")) {
    const m = LIFECYCLE.exec(line) ?? FAILED.exec(line);
    if (!m) continue;
    const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    raw.push({ line, seconds, previous });
    previous = seconds;
  }
}
const dayMs = 86_400_000;
const days = [];
{
  let day = Math.floor((mtimeMs - new Date(mtimeMs).getUTCHours() * 3600_000) / dayMs);
  for (let i = raw.length - 1; i >= 0; i--) {
    days[i] = day;
    if (i > 0 && raw[i - 1].seconds > raw[i].seconds + 1) day -= 1;   // the clock jumped forward: an earlier day
  }
}

for (let i = 0; i < raw.length; i++) {
  const line = raw[i].line;
  if (NOISE.test(line)) continue;
  const dayIso = new Date(days[i] * dayMs).toISOString().slice(0, 10);
  const m = LIFECYCLE.exec(line);
  if (m) {
    const [, hh, mm, ss, ms, kind, id, event, json] = m;
    const at = Date.parse(`${dayIso}T${hh}:${mm}:${ss}.${ms}Z`);
    let body = {};
    try { body = JSON.parse(json); } catch { /* a truncated line is still a data point: the timestamp and event are real */ }
    if (event === "spawn") spawns.push({ at, kind, id, argv: body.argv ?? null });
    else exits.push({ at, kind, id, code: body.code ?? null, signal: body.signal ?? null, stopping: body.stopping ?? null });
    continue;
  }
  const f = FAILED.exec(line);
  if (f) {
    const [, hh, mm, ss, ms, json] = f;
    let body = {};
    try { body = JSON.parse(json); } catch { /* keep the line as text */ }
    failures.push({ at: Date.parse(`${dayIso}T${hh}:${mm}:${ss}.${ms}Z`), id: body.id ?? null, why: String(body.why ?? json).slice(0, 200) });
  }
}

const inWindow = (x) => sinceMs === null || x.at >= sinceMs;
const spawnsIn = spawns.filter(inWindow);
const exitsIn = exits.filter(inWindow);
const failuresIn = failures.filter(inWindow);

// A stop that was asked for (stopping:true, code 0) is a re-placement: still an outage, but planned.
const graceful = exitsIn.filter((e) => e.code === 0 && e.signal === null);
const ungraceful = exitsIn.filter((e) => !(e.code === 0 && e.signal === null) && e.stopping !== true);

const intervals = [];
for (let i = 1; i < spawnsIn.length; i++) intervals.push(spawnsIn[i].at - spawnsIn[i - 1].at);
const sorted = [...intervals].sort((a, b) => a - b);
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

// No engine serving at all: measured across every assignment, because a re-placement gets a new id on
// purpose (so per-id windows would always look like one clean restart).
const timeline = [...spawnsIn.map((s) => ({ at: s.at, up: true })), ...exitsIn.map((e) => ({ at: e.at, up: false }))].sort((a, b) => a.at - b.at);
let up = null, longestGapMs = 0, longestGapAt = null;
for (const ev of timeline) {
  if (ev.up) { if (up === false && longestGapAt !== null) { const gap = ev.at - longestGapAt; if (gap > longestGapMs) longestGapMs = gap; } up = true; }
  else { up = false; longestGapAt = ev.at; }
}

const first = spawnsIn[0]?.at ?? null, last = exitsIn.at(-1)?.at ?? spawnsIn.at(-1)?.at ?? null;
const hours = first !== null && last !== null ? Math.max((last - first) / 3600_000, 1 / 60) : 0;
const restartsPerHour = spawnsIn.length ? Number((spawnsIn.length / hours).toFixed(2)) : 0;

// Per-hour histogram of restarts, so a burst is visible instead of averaged away.
const perHour = {};
for (const s of spawnsIn) { const key = new Date(s.at).toISOString().slice(0, 13) + ":00Z"; perHour[key] = (perHour[key] ?? 0) + 1; }

// A rate needs a window long enough to be a rate: one restart in a two-minute slice is not "60/h", it is
// one restart in a quiet log. Short windows are judged on ungraceful exits alone.
const RATE_WINDOW_HOURS = 0.5;
const rateIsMeaningful = hours >= RATE_WINDOW_HOURS;
const verdict = ungraceful.length > 0 ? "ungraceful-exit" : (rateIsMeaningful && restartsPerHour > maxPerHour) ? "churn" : "clean";
const report = {
  log: logPath,
  window: { since: sinceMs === null ? null : new Date(sinceMs).toISOString(), from: first === null ? null : new Date(first).toISOString(), to: last === null ? null : new Date(last).toISOString(), hours: Number(hours.toFixed(2)) },
  spawns: spawnsIn.length,
  exits: exitsIn.length,
  gracefulExits: graceful.length,
  ungracefulExits: ungraceful.map((e) => ({ at: new Date(e.at).toISOString(), kind: e.kind, code: e.code, signal: e.signal, why: failuresIn.find((f) => String(f.id ?? "").replace(/^as-/, "") === e.id)?.why ?? null })),
  restartsPerHour,
  maxRestartsPerHour: maxPerHour,
  rateIsMeaningful,
  medianRestartSeconds: median === null ? null : Number((median / 1000).toFixed(1)),
  maxRestartSeconds: sorted.length ? Number((sorted.at(-1) / 1000).toFixed(1)) : null,
  longestNoEngineSeconds: Number((longestGapMs / 1000).toFixed(1)),
  perHour,
  assignmentFailures: failuresIn.map((f) => ({ at: new Date(f.at).toISOString(), why: f.why })),
  verdict,
};

if (asJson) { console.log(JSON.stringify(report, null, 2)); }
else {
  const t = (s) => (s === null ? "-" : s);
  console.log(`engine-churn  ${logPath}`);
  console.log(`  window          ${t(report.window.from)} .. ${t(report.window.to)}  (${report.window.hours} h)`);
  console.log(`  engine spawns   ${report.spawns}   (${report.restartsPerHour}/h, threshold ${maxPerHour}/h)`);
  console.log(`  exits           ${report.exits}  = ${report.gracefulExits} graceful + ${report.ungracefulExits.length} ungraceful`);
  console.log(`  restart spacing median ${t(report.medianRestartSeconds)}s, max ${t(report.maxRestartSeconds)}s`);
  console.log(`  longest with no engine running: ${report.longestNoEngineSeconds}s`);
  for (const [hour, n] of Object.entries(report.perHour)) if (n > 0) console.log(`    ${hour}  ${"#".repeat(Math.min(n, 40))} ${n}`);
  for (const e of report.ungracefulExits) console.log(`  UNGRACEFUL ${e.at} ${e.kind} code=${e.code} signal=${e.signal} :: ${(e.why ?? "").slice(0, 140)}`);
  console.log(`  verdict: ${verdict}${verdict === "clean" ? "" : "  <- every restart is an outage for whoever is mid-request"}`);
}
process.exit(verdict === "clean" ? 0 : 2);
