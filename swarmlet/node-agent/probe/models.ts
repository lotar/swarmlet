// GGUF inventory of a models directory (one level of subdirectories). Hashing streams the file.

import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ModelFile } from "../../protocol/types.ts";

interface HashEntry { metadata: string; sha256: string }
// stat follows symlinks, so the identity describes the actual model target.
async function modelStat(path: string): Promise<{ metadata: string; size: number } | null> {
  const s = await stat(path, { bigint: true });
  if (!s.isFile() || s.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { size: Number(s.size), metadata: [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":") };
}
async function readHashCache(path?: string): Promise<Record<string, HashEntry>> {
  if (!path) return {};
  try {
    const cache = JSON.parse(await readFile(path, "utf8"));
    if (cache?.schema !== 1 || !cache.entries || typeof cache.entries !== "object" || Array.isArray(cache.entries)) return {};
    return Object.fromEntries(Object.entries(cache.entries).filter(([key, value]) => {
      const v = value as HashEntry | null;
      return resolve(key) === key && v && typeof v.metadata === "string" && /^\d+:\d+:\d+:-?\d+:-?\d+$/.test(v.metadata) && typeof v.sha256 === "string" && /^[a-f0-9]{64}$/.test(v.sha256);
    })) as Record<string, HashEntry>;
  } catch { return {}; } // A missing or damaged cache must never imply a verified hash.
}
async function writeHashCache(path: string, entries: Record<string, HashEntry>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify({ schema: 1, entries }) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

export function modelKind(name: string): ModelFile["kind"] {
  const l = name.toLowerCase();
  if (l.includes("mtp")) return "mtp";
  if (l.includes("mmproj")) return "mmproj";
  return "gguf";
}

export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
}

/** *.gguf files in `dir` and one level of subdirectories (split shards and MTP heads usually sit in
 *  their own folders), sorted by name; a missing or unreadable dir is simply empty. Symlinks are followed. */
export async function listModels(dir: string, opts: { hash?: boolean; cacheFile?: string } = {}): Promise<ModelFile[]> {
  const base = resolve(dir);
  let names: string[];
  try { names = await readdir(base); } catch { return []; }
  const candidates: string[] = [];
  for (const name of names) {
    const path = join(base, name);
    try {
      const st = await stat(path);
      if (st.isDirectory()) {
        for (const sub of await readdir(path).catch(() => [] as string[])) if (/\.gguf$/i.test(sub)) candidates.push(join(path, sub));
      } else if (st.isFile() && /\.gguf$/i.test(name)) candidates.push(path);
    } catch { /* unreadable entry */ }
  }
  const cached = await readHashCache(opts.cacheFile);
  const verified: Record<string, HashEntry> = {};
  const out: ModelFile[] = [];
  for (const path of candidates) {
    let before: Awaited<ReturnType<typeof modelStat>>;
    try { before = await modelStat(path); if (!before) continue; } catch { continue; }
    const name = path.slice(path.lastIndexOf("/") + 1);
    const f: ModelFile = { name, path, sizeBytes: before.size, kind: modelKind(name) };
    if (opts.hash) {
      const sha256 = await sha256File(path);
      const after = await modelStat(path).catch(() => null);
      // A changing/replaced file is unqualified, even if the stream completed.
      if (after?.metadata === before.metadata) {
        f.sha256 = sha256;
        verified[path] = { metadata: before.metadata, sha256 };
      }
    } else if (cached[path]?.metadata === before.metadata) f.sha256 = cached[path]!.sha256;
    out.push(f);
  }
  if (opts.hash && opts.cacheFile) await writeHashCache(opts.cacheFile, verified);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.path < b.path ? -1 : 1));
  return out;
}
