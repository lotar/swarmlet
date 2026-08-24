// Ed25519 signing over canonical JSON (WebCrypto — zero dependencies).
// Used for gate certificates and artifact provenance. Keys live in
// data/keys/{private,jwk}.json and are generated on first init.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Deterministic JSON serialization: object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export interface KeyMaterial {
  priv: CryptoKey;
  pub: CryptoKey;
}

function keysDir(dir: string): string {
  return dir.startsWith("/") ? dir : `${process.cwd()}/${dir}`;
}

/** Load keypair from disk or generate + persist on first call (idempotent). */
export async function ensureKeys(dir: string): Promise<KeyMaterial> {
  const abs = keysDir(dir);
  const privJwkPath = `${abs}/private.jwk.json`;
  const pubJwkPath = `${abs}/public.jwk.json`;
  try {
    const privRaw = await Bun.file(privJwkPath).text();
    const pubRaw = await Bun.file(pubJwkPath).text();
    return {
      priv: await importPriv(JSON.parse(privRaw) as JsonWebKey),
      pub: await importPub(JSON.parse(pubRaw) as JsonWebKey),
    };
  } catch {
    // generate fresh pair
  }
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  await import("node:fs/promises").then((fs) => fs.mkdir(abs, { recursive: true }));
  const privJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pubJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const w = await import("node:fs/promises");
  await w.writeFile(privJwkPath, JSON.stringify(privJwk));
  await w.writeFile(pubJwkPath, JSON.stringify(pubJwk));
  return { priv: pair.privateKey, pub: pair.publicKey };
}

async function importPriv(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

async function importPub(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  // explicit ArrayBuffer backing to satisfy BufferSource (no SharedArrayBuffer)
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Sign an object: canonicalizes everything except an existing `signature`
 * field, returns a shallow copy carrying `signature` (base64 Ed25519).
 */
export async function signObject<T extends object>(
  obj: T,
  priv: CryptoKey,
): Promise<T & { signature: string }> {
  const { signature: _ignored, ...payload } = obj as T & { signature?: string };
  void _ignored;
  const data = encoder.encode(canonicalize(payload));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, priv, data);
  return { ...obj, signature: toBase64(new Uint8Array(sig)) } as T & {
    signature: string;
  };
}

/** Verify a signed object produced by signObject. Tamper-evident by construction. */
export async function verifyObject(
  signed: object & { signature?: unknown },
  pub: CryptoKey,
): Promise<boolean> {
  if (typeof signed.signature !== "string") return false;
  const { signature, ...payload } = signed as { signature: string };
  const data = encoder.encode(canonicalize(payload));
  try {
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      pub,
      fromBase64(signature),
      data,
    );
  } catch {
    return false;
  }
}
