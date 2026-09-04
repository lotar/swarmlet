import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, ensureKeys, nodeIdFromJwk, normalizeFingerprint, readPublicJwk, signObject, verifyObject } from "../sign.ts";
import { bridge, decodeFrame, encodeFrame, OP_DATA, OP_OPEN, StreamMux, type MuxStream } from "../frame.ts";
import { parseAgentMessage, parseControlMessage, validateAssignment, validateOffer } from "../validate.ts";
import type { Capabilities } from "../types.ts";

const caps: Capabilities = {
  os: "linux", arch: "x64", hostname: "legion", ramMiB: 16000, ramReserveMiB: 4096, cpuCores: 12,
  gpus: [{ id: "cuda:0", name: "GTX 1650 Ti", backend: "cuda", engineName: "CUDA0", totalMiB: 4096 }],
  diskFreeMiB: 300000, privateIps: ["192.168.1.243"], measuredAt: "2026-09-04T00:00:00Z",
};

describe("identity", () => {
  test("sign/verify round trip and stable node id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "swarmlet-keys-"));
    const k = await ensureKeys(dir);
    const pub = await readPublicJwk(dir);
    const id1 = await nodeIdFromJwk(pub);
    const again = await ensureKeys(dir);
    expect(await verifyObject(await signObject({ x: 1 }, again.priv), k.pub)).toBe(true);
    expect(await nodeIdFromJwk(await readPublicJwk(dir))).toBe(id1);
    expect(id1).toMatch(/^[0-9a-f]{16}$/);
    const signed = await signObject({ nodeId: id1, nonce: "abc" }, k.priv);
    expect(await verifyObject(signed, k.pub)).toBe(true);
    expect(await verifyObject({ ...signed, nonce: "abd" } as typeof signed, k.pub)).toBe(false);
    expect(canonicalize({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe('{"a":[2,{"c":0,"d":1}],"b":1}');
  });
  test("fingerprint normalization", () => {
    const colon = Array.from({ length: 32 }, () => "AB").join(":");
    expect(normalizeFingerprint(colon)).toBe("ab".repeat(32));
    expect(() => normalizeFingerprint("abcd")).toThrow();
  });
});

describe("offer validation", () => {
  const good = { enabled: true, roles: { worker: true, coordinator: false, replica: false }, gpu: [{ id: "cuda:0", memMiB: 3072 }], ramMiB: 8192, cpuCores: 6, diskMiB: 50000, modelsDir: "/home/lotar/models" };
  test("accepts a sane offer", () => {
    const r = validateOffer(good, caps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.gpu[0]?.memMiB).toBe(3072);
  });
  test("rejects over-allocation with reasons", () => {
    const r = validateOffer({ ...good, ramMiB: 15000, cpuCores: 13, gpu: [{ id: "cuda:0", memMiB: 5000 }, { id: "cuda:9", memMiB: 1 }] }, caps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("ramMiB 15000 exceeds 11904"))).toBe(true);
      expect(r.errors.some((e) => e.includes("cpuCores 13 exceeds 12"))).toBe(true);
      expect(r.errors.some((e) => e.includes("exceeds device total 4096"))).toBe(true);
      expect(r.errors.some((e) => e.includes("cuda:9 not present"))).toBe(true);
    }
  });
  test("worker with nothing to give is an error", () => {
    const r = validateOffer({ ...good, gpu: [{ id: "cuda:0", memMiB: 0 }], ramMiB: 0 }, caps);
    expect(r.ok).toBe(false);
  });
});

