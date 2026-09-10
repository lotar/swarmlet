import { open } from "node:fs/promises";

/** POSIX needs the directory entry flushed as well as the file before a rename is durable.
 * Windows does not expose directory fsync through Node; file flush + atomic rename is used. */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
