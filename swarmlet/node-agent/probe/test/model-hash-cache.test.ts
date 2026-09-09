import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listModels } from "../models.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "model-hash-cache-")); dirs.push(dir);
  const model = join(dir, "model.gguf"), cacheFile = join(dir, "state", "model-hashes.json");
  writeFileSync(model, "unchanged");
  return { dir, model, cacheFile };
}
test("explicit rescan persists verified SHA for a fresh ordinary inventory scan", async () => {
  const f = fixture();
  const scanned = await listModels(f.dir, { hash: true, cacheFile: f.cacheFile });
  const restarted = await listModels(f.dir, { cacheFile: f.cacheFile });
  expect(scanned[0]!.sha256).toBe("aaa8d3c8d74ad3e8f6b1772aa9c7e0eaa528cb42fc93599ce2f125b00d4c424c");
  expect(restarted[0]!.sha256).toBe(scanned[0]!.sha256);
});

test("ordinary scans reuse SHA without opening model content, and cache permissions are private", async () => {
  const f = fixture();
  await listModels(f.dir, { hash: true, cacheFile: f.cacheFile });
  expect(statSync(f.cacheFile).mode & 0o777).toBe(0o600);
  const file = spyOn(Bun, "file").mockImplementation(() => { throw new Error("boot must not read model content"); });
  try { expect((await listModels(f.dir, { cacheFile: f.cacheFile }))[0]!.sha256).toMatch(/^[a-f0-9]{64}$/); }
  finally { file.mockRestore(); }
});

test("same-size writes with restored mtime, replacement inodes and symlink retargets invalidate cached hashes", async () => {
  for (const mode of ["write", "replace", "symlink"]) {
    const f = fixture();
    if (mode === "symlink") {
      renameSync(f.model, join(f.dir, "first.bin"));
      symlinkSync(join(f.dir, "first.bin"), f.model);
      writeFileSync(join(f.dir, "second.bin"), "different");
    }
    await listModels(f.dir, { hash: true, cacheFile: f.cacheFile });
    const before = statSync(f.model);
    await Bun.sleep(5);
    if (mode === "write") writeFileSync(f.model, "different");
    else if (mode === "replace") { writeFileSync(join(f.dir, "replacement"), "different"); renameSync(join(f.dir, "replacement"), f.model); }
    else { unlinkSync(f.model); symlinkSync(join(f.dir, "second.bin"), f.model); }
    utimesSync(f.model, before.atime, before.mtime);
    expect((await listModels(f.dir, { cacheFile: f.cacheFile }))[0]!.sha256).toBeUndefined();
    const rescan = await listModels(f.dir, { hash: true, cacheFile: f.cacheFile });
    expect((await listModels(f.dir, { cacheFile: f.cacheFile }))[0]!.sha256).toBe(rescan[0]!.sha256);
  }
});

test("missing, damaged and malformed cache entries leave inventory unqualified", async () => {
  const f = fixture();
  expect((await listModels(f.dir, { cacheFile: f.cacheFile }))[0]!.sha256).toBeUndefined();
  await listModels(f.dir, { hash: true, cacheFile: f.cacheFile });
  const cache = JSON.parse(readFileSync(f.cacheFile, "utf8"));
  for (const contents of ["{", JSON.stringify({ schema: 2, entries: cache.entries }), JSON.stringify({ schema: 1, entries: { [f.model]: { ...cache.entries[f.model], sha256: "bogus" } } })]) {
    writeFileSync(f.cacheFile, contents);
    expect((await listModels(f.dir, { cacheFile: f.cacheFile }))[0]!.sha256).toBeUndefined();
  }
});

test("file changed during explicit hashing is neither advertised nor cached", async () => {
  const f = fixture();
  const original = Bun.file;
  const file = spyOn(Bun, "file").mockImplementation((path: any) => {
    const actual = original(path);
    return { stream: () => actual.stream().pipeThrough(new TransformStream({ transform(chunk, controller) {
      writeFileSync(f.model, "new model content with a different size");
      controller.enqueue(chunk);
    } })) } as any;
  });
  try { expect((await listModels(f.dir, { hash: true, cacheFile: f.cacheFile }))[0]!.sha256).toBeUndefined(); }
  finally { file.mockRestore(); }
  expect((await listModels(f.dir, { cacheFile: f.cacheFile }))[0]!.sha256).toBeUndefined();
  expect(JSON.parse(readFileSync(f.cacheFile, "utf8")).entries).toEqual({});
});
