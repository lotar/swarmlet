import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { MAX_MANIFEST_BYTES, ReleaseNotNewError, verifyRelease, type ReleaseManifest } from "../protocol/release.ts";
import { readBoundedText } from "../protocol/bounded-body.ts";
import { syncDirectory } from "../protocol/durable-files.ts";

/** Feed and payloads stay on the enrolled controller; redirects are never followed. */
export function releaseFeed(controlUrl: string, platform: string, arch: string): URL {
  const url = new URL(controlUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("invalid update controller URL");
  if (!["linux", "darwin", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error("unsupported update target");
  url.pathname = `/releases/${platform}-${arch}/manifest.json`;
  return url;
}

export async function fetchRelease(opts: {
  controlUrl: string; pinnedKey: JsonWebKey; platform: string; arch: string;
  acceptedSequence: number; fetcher?: typeof fetch; now?: number;
}): Promise<ReleaseManifest | null> {
  const url = releaseFeed(opts.controlUrl, opts.platform, opts.arch);
  const response = await (opts.fetcher ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (response.status === 404 || response.status === 204) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`release manifest HTTP ${response.status}`); }
  try { return await verifyRelease(await readBoundedText(response.body, MAX_MANIFEST_BYTES), opts.pinnedKey, opts); }
  catch (error) { if (error instanceof ReleaseNotNewError) return null; throw error; }
}

/** The caller must supply a manifest returned by verifyRelease. Nothing in the live
 * installation changes here. A failed or interrupted download cannot become runnable. */
export async function stageRelease(opts: {
  controlUrl: string; manifest: ReleaseManifest; releasesDir: string; fetcher?: typeof fetch;
}): Promise<string> {
  const { manifest: m } = opts;
  const feed = releaseFeed(opts.controlUrl, m.platform, m.arch);
  const id = `${m.sequence}-${randomUUID()}`;
  await mkdir(opts.releasesDir, { recursive: true, mode: 0o700 });
  const staging = join(opts.releasesDir, `.partial-${id}`);
  const complete = join(opts.releasesDir, id);
  await mkdir(staging, { mode: 0o700 });
  try {
    await mkdir(join(staging, "engine"), { mode: 0o700 });
    for (const file of m.files) {
      const url = new URL(`${m.sequence}/${file.path}`, feed);
      const response = await (opts.fetcher ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`release file HTTP ${response.status}`); }
      const reader = response.body.getReader();
      const handle = await open(join(staging, file.path), "wx", 0o700).catch(async error => { await reader.cancel().catch(() => {}); throw error; });
      const hash = createHash("sha256");
      let total = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > file.bytes) throw new Error(`release file length mismatch: ${file.path}`);
          hash.update(value);
          let offset = 0;
          while (offset < value.byteLength) {
            const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
            if (!bytesWritten) throw new Error("release file write stalled");
            offset += bytesWritten;
          }
        }
        if (total !== file.bytes || hash.digest("hex") !== file.sha256) throw new Error(`release file integrity mismatch: ${file.path}`);
        await handle.sync();
      } finally {
        await reader.cancel().catch(() => {});
        await handle.close();
      }
    }
    const inventory = await open(join(staging, "manifest.json"), "wx", 0o600);
    try { await inventory.writeFile(JSON.stringify(m)); await inventory.sync(); } finally { await inventory.close(); }
    await syncDirectory(join(staging, "engine"));
    await syncDirectory(staging);
    await rename(staging, complete);
    await syncDirectory(opts.releasesDir);
    return complete;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
