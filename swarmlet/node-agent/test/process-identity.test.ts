import { expect, test } from "bun:test";
import { processIdentity, stopRecordedProcess } from "../roles/identity.ts";

const owned = { started: "today", command: "/engine/llama-server --port 123" };
test("process identity reads this unit test process without signalling it", () => {
  expect(processIdentity(process.pid)?.command).toContain("bun");
});
test("reused PID is never signalled", async () => {
  const signals: string[] = [];
  await stopRecordedProcess(123, owned, { identify: () => ({ ...owned, started: "later" }), signal: (_, s) => { signals.push(s); }, sleep: async () => {}, now: () => 0 });
  expect(signals).toEqual([]);
});
test("legacy alive PID fails closed without any signal", async () => {
  const signals: string[] = [];
  expect(stopRecordedProcess(123, undefined, { identify: () => owned, signal: (_, s) => { signals.push(s); }, sleep: async () => {}, now: () => 0 })).rejects.toThrow("without recorded identity");
  expect(signals).toEqual([]);
});
test("cleanup waits for TERM completion rather than immediately forgetting PID", async () => {
  let ticks = 0;
  const signals: string[] = [];
  await stopRecordedProcess(123, owned, { identify: () => ticks < 3 ? owned : null, signal: (_, s) => { signals.push(s); }, sleep: async () => { ticks++; }, now: () => ticks * 100 });
  expect(ticks).toBe(3);
  expect(signals).toEqual(["SIGTERM"]);
});
test("PID reuse during TERM wait cannot trigger KILL of new process", async () => {
  let ticks = 0;
  const signals: string[] = [];
  await stopRecordedProcess(123, owned, { identify: () => ticks ? { ...owned, started: "later", command: "unrelated" } : owned, signal: (_, s) => { signals.push(s); }, sleep: async () => { ticks++; }, now: () => ticks * 10001 });
  expect(signals).toEqual(["SIGTERM"]);
});
test("Linux exec preserves birth identity across systemd-run launcher", async () => {
  let ticks = 0;
  const signals: string[] = [];
  await stopRecordedProcess(123, { ...owned, birthId: "boot:123", command: "systemd-run --scope -- /engine/llama-server" }, {
    identify: () => ticks ? null : { ...owned, birthId: "boot:123" }, signal: (_, s) => { signals.push(s); }, sleep: async () => { ticks++; }, now: () => ticks,
  });
  expect(signals).toEqual(["SIGTERM"]);
});
