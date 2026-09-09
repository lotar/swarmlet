// Bounded local evidence independent of the active-assignment map. The local log API can
// still inspect a retired assignment after cleanup or an agent restart.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "../control/log.ts";

const MAX_FILES = 128;
const MAX_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 8192;
const MAX_LINES = 400;

export class AssignmentLogs {
  private readonly dir: string;
  constructor(stateDir: string, private readonly log: Logger) {
    this.dir = join(stateDir, "assignment-logs");
    try { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); this.prune(); }
    catch (e) { this.error(e); }
  }

  private file(id: string): string { return join(this.dir, `${createHash("sha256").update(id).digest("hex")}.log`); }

  append(id: string, line: string): void {
    try {
      const file = this.file(id);
      let size = 0;
      try { size = statSync(file).size; } catch { this.prune(MAX_FILES - 1); }
      // Retain the existing engine output, without enabling verbose prompt/request logging.
      const bounded = Buffer.from(line.replace(/[\r\n]/g, " ")).subarray(0, MAX_LINE_BYTES).toString("utf8");
      const entry = `${new Date().toISOString()} ${bounded}\n`;
      if (size + Buffer.byteLength(entry) > MAX_BYTES) {
        const tail = readFileSync(file, "utf8").split("\n").filter(Boolean);
        let bytes = Buffer.byteLength(entry);
        const retained: string[] = [];
        for (const row of tail.reverse()) {
          const n = Buffer.byteLength(row) + 1;
          if (bytes + n > MAX_BYTES / 2) break;
          retained.unshift(row); bytes += n;
        }
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, [...retained, entry.trimEnd()].join("\n") + "\n", { mode: 0o600 });
        renameSync(temporary, file);
      } else appendFileSync(file, entry, { mode: 0o600 });
    } catch (e) { this.error(e); } // Diagnostics must not prevent engine cleanup.
  }

  recent(id: string, n = 200): string[] {
    const count = Number.isFinite(n) ? Math.max(0, Math.min(MAX_LINES, Math.floor(n))) : 200;
    if (!count) return [];
    try { return readFileSync(this.file(id), "utf8").split("\n").filter(Boolean).slice(-count); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.error(e); return []; }
  }

  private prune(limit = MAX_FILES): void {
    const files = readdirSync(this.dir).filter((name) => /^[a-f0-9]{64}\.log$/.test(name))
      .map((name) => ({ path: join(this.dir, name), modified: statSync(join(this.dir, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    for (const file of files.slice(limit)) unlinkSync(file.path);
  }

  private error(e: unknown): void { this.log.warn("assignment log persistence failed", { err: (e as Error).message }); }
}
