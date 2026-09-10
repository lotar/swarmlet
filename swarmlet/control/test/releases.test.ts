import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishRelease } from "../publish-release.ts";
import { serveRelease } from "../releases.ts";
import { fetchRelease, stageRelease } from "../../node-agent/update-stage.ts";

test("signed publication reaches the node over HTTP, retains old payloads and rejects rollback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-feed-"));
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const source = join(dir, "source");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => serveRelease(dir, req) });
  const controlUrl = `http://127.0.0.1:${server.port}`;
  try {
    await mkdir(join(source, "engine"), { recursive: true });
    await writeFile(join(source, "swarmlet-node"), "agent release one");
    await writeFile(join(source, "engine/llama-server"), "engine release one");
    const opts = { dataDir: dir, source, platform: "linux" as const, arch: "x64" as const, sequence: 1, version: "test-1", priv: pair.privateKey, pub };
    await publishRelease(opts);
    const manifest = await fetchRelease({ controlUrl, pinnedKey: pub, platform: "linux", arch: "x64", acceptedSequence: 0 });
    expect(manifest?.sequence).toBe(1);
    const staged = await stageRelease({ controlUrl, manifest: manifest!, releasesDir: join(dir, "node-releases") });
    expect(await readFile(join(staged, "swarmlet-node"), "utf8")).toBe("agent release one");
    expect(await readFile(join(staged, "engine/llama-server"), "utf8")).toBe("engine release one");
    await writeFile(join(source, "swarmlet-node"), "agent release two");
    await publishRelease({ ...opts, sequence: 2, version: "test-2" });
    await expect(publishRelease(opts)).rejects.toThrow("sequence");
    expect((await fetchRelease({ controlUrl, pinnedKey: pub, platform: "linux", arch: "x64", acceptedSequence: 1 }))?.sequence).toBe(2);
    expect(await (await fetch(`${controlUrl}/releases/linux-x64/1/swarmlet-node`)).text()).toBe("agent release one");
    for (const path of ["/releases/linux-x64/1/manifest.json", "/releases/linux-x64/1/private.jwk.json", "/releases/linux-x64/1/engine/missing"]) expect((await fetch(controlUrl + path)).status).toBe(404);
    const payloadPath = join(dir, "releases/linux-x64/2/engine/llama-server");
    await rm(payloadPath);
    await symlink(join(source, "swarmlet-node"), payloadPath);
    expect((await fetch(`${controlUrl}/releases/linux-x64/2/engine/llama-server`)).status).toBe(404);
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }); }
});
