import type { DeploymentManager } from "./deployments.ts";
import type { Registry } from "./registry.ts";
import { importPublicJwk, signObject, verifyObject } from "../protocol/sign.ts";
import { BodyTooLargeError, readBoundedText } from "../protocol/bounded-body.ts";

export function createUpdateLeaseHandler(reg: Registry, deployments: DeploymentManager, privateKey: () => Promise<CryptoKey>) {
  const seen = new Map<string, number>();
  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    if (Number(req.headers.get("content-length")) > 4096) return new Response(null, { status: 413 });
    if (!req.body) return new Response(null, { status: 400 });
    let b;
    try { b = JSON.parse(await readBoundedText(req.body, 4096)); }
    catch (error) { return new Response(null, { status: error instanceof BodyTooLargeError ? 413 : 400 }); }
    const now = Date.now();
    if (!b || b.kind !== "swarmlet-update-lease" || !["acquire", "release"].includes(b.action) ||
        typeof b.nodeId !== "string" || typeof b.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(b.nonce) ||
        !Number.isSafeInteger(b.time) || Math.abs(b.time - now) > 30_000 ||
        (b.action === "release" && (typeof b.token !== "string" || b.token.length !== 36))) return new Response(null, { status: 400 });
    const node = reg.getNode(b.nodeId);
    if (!node || !await verifyObject(b, await importPublicJwk(node.pubJwk))) return new Response(null, { status: 401 });
    for (const [nonce, expiry] of seen) if (expiry <= now) seen.delete(nonce);
    const nonceKey = `${b.nodeId}:${b.nonce}`;
    if (seen.has(nonceKey)) return new Response(null, { status: 409 });
    if (seen.size >= 10_000) return new Response(null, { status: 503 });
    // Load the signing key before granting a lease, so a broken key cannot withdraw routes.
    const key = await privateKey();
    if (seen.has(nonceKey) || Math.abs(b.time - Date.now()) > 30_000) return new Response(null, { status: 409 });
    seen.set(nonceKey, now + 60_000);
    const lease = b.action === "acquire" ? deployments.acquireUpdate(b.nodeId) : null;
    const released = b.action === "release" ? deployments.releaseUpdate(b.nodeId, b.token) : false;
    return Response.json(await signObject({ kind: "swarmlet-update-lease-result", nonce: b.nonce, nodeId: b.nodeId, lease, released }, key), { headers: { "cache-control": "no-store" } });
  };
}
