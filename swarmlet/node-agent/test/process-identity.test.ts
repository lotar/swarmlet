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

test("changed command before TERM remains ambiguous and receives no signal", async () => {
  const signals: string[] = [];
  await expect(stopRecordedProcess(123, owned, {
    identify: () => ({ ...owned, command: "unrelated" }), signal: (_, s) => { signals.push(s); }, sleep: async () => {}, now: () => 0,
  })).rejects.toThrow("ownership is ambiguous");
  expect(signals).toEqual([]);
});

test("transient command change after TERM waits for exit without another signal", async () => {
  let ticks = 0, signalled = false;
  const signals: string[] = [];
  await stopRecordedProcess(123, owned, {
    identify: () => !signalled ? owned : ticks < 2 ? { ...owned, command: "(bun)" } : null,
    signal: (_, s) => { signals.push(s); signalled = true; }, sleep: async () => { ticks++; }, now: () => ticks * 100,
  });
  expect(ticks).toBe(2);
  expect(signals).toEqual(["SIGTERM"]);
});

test("persistent ambiguity after TERM fails closed without KILL", async () => {
  let ticks = 0, signalled = false;
  const signals: string[] = [];
  await expect(stopRecordedProcess(123, owned, {
    identify: () => signalled ? { ...owned, command: "unrelated" } : owned,
    signal: (_, s) => { signals.push(s); signalled = true; }, sleep: async () => { ticks++; }, now: () => ticks * 1000,
  })).rejects.toThrow("ownership is ambiguous");
  expect(ticks).toBe(10);
  expect(signals).toEqual(["SIGTERM"]);
});

test("post-TERM ambiguity followed by PID reuse never signals the replacement", async () => {
  let ticks = 0, signalled = false;
  const signals: string[] = [];
  await stopRecordedProcess(123, owned, {
    identify: () => !signalled ? owned : ticks ? { ...owned, started: "later" } : { ...owned, command: "(bun)" },
    signal: (_, s) => { signals.push(s); signalled = true; }, sleep: async () => { ticks++; }, now: () => ticks * 100,
  });
  expect(signals).toEqual(["SIGTERM"]);
});

test("same owned command returning after ambiguity cannot reauthorize KILL", async () => {
  let ticks = 0, signalled = false;
  const signals: string[] = [];
  await expect(stopRecordedProcess(123, owned, {
    identify: () => signalled && !ticks ? { ...owned, command: "(bun)" } : owned,
    signal: (_, s) => { signals.push(s); signalled = true; }, sleep: async () => { ticks++; }, now: () => ticks * 1000,
  })).rejects.toThrow("ownership is ambiguous");
  expect(signals).toEqual(["SIGTERM"]);
});

test("confirmed owned process receives KILL after TERM deadline, then waits through exit ambiguity", async () => {
  let ticks = 0, killedAt: number | undefined;
  const signals: string[] = [];
  await stopRecordedProcess(123, owned, {
    identify: () => killedAt === undefined ? owned : ticks === killedAt ? { ...owned, command: "(bun)" } : null,
    signal: (_, s) => { signals.push(s); if (s === "SIGKILL") killedAt = ticks; },
    sleep: async () => { ticks++; }, now: () => ticks * 1000,
  });
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(ticks).toBe(11);
});

test("failed TERM delivery does not authorize waiting through ambiguous ownership", async () => {
  let attempted = false;
  const signals: string[] = [];
  await expect(stopRecordedProcess(123, owned, {
    identify: () => attempted ? { ...owned, command: "unrelated" } : owned,
    signal: (_, s) => { signals.push(s); attempted = true; throw new Error("signal failed"); },
    sleep: async () => { throw new Error("must not wait"); }, now: () => 0,
  })).rejects.toThrow("ownership is ambiguous");
  expect(signals).toEqual(["SIGTERM"]);
});
