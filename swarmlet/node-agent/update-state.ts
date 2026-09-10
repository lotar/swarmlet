import { open, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { syncDirectory } from "../protocol/durable-files.ts";

export interface InstalledRelease { directory: string; sequence: number }
export interface UpdateState {
  acceptedSequence: number;
  active: InstalledRelease | null;
  previous: InstalledRelease | null;
  pending: InstalledRelease | null;
}

export async function readUpdateState(path: string): Promise<UpdateState> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { acceptedSequence: 0, active: null, previous: null, pending: null };
    throw e;
  }
  const value = JSON.parse(raw) as UpdateState;
  if (!value || !Number.isSafeInteger(value.acceptedSequence) || value.acceptedSequence < 0) throw new Error("invalid update state");
  for (const ref of [value.active, value.previous, value.pending]) {
    if (ref === null) continue;
    if (!ref || !Number.isSafeInteger(ref.sequence) || ref.sequence < 1 || ref.sequence > value.acceptedSequence ||
        typeof ref.directory !== "string" || !new RegExp(`^${ref.sequence}-[a-f0-9-]{36}$`).test(ref.directory)) throw new Error("invalid installed release reference");
  }
  return value;
}

/** Persist the replay floor and pending transaction before stopping the old process. */
export async function writeUpdateState(path: string, state: UpdateState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await rm(temporary, { force: true }); }
}

/** Retain active + rollback + transaction directories. Only our generated directory names
 * are eligible; models, user files, and symlinks are never followed or removed. */
export async function pruneReleases(root: string, state: UpdateState): Promise<void> {
  const keep = new Set([state.active?.directory, state.previous?.directory, state.pending?.directory]);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[1-9][0-9]*-[a-f0-9-]{36}$/.test(entry.name) && !keep.has(entry.name)) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}
