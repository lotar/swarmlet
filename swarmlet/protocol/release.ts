// Signed, platform-specific release inventory. Trust comes only from the node's pinned
// controller key; a key supplied with a release must never authorize that release.
import { importPublicJwk, verifyObject } from "./sign.ts";

export interface ReleaseFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseManifest {
  kind: "swarmlet-release";
  schema: 1;
  sequence: number;
  version: string;
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
  issuedAt: number;
  expiresAt: number;
  files: ReleaseFile[];
  signature: string;
}

export const MAX_MANIFEST_BYTES = 128 * 1024;
export const MAX_RELEASE_BYTES = 4 * 1024 ** 3;
export class ReleaseNotNewError extends Error {}

/** Use the same portable subset on every OS, including Windows reserved names. */
export function validReleasePath(path: string): boolean {
  if (path.length > 180 || !/^(?:engine\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)) return false;
  const name = path.split("/").at(-1)!;
  return !name.endsWith(".") && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}

/** Strictly newer signed releases only. Persist the accepted sequence across rollback. */
export async function verifyRelease(
  raw: string,
  pinnedKey: JsonWebKey,
  target: { platform: string; arch: string; acceptedSequence: number; now?: number },
): Promise<ReleaseManifest> {
  if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) throw new Error("release manifest too large");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid release manifest");
  if (typeof value.signature !== "string" || value.signature.length !== 88 ||
      !await verifyObject(value, await importPublicJwk(pinnedKey))) throw new Error("invalid release signature");
  const m = value as ReleaseManifest;
  const now = target.now ?? Date.now();
  if (m.kind !== "swarmlet-release" || m.schema !== 1 ||
      !Number.isSafeInteger(m.sequence) || m.sequence < 1 ||
      !Number.isSafeInteger(target.acceptedSequence) || target.acceptedSequence < 0) throw new Error("invalid release sequence");
  if (m.sequence <= target.acceptedSequence) throw new ReleaseNotNewError("replayed release sequence");
  if (!["darwin", "linux", "win32"].includes(m.platform) || !["arm64", "x64"].includes(m.arch) ||
      m.platform !== target.platform || m.arch !== target.arch) throw new Error("release target mismatch");
  if (typeof m.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(m.version)) throw new Error("invalid release version");
  if (!Number.isSafeInteger(m.issuedAt) || !Number.isSafeInteger(m.expiresAt) ||
      m.issuedAt < 0 || m.issuedAt > now + 60_000 || m.expiresAt <= now ||
      m.expiresAt <= m.issuedAt) throw new Error("release outside validity window");
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > 256) throw new Error("invalid release files");
  const paths = new Set<string>();
  let bytes = 0;
  for (const f of m.files) {
    if (!f || typeof f.path !== "string" || !validReleasePath(f.path) ||
        (!f.path.startsWith("engine/") && f.path !== "swarmlet-node" && f.path !== "swarmlet-node.exe") ||
        typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256) ||
        !Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > MAX_RELEASE_BYTES) throw new Error("invalid release file");
    const folded = f.path.toLowerCase();
    if (paths.has(folded)) throw new Error("duplicate release file");
    paths.add(folded);
    bytes += f.bytes;
    if (bytes > MAX_RELEASE_BYTES) throw new Error("release too large");
  }
  const agent = m.platform === "win32" ? "swarmlet-node.exe" : "swarmlet-node";
  if (!m.files.some((f) => f.path === agent)) throw new Error("release missing agent");
  return m;
}
