// The weights fetch path. The declared sha256 is the only thing standing between a third-party URL
// and a model file the planner will happily load, so every test here is about what happens when the
// bytes do NOT match the declaration.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelFetcher, fileSha256 } from "../download.ts";

const GOOD = Buffer.from("swarmlet-model-bytes-".repeat(4096));
const OTHER = Buffer.from("x".repeat(GOOD.length));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let modelsDir = "";
let server: ReturnType<typeof Bun.serve>;
let url = "";
/** What the fixture serves and whether it honours Range requests. */
let body = GOOD;
let honourRange = true;
let requests = 0;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requests++;
      const path = new URL(req.url).pathname;
      if (path !== "/model.gguf") return new Response("no", { status: 404 });
      const range = req.headers.get("range");
      if (range && honourRange) {
        const start = Number(/bytes=(\d+)-/.exec(range)![1]);
        return new Response(body.subarray(start), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` },
        });
      }
      return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
    },
  });
  url = `http://127.0.0.1:${server.port}/model.gguf`;
});
afterAll(() => server.stop(true));

beforeEach(() => {
  modelsDir = mkdtempSync(join(tmpdir(), "swarmlet-fetch-"));
  body = GOOD;
  honourRange = true;
  requests = 0;
});

const fetcher = (changes: string[] = []) => new ModelFetcher({
  modelsDir: () => modelsDir,
  log: () => {},
  onModelsChanged: () => { changes.push("rescan"); },
});

const model = (bytes = GOOD.length, hash = sha(GOOD), name = "model.gguf") => ({
  id: "test-model",
  download: { files: [{ name, kind: "gguf" as const, url, sha256: hash, bytes }] },
});

test("a matching download is installed, hashed, and reported to control", async () => {
  const changes: string[] = [];
  const status = await fetcher(changes).fetch(model());
  expect(status.state).toBe("done");
  expect(status.progress).toBe(1);
  expect(await fileSha256(join(modelsDir, "model.gguf"))).toBe(sha(GOOD));
  expect(existsSync(join(modelsDir, "model.gguf.part"))).toBe(false);
  expect(changes).toEqual(["rescan"]);
});

test("bytes that do not match the declared hash are never installed", async () => {
  body = OTHER; // same length, different content: only the hash can catch this
  const status = await fetcher().fetch(model());
  expect(status.state).toBe("failed");
  expect(status.error).toContain("sha256 mismatch");
  // The whole point: no model file appears, and the evidence is deleted rather than left behind.
  expect(existsSync(join(modelsDir, "model.gguf"))).toBe(false);
  expect(existsSync(join(modelsDir, "model.gguf.part"))).toBe(false);
});

test("a truncated response fails on size and does not produce a model file", async () => {
  const status = await fetcher().fetch(model(GOOD.length + 1000));
  expect(status.state).toBe("failed");
  expect(status.error).toContain("expected");
  expect(existsSync(join(modelsDir, "model.gguf"))).toBe(false);
});

test("an interrupted download resumes from its .part instead of refetching", async () => {
  const half = GOOD.subarray(0, 2048);
  writeFileSync(join(modelsDir, "model.gguf.part"), half);
  const status = await fetcher().fetch(model());
  expect(status.state).toBe("done");
  expect(await fileSha256(join(modelsDir, "model.gguf"))).toBe(sha(GOOD));
  expect(existsSync(join(modelsDir, "model.gguf.part"))).toBe(false);
});

test("a server that ignores Range restarts the file rather than appending to a partial one", async () => {
  honourRange = false;
  writeFileSync(join(modelsDir, "model.gguf.part"), GOOD.subarray(0, 2048));
  const status = await fetcher().fetch(model());
  expect(status.state).toBe("done");
  // Appending would have produced 2048 extra bytes and a hash failure; the file must be exactly right.
  expect(await fileSha256(join(modelsDir, "model.gguf"))).toBe(sha(GOOD));
});

test("an already-complete file is not refetched", async () => {
  writeFileSync(join(modelsDir, "model.gguf"), GOOD);
  const status = await fetcher().fetch(model());
  expect(status.state).toBe("done");
  expect(requests).toBe(0);
});

test("a catalog entry that is not a usable download is refused before any request", async () => {
  const bad = { id: "test-model", download: { files: [{ name: "model.gguf", kind: "gguf" as const, url: "https://example.invalid/m.gguf", sha256: "nothex", bytes: 10 }] } };
  const status = await fetcher().fetch(bad);
  expect(status.state).toBe("failed");
  expect(status.error).toContain("unusable download entry");
  expect(requests).toBe(0);
});

test("a second fetch cannot start while one is running, and a model with no declared source explains itself", async () => {
  const f = fetcher();
  const inFlight = f.fetch(model());
  const second = await f.fetch(model());
  expect(second.state).toBe("failed");
  expect(second.error).toContain("already running");
  await inFlight;
  const none = await fetcher().fetch({ id: "no-source" });
  expect(none.state).toBe("failed");
  expect(none.error).toContain("does not declare");
});
