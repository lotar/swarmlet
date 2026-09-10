import { importPublicJwk, signObject, verifyObject } from "../protocol/sign.ts";
import type { Identity } from "./identity.ts";
import { readBoundedText } from "../protocol/bounded-body.ts";

export interface UpdateLease { nodeId: string; token: string; expiresAt: number }

export async function requestUpdateLease(opts: {
  controlUrl: string; pinnedKey: JsonWebKey; identity: Identity; token?: string;
}): Promise<UpdateLease | null> {
  const nonce = crypto.randomUUID();
  const body = await signObject({ kind: "swarmlet-update-lease", action: opts.token ? "release" : "acquire",
    nodeId: opts.identity.nodeId, nonce, time: Date.now(), ...(opts.token ? { token: opts.token } : {}),
  }, opts.identity.keys.priv);
  const response = await fetch(new URL("/node-update-lease", opts.controlUrl), { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`update coordination HTTP ${response.status}`); }
  const raw = await readBoundedText(response.body, 4096);
  const value = JSON.parse(raw);
  if (!value || !await verifyObject(value, await importPublicJwk(opts.pinnedKey)) ||
      value.kind !== "swarmlet-update-lease-result" || value.nonce !== nonce || value.nodeId !== opts.identity.nodeId) throw new Error("invalid update coordination signature");
  if (opts.token || value.lease === null) return null;
  const lease = value.lease as UpdateLease;
  if (!lease || lease.nodeId !== opts.identity.nodeId || typeof lease.token !== "string" || !/^[a-f0-9-]{36}$/.test(lease.token) ||
      !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt < Date.now() + 30_000 || lease.expiresAt > Date.now() + 125_000) throw new Error("invalid update lease");
  return lease;
}
