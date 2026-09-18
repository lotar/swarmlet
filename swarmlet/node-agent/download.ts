// Fetching a model's weights onto this node, on the owner's explicit confirmation.
//
// Why this lives here: the control already tells a node what it CANNOT serve ("does not have this
// model downloaded") through the catalog, and a profile can now declare where those bytes live.
// This module is the missing verb — it turns that declaration into a file in the models directory.
//
// The declared sha256 is the entire trust boundary. The URL may be a third-party host that
// redirects to a CDN, so nothing about the transport is trusted: bytes are written to a `.part`
// file, hashed, and only then renamed into place. A truncated, mutated or man-in-the-middled
// download fails the hash and never becomes a model the planner can match.
//
// One fetch at a time: a second 28 GB download is not a queueing problem, it is a way to fill the
// disk twice over while the first one is still running.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, statfsSync, unlinkSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ModelDownload, ModelDownloadFile } from "../protocol/types.ts";
import { validCatalogDownload } from "../protocol/types.ts";

/** The minimum a caller must supply to fetch weights. Deliberately narrower than the wire type
 *  (protocol CatalogModel), because inference.ts parses an untrusted catalog into its own partial
 *  view; the fetcher only needs an id and a validated download declaration. */
export interface FetchableModel {
  id: string;
  download?: ModelDownload;
}

/** Disk kept free after a fetch so filling a node's models directory cannot wedge the machine. */
export function modelsReserveMiB(): number {
  const raw = Number(process.env.SWARMLET_MODELS_RESERVE_MIB);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2048;
}

export type FetchStateName = "idle" | "running" | "verifying" | "done" | "failed" | "cancelled";

export interface FetchStatus {
  model: string | null;
  state: FetchStateName;
  file: string | null;
  fileIndex: number;
  fileCount: number;
  receivedBytes: number;
  totalBytes: number;
  /** 0..1 across every declared file. */
  progress: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface Deps {
  modelsDir: () => string;
  log: (line: string) => void;
  /** Called after files land so the node reports fresh hashes to control. */
  onModelsChanged: () => Promise<void> | void;
}

const EMPTY: FetchStatus = { model: null, state: "idle", file: null, fileIndex: 0, fileCount: 0, receivedBytes: 0, totalBytes: 0, progress: 0 };

/** sha256 of a file, streamed (a 28 GB buffer is not an option). */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function sizeOf(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}

export class ModelFetcher {
  private status: FetchStatus = { ...EMPTY };
  private running = false;
  private cancelled = false;

  constructor(private readonly deps: Deps) {}

  get(): FetchStatus { return { ...this.status }; }

  /** Which declared files are missing or the wrong size on disk. */
  missingFiles(model: FetchableModel): ModelDownloadFile[] {
    const dir = this.deps.modelsDir();
    return (model.download?.files ?? []).filter((f) => sizeOf(join(dir, f.name)) !== f.bytes);
  }

  cancel(): void {
    if (this.running) { this.cancelled = true; this.deps.log("cancel requested"); }
  }

  /**
   * Fetch every declared file for `model`. Resolves when the fetch finishes or fails, so
   * fire-and-forget callers should not await it. Never rejects: failures land in the status.
   */
  async fetch(model: FetchableModel): Promise<FetchStatus> {
    if (this.running) return this.fail(model.id, "another download is already running");
    const declared = model.download?.files ?? [];
    if (declared.length === 0) return this.fail(model.id, "this model does not declare where its weights can be fetched from");
    for (const f of declared) {
      if (!validCatalogDownload(f)) return this.fail(model.id, `control offered an unusable download entry for ${(f as { name?: string })?.name ?? "?"}`);
    }

    const dir = this.deps.modelsDir();
    const totalBytes = declared.reduce((n, f) => n + f.bytes, 0);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      return this.fail(model.id, `models directory is not usable: ${(e as Error).message}`);
    }

    // Refuse before spending bandwidth: the payload plus 5% headroom must fit, and the node must still have
    // room to work afterwards. Filling a node's disk to the last byte breaks everything else on it - the
    // engine's own scratch, logs, the OS - so a reserve is kept by default. Configurable because a padded
    // machine may want a bigger one and a tight one may accept a smaller.
    const reserve = modelsReserveMiB() * 1024 * 1024;
    const need = Math.ceil(totalBytes * 1.05) + reserve;
    try {
      const st = statfsSync(dir);
      const free = Number(st.bavail) * Number(st.bsize);
      if (free < need) {
        return this.fail(model.id, `needs ${(need / 1e9).toFixed(1)} GB free (`
          + `${(totalBytes / 1e9).toFixed(1)} GB payload + ${(reserve / 1e9).toFixed(1)} GB kept free), `
          + `${(free / 1e9).toFixed(1)} GB available in ${dir}`);
      }
    } catch { /* a filesystem that cannot report free space is not a reason to refuse */ }

