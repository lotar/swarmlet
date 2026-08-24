// Smoke test: L0Client against the deterministic mock server + signing utils.
// Proves the L0 contract works end-to-end without the real model.

import { afterAll, describe, expect, test } from "bun:test";
import { HttpL0Client } from "../core/l0.ts";
import { mockContent, startMockServer, type MockServerHandle } from "../core/mock.ts";
import { canonicalize, ensureKeys, signObject, verifyObject } from "../core/sign.ts";
import type { GateCertificate } from "../core/types.ts";

let server: MockServerHandle;

describe("L0 contract", () => {
  server = startMockServer({ seed: 42 });

  const client = new HttpL0Client(
    {
      baseModel: {
        name: "mock-model",
        quantization: "Q8_0",
        moe: true,
        activeParamsB: 1.3,
        totalParamsB: 6.9,
        ggufPath: "../models/mock.gguf",
        contextLength: 8192,
      },
      llamaServer: { host: "127.0.0.1", port: 0 },
      mesh: { nodeCount: 3, nodePorts: [9201, 9202, 9203] },
      suiteSeed: 20260807,
      paths: { knowledge: "knowledge", data: "data", gates: "gates" },
    },
    server.url,
  );

  test("endpoint is healthy", async () => {
    expect(await client.healthy()).toBe(true);
  });

  test("chat returns valid JSON and is deterministic", async () => {
    const msgs = [
      { role: "system" as const, content: "You answer in JSON." },
      { role: "user" as const, content: "What is the capital of Croatia?" },
    ];
    const a = await client.chat(msgs, { seed: 7 });
    const b = await client.chat(msgs, { seed: 7 });
    expect(a).toBe(b); // determinism
    const parsed: unknown = JSON.parse(a);
    expect(typeof parsed).toBe("object");
    // matches the exported pure function — no hidden state in the server
    expect(a).toBe(mockContent(7, msgs));
  });

  test("different inputs yield different answers", async () => {
    const x = await client.chat([{ role: "user", content: "prompt one" }]);
    const y = await client.chat([{ role: "user", content: "prompt two" }]);
    expect(x).not.toBe(y);
  });

  test("manifest merges config with live probe", async () => {
    const m = await client.manifest();
    expect(m.name).toBe("mock-model"); // refined by /v1/models probe
    expect(m.moe).toBe(true); // capability fields owned by config
    expect(m.quantization).toBe("Q8_0");
    expect(m.contextLength).toBe(8192);
    expect(m.endpoint).toBe(server.url);
  });

  test("request counter tracks completions served", () => {
    expect(server.requestCount()).toBeGreaterThanOrEqual(4);
  });

  afterAll(() => {
    server.stop();
  });
});

describe("signing (canonical JSON + ed25519)", () => {
  const keyDir = "data/test-keys";

  test("canonicalize sorts keys recursively and stably", () => {
    const a = canonicalize({ b: 1, a: { d: [3, 1], c: 2 } });
    const b = canonicalize({ a: { c: 2, d: [3, 1] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":2,"d":[3,1]},"b":1}');
  });

  test("sign/verify round-trip; tampering breaks it", async () => {
    const { priv, pub } = await ensureKeys(keyDir);

    const cert: GateCertificate = {
      id: "gate-001",
      date: "2026-08-24T03:00:00.000Z",
      knowledgeSha: "abc123",
      baseModel: "OLMoE-1B-7B-0125-Instruct",
      suiteSeed: 20260807,
      instanceCount: 500,
      oldScore: 0.61,
      newScore: 0.66,
      decision: "accept",
    };
    const signed = await signObject(cert, priv);
    expect(signed.signature).toBeTruthy();
    expect(await verifyObject(signed, pub)).toBe(true);

    // any payload mutation must invalidate the signature
    const tampered = { ...signed, newScore: 0.99 };
    expect(await verifyObject(tampered, pub)).toBe(false);
    expect(signed.newScore).toBe(0.66); // original untouched
  });

  test("keys are persisted and reload to the same identity", async () => {
    const first = await ensureKeys(keyDir);
    const msg = [{ role: "user" as const, content: "probe" }];
    const sig = await signObject({ note: msg[0]?.content }, first.priv);
    const second = await ensureKeys(keyDir); // loads same files
    expect(await verifyObject(sig, second.pub)).toBe(true);
  });
});
