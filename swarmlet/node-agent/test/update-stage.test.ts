import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, signObject } from "../../protocol/sign.ts";
import { verifyRelease } from "../../protocol/release.ts";
import { fetchRelease, releaseFeed, stageRelease } from "../update-stage.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const pinnedKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
const now = Date.now();
const target = { platform: "linux", arch: "arm64", acceptedSequence: 0, now };
const controlUrl = "http://127.0.0.1:47801";
const payload = new TextEncoder().encode("new release payload");
const raw = JSON.stringify(await signObject({ kind: "swarmlet-release", schema: 1, sequence: 1,
  version: "test-1", platform: "linux", arch: "arm64", issuedAt: now, expiresAt: now + 60_000,
  files: [{ path: "swarmlet-node", bytes: payload.byteLength, sha256: await sha256Hex(payload) }],
}, pair.privateKey));
const manifest = await verifyRelease(raw, pinnedKey, target);
async function directory() { const dir = await mkdtemp(join(tmpdir(), "swarmlet-release-test-")); dirs.push(dir); return dir; }
function fakeFetch(fn: (url: string, opts?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, opts?: RequestInit) => Promise.resolve(fn(String(url), opts))) as typeof fetch;
}

test("fetch verifies a controller manifest and prohibits redirects", async () => {
  const release = await fetchRelease({ controlUrl, pinnedKey, ...target, fetcher: fakeFetch((url, opts) => {
    expect(url).toBe(`${controlUrl}/releases/linux-arm64/manifest.json`);
    expect(opts?.redirect).toBe("error");
    return new Response(raw);
  }) });
  expect(release?.sequence).toBe(1);
  expect(await fetchRelease({ controlUrl, pinnedKey, ...target, fetcher: fakeFetch(() => new Response(null, { status: 404 })) })).toBeNull();
});

test("feed rejects credentials and controller URL path confusion", () => {
  for (const url of ["file:///tmp/manifest", "http://user:pw@localhost", "http://localhost/proxy", "http://localhost?url=evil", "http://localhost/#evil"]) expect(() => releaseFeed(url, "linux", "arm64")).toThrow();
});

test("publishes only a complete hash-verified directory", async () => {
  const releasesDir = await directory();
  const complete = await stageRelease({ controlUrl, manifest, releasesDir, fetcher: fakeFetch((url, opts) => {
    expect(url).toBe(`${controlUrl}/releases/linux-arm64/1/swarmlet-node`);
    expect(opts?.redirect).toBe("error");
    return new Response(payload);
  }) });
  expect(await readFile(join(complete, "swarmlet-node"))).toEqual(Buffer.from(payload));
  expect(JSON.parse(await readFile(join(complete, "manifest.json"), "utf8"))).toEqual(manifest);
  expect((await readdir(releasesDir)).some((name) => name.startsWith(".partial"))).toBe(false);
});

test("truncation, excess bytes, bad hash and interrupted streams leave no runnable release", async () => {
  const releasesDir = await directory();
  const responses = [
    () => new Response(payload.slice(1)),
    () => new Response(new Uint8Array(payload.length + 1)),
    () => new Response(new Uint8Array(payload.length)),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(payload.slice(0, 4)); controller.error(new Error("connection lost")); } })),
    () => new Response("failed", { status: 500 }),
  ];
  for (const response of responses) {
    await expect(stageRelease({ controlUrl, manifest, releasesDir, fetcher: fakeFetch(response) })).rejects.toThrow();
    expect(await readdir(releasesDir)).toEqual([]);
  }
});
