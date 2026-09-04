// Identity primitives for the mesh. The Ed25519 + canonical-JSON implementation is the harness's
// (sin-harness/core/sign.ts); this module only re-exports it and adds the id/fingerprint helpers the
// node agent and the control plane share. Do not fork sign.ts.

export {
  canonicalize,
  ensureKeys,
  signObject,
  verifyObject,
  type KeyMaterial,
} from "../../sin-harness/core/sign.ts";
import { canonicalize } from "../../sin-harness/core/sign.ts";

const encoder = new TextEncoder();

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable node identity: first 16 hex chars of SHA-256 over the canonical public JWK. */
export async function nodeIdFromJwk(pubJwk: JsonWebKey): Promise<string> {
  return (await sha256Hex(canonicalize(pubJwk))).slice(0, 16);
}

/** Normalize a certificate fingerprint ("AA:BB:..." or hex) to lowercase hex without separators. */
export function normalizeFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (hex.length !== 64) throw new Error(`fingerprint is not SHA-256 (${hex.length} hex chars)`);
  return hex;
}

/** SHA-256 fingerprint of a DER certificate, lowercase hex. */
export async function fingerprintDer(der: Uint8Array): Promise<string> {
  return sha256Hex(der);
}

export async function importPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, true, ["verify"]);
}

/** The public JWK ensureKeys() persisted next to the private key (keys loaded from disk are not extractable). */
export async function readPublicJwk(dir: string): Promise<JsonWebKey> {
  const abs = dir.startsWith("/") ? dir : `${process.cwd()}/${dir}`;
  return (await Bun.file(`${abs}/public.jwk.json`).json()) as JsonWebKey;
}

export { sha256Hex };