    this.running = true;
    this.cancelled = false;
    let completedBytes = 0;
    this.status = {
      model: model.id, state: "running", file: null, fileIndex: 0, fileCount: declared.length,
      receivedBytes: 0, totalBytes, progress: 0, startedAt: new Date().toISOString(),
    };

    try {
      for (let i = 0; i < declared.length; i++) {
        const file = declared[i]!;
        const finalPath = join(dir, file.name);
        const partPath = `${finalPath}.part`;
        this.status.file = file.name;
        this.status.fileIndex = i;

        if (sizeOf(finalPath) === file.bytes) {
          this.deps.log(`${file.name}: already present (${file.bytes} bytes)`);
          completedBytes += file.bytes;
          this.status.receivedBytes = completedBytes;
          this.status.progress = completedBytes / totalBytes;
          continue;
        }

        // Resume only from a shorter-than-expected .part; anything else is discarded.
        let resumeFrom = sizeOf(partPath) ?? 0;
        if (resumeFrom >= file.bytes) { try { unlinkSync(partPath); } catch { /* ignore */ } resumeFrom = 0; }
        this.status.receivedBytes = completedBytes + resumeFrom;
        this.status.progress = this.status.receivedBytes / totalBytes;

        this.deps.log(`${file.name}: ${resumeFrom > 0 ? `resuming at ${resumeFrom}` : "starting"} / ${file.bytes} bytes`);
        const res = await fetch(file.url, { redirect: "follow", headers: resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : {} });
        if (!res.ok && res.status !== 206) return this.fail(model.id, `${file.name}: HTTP ${res.status} from the declared URL`);
        if (!res.body) return this.fail(model.id, `${file.name}: empty response body`);
        const appending = resumeFrom > 0 && res.status === 206;
        if (resumeFrom > 0 && !appending) {
          // The server ignored our range: start over rather than appending onto a partial file.
          this.deps.log(`${file.name}: range not honoured, restarting the file`);
          try { unlinkSync(partPath); } catch { /* ignore */ }
          resumeFrom = 0;
          this.status.receivedBytes = completedBytes;
        }

        const sink = createWriteStream(partPath, { flags: appending ? "a" : "w" });
        let written = resumeFrom;
        try {
          const reader = res.body.getReader();
          for (;;) {
            if (this.cancelled) break;
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            written += value.byteLength;
            this.status.receivedBytes = completedBytes + written;
            this.status.progress = Math.min(1, this.status.receivedBytes / totalBytes);
            if (!sink.write(Buffer.from(value))) await once(sink, "drain");
          }
          if (this.cancelled) {
            this.deps.log(`${file.name}: cancelled; ${partPath} kept for resume`);
            return this.failCancelled(completedBytes + written);
          }
        } finally {
          await new Promise<void>((resolve) => sink.end(() => resolve()));
        }

        const got = sizeOf(partPath) ?? 0;
        if (got !== file.bytes) return this.fail(model.id, `${file.name}: got ${got} bytes, expected ${file.bytes}`);

        // The trust boundary: hash before anything else can see the file.
        this.status.state = "verifying";
        const digest = await fileSha256(partPath);
        if (digest !== file.sha256) {
          try { unlinkSync(partPath); } catch { /* ignore */ }
          return this.fail(model.id, `${file.name}: sha256 mismatch (expected ${file.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…). Deleted the bad download.`);
        }
        renameSync(partPath, finalPath);
        this.deps.log(`${file.name}: verified ${digest.slice(0, 12)}… and installed`);
        completedBytes += file.bytes;
        this.status.state = "running";
        this.status.receivedBytes = completedBytes;
        this.status.progress = completedBytes / totalBytes;
      }

      // Report the new files so control sees them without a manual rescan.
      await this.deps.onModelsChanged();
      this.status = { ...this.status, state: "done", finishedAt: new Date().toISOString(), progress: 1 };
      this.deps.log(`fetch complete for ${model.id}`);
      return this.get();
    } catch (e) {
      return this.fail(model.id, (e as Error).message);
    } finally {
      this.running = false;
    }
  }

  private failCancelled(receivedBytes: number): FetchStatus {
    this.status = { ...this.status, state: "cancelled", receivedBytes, finishedAt: new Date().toISOString() };
    this.running = false;
    return this.get();
  }

  private fail(model: string, error: string): FetchStatus {
    this.status = { ...this.status, model, state: "failed", error, finishedAt: new Date().toISOString() };
    this.deps.log(`fetch failed for ${model}: ${error}`);
    this.running = false;
    return this.get();
  }
}
