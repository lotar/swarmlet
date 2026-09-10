import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readUpdateState, writeUpdateState } from "../update-state.ts";
import { UpdateDrain } from "../update-drain.ts";

test("an interrupted update retains the previous active release and durable replay floor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-update-state-"));
  const path = join(dir, "updates.json");
  try {
    const state = await readUpdateState(path);
    expect(state.acceptedSequence).toBe(0);
    const pending = { sequence: 2, directory: `2-${crypto.randomUUID()}` };
    await writeUpdateState(path, { ...state, acceptedSequence: 2, pending });
    const interrupted = await readUpdateState(path);
    expect(interrupted.pending).toEqual(pending);
    expect(interrupted.active).toBeNull();
    await writeUpdateState(path, { ...interrupted, pending: null });
    expect((await readUpdateState(path)).acceptedSequence).toBe(2);
    await writeFile(path, JSON.stringify({ ...state, acceptedSequence: 2, active: { sequence: 2, directory: "../../outside" } }));
    await expect(readUpdateState(path)).rejects.toThrow("reference");
    await writeFile(path, "{truncated");
    await expect(readUpdateState(path)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("local drain waits for every stream, rejects new admission and releases exactly once", () => {
  const drain = new UpdateDrain();
  const first = drain.admit()!, second = drain.admit()!;
  expect(drain.begin()).toBe(false);
  first(); first();
  expect(drain.begin()).toBe(false);
  second();
  expect(drain.begin()).toBe(true);
  expect(drain.admit()).toBeNull();
  drain.resume();
  const resumed = drain.admit();
  expect(resumed).not.toBeNull();
  resumed!();
  expect(drain.begin()).toBe(true);
});