describe("messages", () => {
  test("agent and control message guards", () => {
    expect(parseAgentMessage(JSON.stringify({ t: "heartbeat", ts: "x", metrics: {} })).ok).toBe(true);
    expect(parseAgentMessage(JSON.stringify({ t: "heartbeat" })).ok).toBe(false);
    expect(parseAgentMessage("nope").ok).toBe(false);
    expect(parseControlMessage(JSON.stringify({ t: "challenge", nonce: "n" })).ok).toBe(true);
    expect(parseControlMessage(JSON.stringify({ t: "assign", assignment: { kind: "stop", id: "a", deploymentId: "d" } })).ok).toBe(true);
    expect(parseControlMessage(JSON.stringify({ t: "assign", assignment: { kind: "worker", id: "a", deploymentId: "d" } })).ok).toBe(false);
  });
  test("assignment validation catches shape errors", () => {
    const fp = "a".repeat(64);
    const ok = validateAssignment({ kind: "worker", id: "w1", deploymentId: "d1", port: 50200, device: "CUDA0", threads: 4, memCapMiB: 3000, allow: [fp],
      peers: [{ index: 1, endpoint: { nodeId: "n2", certFp: fp, port: 50201, direct: [{ host: "192.168.1.220", port: 47801 }], relay: true } }] });
    expect(ok.ok).toBe(true);
    const bad = validateAssignment({ kind: "coordinator", id: "c", deploymentId: "d", model: { path: "/m.gguf" }, rpc: [], devices: ["RPC0", "MTL0"], tensorSplit: [1], ctx: 1536, parallel: 3, env: {}, extraArgs: [], port: 8096, allow: ["zz"] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join("\n")).toContain("lengths differ");
  });
});

describe("stream mux", () => {
  test("frame encode/decode", () => {
    const f = decodeFrame(encodeFrame(7, OP_DATA, new Uint8Array([1, 2, 3])));
    expect(f.streamId).toBe(7);
    expect(f.op).toBe(OP_DATA);
    expect([...f.payload]).toEqual([1, 2, 3]);
    expect(decodeFrame(encodeFrame(0xfffffffe, OP_OPEN)).streamId).toBe(0xfffffffe);
    expect(() => decodeFrame(new Uint8Array([0, 0, 0, 1, 9]))).toThrow();
  });

  test("10 MB relayed through two bridged muxes arrives bit-exact", async () => {
    // topology: A <-> control(left) | control(right) <-> B ; control bridges its two streams.
    const link = (from: { push: (f: Uint8Array) => void }, name: string) => (f: Uint8Array) => queueMicrotask(() => from.push(f));
    let muxA!: StreamMux, muxCL!: StreamMux, muxCR!: StreamMux, muxB!: StreamMux;
    const received: Uint8Array[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const pendingRight = new Map<string, MuxStream>();
    muxB = new StreamMux((f) => queueMicrotask(() => muxCR.handleFrame(f)), (s) => {
      s.onData((c) => received.push(c.slice())).onEnd(() => done());
    }, 0);
    muxCR = new StreamMux((f) => queueMicrotask(() => muxB.handleFrame(f)), () => false, 1);
    muxCL = new StreamMux((f) => queueMicrotask(() => muxA.handleFrame(f)), (left) => {
      if (left.header.kind !== "relay") return false;
      const right = muxCR.open({ kind: "data", port: left.header.port, from: left.header.from });
      pendingRight.set(left.header.target, right);
      bridge(left, right);
    }, 0);
    muxA = new StreamMux((f) => queueMicrotask(() => muxCL.handleFrame(f)), () => false, 1);
    void link;
    const payload = new Uint8Array(10 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + (i >> 8)) & 0xff;
    const s = muxA.open({ kind: "relay", target: "nodeB", port: 50200, from: "nodeA" });
    for (let off = 0; off < payload.length; off += 65536) s.write(payload.subarray(off, off + 65536));
    s.close();
    await finished;
    const got = new Uint8Array(received.reduce((n, c) => n + c.length, 0));
    let o = 0; for (const c of received) { got.set(c, o); o += c.length; }
    expect(got.length).toBe(payload.length);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(payload))).toBe(0);
    expect(muxA.openStreams).toBe(0);
    expect(muxB.openStreams).toBe(0);
  });

  test("rejected open closes the stream on the initiator", async () => {
    let peer!: StreamMux;
    const me = new StreamMux((f) => queueMicrotask(() => peer.handleFrame(f)), () => false, 1);
    peer = new StreamMux((f) => queueMicrotask(() => me.handleFrame(f)), () => false, 0);
    const s = me.open({ kind: "http", port: 1 });
    const reason = await new Promise<string | undefined>((r) => s.onEnd(r));
    expect(reason).toBe("rejected");
  });
});
