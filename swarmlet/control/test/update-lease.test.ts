import { expect, test } from "bun:test";
import { Registry } from "../registry.ts";
import { DeploymentManager } from "../deployments.ts";
import type { AgentChannel } from "../channel.ts";
import { createUpdateLeaseHandler } from "../update-lease.ts";
import { signObject, verifyObject } from "../../protocol/sign.ts";

test("update coordination binds requests to enrolled identities and signs nonce-bound grants", async () => {
  const node = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const control = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const reg = new Registry(":memory:");
  reg.upsertNode({ id: "node1", pubJwk: await crypto.subtle.exportKey("jwk", node.publicKey), certFp: "fp", hostname: "one", os: "linux", arch: "x64" });
  const manager = new DeploymentManager({ reg, channel: { isOnline: () => true } as unknown as AgentChannel, profiles: new Map(), log: { debug() {}, info() {}, warn() {}, error() {} } });
  const handle = createUpdateLeaseHandler(reg, manager, async () => control.privateKey);
  const payload = { kind: "swarmlet-update-lease", action: "acquire", nodeId: "node1", time: Date.now(), nonce: crypto.randomUUID() };
  const body = await signObject(payload, node.privateKey);
  const request = (value: unknown) => new Request("http://localhost/node-update-lease", { method: "POST", body: JSON.stringify(value) });
  try {
    expect((await handle(request({ ...body, nodeId: "another" }))).status).toBe(401);
    expect((await handle(request({ ...body, action: "release", token: crypto.randomUUID() }))).status).toBe(401);
    const response = await handle(request(body));
    expect(response.status).toBe(200);
    const grant = await response.json();
    expect(await verifyObject(grant, control.publicKey)).toBe(true);
    expect(grant.nonce).toBe(body.nonce);
    expect(grant.lease.nodeId).toBe("node1");
    expect((await handle(request(body))).status).toBe(409);
    const release = await signObject({ ...payload, action: "release", token: grant.lease.token, nonce: crypto.randomUUID() }, node.privateKey);
    expect((await (await handle(request(release))).json()).released).toBe(true);
    expect((await handle(request(await signObject({ ...payload, nonce: crypto.randomUUID(), time: Date.now() - 60_000 }, node.privateKey)))).status).toBe(400);
    expect((await handle(new Request("http://localhost/node-update-lease", { method: "POST", body: " ".repeat(4097) }))).status).toBe(413);
  } finally { manager.dispose(); reg.close(); }
});
