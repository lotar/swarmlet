import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../ui/app.js", import.meta.url), "utf8");
function fixture() {
  const doc = { hidden: true };
  const state = { authed: true, active: "nodes", drawer: {} };
  const streams: { closed: boolean; close(): void }[] = [];
  class EventSource {
    closed = false;
    constructor() { streams.push(this); }
    close() { this.closed = true; }
  }
  let loads = 0;
  let load: () => Promise<unknown> = () => Promise.resolve();
  const loadNodes = () => { loads++; return load(); };
  const liveSource = source.slice(source.indexOf("  var live ="), source.indexOf("  var booting ="));
  const resumeSource = source.slice(source.indexOf("  function resumeView()"), source.indexOf("  D.addEventListener('visibilitychange'"));
  const f = new Function("D", "state", "window", "EventSource", "loadNodes", "loadDeployments", "renderJoinCode", "$", "showError", "boot", liveSource + resumeSource + "return {tick, startLive, stopLive, resumeView};")(
    doc, state, { EventSource }, EventSource, loadNodes, () => Promise.resolve(), () => {}, () => ({}), () => {}, () => {},
  );
  return { ...f, doc, state, streams, loads: () => loads, setLoad: (fn: () => Promise<unknown>) => { load = fn; } };
}
test("hidden tabs release SSE and pause polling; returning resumes one stream", async () => {
  const f = fixture();
  await f.tick(); f.startLive();
  expect(f.streams).toHaveLength(0); expect(f.loads()).toBe(0);
  f.doc.hidden = false; await f.tick(); await f.tick();
  expect(f.streams).toHaveLength(1);
  f.doc.hidden = true; f.resumeView();
  expect(f.streams[0].closed).toBe(true);
  const before = f.loads(); await f.tick(); expect(f.loads()).toBe(before);
  f.doc.hidden = false; await f.tick(); expect(f.streams).toHaveLength(2);
  f.stopLive(); expect(f.streams[1].closed).toBe(true);
});
test("slow refreshes cannot accumulate and failure permits a later retry", async () => {
  const f = fixture(); f.doc.hidden = false;
  let reject!: (e: Error) => void;
  f.setLoad(() => new Promise((_, r) => { reject = r; }));
  const pending = f.tick(); await Promise.resolve();
  await f.tick(); await f.tick(); expect(f.loads()).toBe(1);
  reject(new Error("network failed")); await pending;
  f.setLoad(() => Promise.resolve()); await f.tick(); expect(f.loads()).toBe(2);
});
test("GET timeout cancels a stuck request; writes have no automatic abort", async () => {
  const apiSource = source.slice(source.indexOf("  function api("), source.indexOf("  function showLogin()"));
  let expire!: () => void;
  let cleared = 0;
  let signal: AbortSignal | undefined;
  const api = new Function("fetch", "setTimeout", "clearTimeout", apiSource + "return api;")(
    (_: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      if (!signal) return Promise.resolve(new Response("{}"));
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }, (fn: () => void) => { expire = fn; return 1; }, () => { cleared++; },
  );
  const pending = api("GET", "/api/nodes"); expire();
  await expect(pending).rejects.toThrow("Request timed out");
  expect(signal?.aborted).toBe(true); expect(cleared).toBe(1);
  await api("POST", "/api/deployments", {}); expect(signal).toBeUndefined();
});
