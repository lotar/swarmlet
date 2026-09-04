// Enrollment: a node presents a one-time join code plus its public key and cert fingerprint, signed
// with its own key. Control checks the signature against the presented key (proves possession),
// checks the node id is derived from that key, consumes the code, and records the identity.

import { importPublicJwk, nodeIdFromJwk, normalizeFingerprint, verifyObject } from "../protocol/sign.ts";
import type { Capabilities, EnrollRequest } from "../protocol/types.ts";
import type { Registry } from "./registry.ts";

export type EnrollOutcome = { ok: true; nodeId: string } | { ok: false; status: number; error: string };

export async function handleEnroll(reg: Registry, body: unknown): Promise<EnrollOutcome> {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "body must be an object" };
  const req = body as Partial<EnrollRequest>;
  if (typeof req.code !== "string" || typeof req.nodeId !== "string" || !req.pubJwk || typeof req.certFp !== "string" || typeof req.hostname !== "string" || !req.caps) {
    return { ok: false, status: 400, error: "needs code, nodeId, pubJwk, certFp, hostname, caps" };
  }
  let certFp: string;
  try { certFp = normalizeFingerprint(req.certFp); } catch (e) { return { ok: false, status: 400, error: (e as Error).message }; }
  let pub: CryptoKey;
  try { pub = await importPublicJwk(req.pubJwk); } catch { return { ok: false, status: 400, error: "pubJwk is not an Ed25519 public JWK" }; }
  if ((await nodeIdFromJwk(req.pubJwk)) !== req.nodeId) return { ok: false, status: 400, error: "nodeId does not match pubJwk" };
  if (!(await verifyObject(req as EnrollRequest, pub))) return { ok: false, status: 401, error: "bad signature" };
  const existing = reg.getNode(req.nodeId);
  const refused = reg.consumeJoinCode(req.code, req.nodeId);
  if (refused && !(existing && existing.certFp === certFp)) return { ok: false, status: 403, error: refused };
  const caps = req.caps as Capabilities;
  reg.upsertNode({ id: req.nodeId, pubJwk: req.pubJwk, certFp, hostname: req.hostname, os: caps.os ?? "linux", arch: caps.arch ?? "x64", caps });
  reg.event("enroll", `${req.hostname} enrolled as ${req.nodeId}${existing ? " (re-enrolled)" : ""}`, { nodeId: req.nodeId });
  return { ok: true, nodeId: req.nodeId };
}
