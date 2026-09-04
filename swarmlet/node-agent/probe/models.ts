// GGUF inventory of a models directory (one level of subdirectories). Hashing streams the file.

import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelFile } from "../../protocol/types.ts";

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
export async function listModels(dir: string, opts: { hash?: boolean } = {}): Promise<ModelFile[]> {
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
  const out: ModelFile[] = [];
  for (const path of candidates) {
    let size: number;
    try { const st = await stat(path); if (!st.isFile()) continue; size = st.size; } catch { continue; }
    const name = path.slice(path.lastIndexOf("/") + 1);
    const f: ModelFile = { name, path, sizeBytes: size, kind: modelKind(name) };
    if (opts.hash) f.sha256 = await sha256File(path);
    out.push(f);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.path < b.path ? -1 : 1));
  return out;
}
