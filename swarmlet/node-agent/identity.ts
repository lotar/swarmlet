// Node identity: an Ed25519 keypair (protocol/sign.ts) for enrollment and channel auth, plus a
// self-signed ECDSA P-256 X.509 certificate for the TLS data listener. The certificate's SHA-256
// fingerprint is what other nodes pin; it is bound to the node by the signed enrollment.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureKeys, nodeIdFromJwk, readPublicJwk, sha256Hex, type KeyMaterial } from "../protocol/sign.ts";
import type { AgentPaths } from "./paths.ts";
import { generateSelfSigned } from "./selfsigned.ts";

export interface Identity {
  nodeId: string;
  keys: KeyMaterial;
  pubJwk: JsonWebKey;
  certPem: string;
  keyPem: string;
  certFp: string;
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function ensureCert(tlsDir: string, cn: string): Promise<{ certPem: string; keyPem: string }> {
  const certPath = join(tlsDir, "cert.pem");
  const keyPath = join(tlsDir, "key.pem");
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    // WebCrypto, not openssl: Windows ships no openssl and the transport pins fingerprints only.
    const generated = await generateSelfSigned(cn, 3650);
    writeFileSync(keyPath, generated.keyPem, { mode: 0o600 });
    writeFileSync(certPath, generated.certPem);
    chmodSync(keyPath, 0o600);
  }
  return { certPem: readFileSync(certPath, "utf8"), keyPem: readFileSync(keyPath, "utf8") };
}

export async function loadIdentity(paths: AgentPaths): Promise<Identity> {
  const keys = await ensureKeys(paths.keysDir);
  const pubJwk = await readPublicJwk(paths.keysDir);
  const nodeId = await nodeIdFromJwk(pubJwk);
  const { certPem, keyPem } = await ensureCert(paths.tlsDir, `swarmlet-node-${nodeId}`);
  const certFp = await sha256Hex(pemToDer(certPem));
  return { nodeId, keys, pubJwk, certPem, keyPem, certFp };
}
