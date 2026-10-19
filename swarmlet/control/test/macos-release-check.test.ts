import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { attestMacRelease, checkMacAttestation, MAC_ATTESTATION, verifyMacReleaseSource } from "../macos-release-check.ts";
import { publishRelease } from "../publish-release.ts";
import { packageMacApp } from "../../node-shell/scripts/package-macos.ts";
import { isDesktopCarrier, removeDesktopCarrier } from "../../protocol/desktop.ts";

const ok = async () => ({ code: 0, output: "" });
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** An agent dist with a descriptor whose files all exist; codesign is faked by the caller. */
async function fakeDist(dir: string): Promise<string> {
  const agent = join(dir, "agent");
  await mkdir(join(agent, "engine"), { recursive: true });
  await writeFile(join(agent, "swarmlet-node"), "agent");
  await writeFile(join(agent, "engine/llama-server"), "engine");
  const carriers = ["Contents/Info.plist", "Contents/_CodeSignature/CodeResources", "Contents/MacOS/swarmlet-node-shell", "Contents/Resources/agent-build.json"];
  const files = [{ path: "Contents/MacOS/swarmlet-node", source: "swarmlet-node", mode: 0o755 }, { path: "Contents/Resources/engine/llama-server", source: "engine/llama-server", mode: 0o755 }];
  for (const [i, path] of carriers.entries()) {
    const source = `engine/desktop-app-${String(i).padStart(3, "0")}.bin`;
    await writeFile(join(agent, source), path);
    files.push({ path, source, mode: path.includes("MacOS") ? 0o755 : 0o644 });
  }
  await writeFile(join(agent, "engine/desktop-app.json"), JSON.stringify({ kind: "swarmlet-macos-app", schema: 1, bundleId: "ai.swarmlet.node", files }));
  return agent;
}

async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { priv: pair.privateKey, pub: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

test("a darwin release is not published when the Mac gate refuses it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-macgate-"));
  try {
    const source = await fakeDist(dir);
    const opts = { dataDir: dir, source, platform: "darwin" as const, arch: "arm64" as const, sequence: 7, version: "test-7", ...await keys() };
    await expect(publishRelease({ ...opts, verifyMac: async () => { throw new Error("bundle fails codesign"); } })).rejects.toThrow("bundle fails codesign");
    await expect(stat(join(dir, "releases/darwin-arm64/manifest.json"))).rejects.toThrow();
    await expect(stat(join(dir, "releases/darwin-arm64/7"))).rejects.toThrow();
    // Linux and Windows releases have no Mac app and are not gated.
    await publishRelease({ ...opts, platform: "linux", arch: "x64", verifyMac: async () => { throw new Error("not called"); } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("off a Mac, the publisher accepts only the exact bytes a Mac attested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-macattest-"));
  try {
    const source = await fakeDist(dir);
    await expect(verifyMacReleaseSource(source, { host: "linux" })).rejects.toThrow(MAC_ATTESTATION);
    const calls: string[][] = [];
    const attestation = await attestMacRelease(source, async (args) => { calls.push(args); return ok(); });
    expect(calls.map((args) => args.slice(0, -1))).toEqual([["--verify", "--strict"], ["--verify", "--deep", "--strict"]]);
    expect(attestation.files["swarmlet-node"]).toBe(sha("agent"));
    expect(Object.keys(attestation.files)).toContain("engine/desktop-app.json");
    await verifyMacReleaseSource(source, { host: "linux" });
    // The 2026091903 failure: a new agent next to the carrier that was sealed around the old one.
    await writeFile(join(source, "swarmlet-node"), "rebuilt agent");
    await expect(checkMacAttestation(source)).rejects.toThrow("swarmlet-node differs");
    await writeFile(join(source, "swarmlet-node"), "agent");
    await writeFile(join(source, "engine/desktop-app-001.bin"), "other seal");
    await expect(checkMacAttestation(source)).rejects.toThrow("desktop-app-001.bin differs");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a darwin release without a Mac app descriptor is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-macnodesc-"));
  try {
    const source = await fakeDist(dir);
    await rm(join(source, "engine/desktop-app.json"));
    await expect(attestMacRelease(source, ok)).rejects.toThrow("build-release.sh");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a failing codesign leaves no attestation behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-macfail-"));
  try {
    const source = await fakeDist(dir);
    const run = async (args: string[]) => ({ code: args.includes("--deep") ? 1 : 0, output: "invalid signature (code or signature have been modified)" });
    await expect(attestMacRelease(source, run)).rejects.toThrow("fails codesign --verify --deep --strict");
    await expect(stat(join(source, MAC_ATTESTATION))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a copied engine loses the desktop carrier and keeps everything else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-carrier-"));
  try {
    for (const name of ["desktop-app.json", "desktop-app-000.bin", "desktop-app-012.bin", "llama-server", "desktop-app-1.bin", "sha256.txt"]) await writeFile(join(dir, name), name);
    expect(removeDesktopCarrier(dir)).toEqual(["desktop-app-000.bin", "desktop-app-012.bin", "desktop-app.json"]);
    expect(isDesktopCarrier("desktop-app-1.bin")).toBe(false);
    expect(await readFile(join(dir, "llama-server"), "utf8")).toBe("llama-server");
    expect(await readFile(join(dir, "desktop-app-1.bin"), "utf8")).toBe("desktop-app-1.bin");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function sign(path: string, ...extra: string[]) {
  const p = Bun.spawn(["/usr/bin/codesign", "--force", "--sign", "-", ...extra, path], { stdout: "pipe", stderr: "pipe" });
  if (await p.exited !== 0) throw new Error(await new Response(p.stderr).text());
}

test.skipIf(process.platform !== "darwin")("real codesign: a sealed app passes, a swapped agent fails as it did on the nodes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-maccodesign-"));
  try {
    const agent = join(dir, "agent"), app = join(dir, "Swarmlet Node.app");
    await mkdir(join(agent, "engine"), { recursive: true });
    await copyFile("/usr/bin/true", join(agent, "swarmlet-node"));
    await copyFile("/usr/bin/true", join(agent, "engine/llama-server"));
    await sign(join(agent, "swarmlet-node"), "--identifier", "swarmlet-node");
    await sign(join(agent, "engine/llama-server"), "--identifier", "llama-server");
    const put = async (path: string, from: string | null, body?: string) => {
      await mkdir(dirname(join(app, path)), { recursive: true });
      if (from) await copyFile(from, join(app, path)); else await writeFile(join(app, path), body!);
      await chmod(join(app, path), path.includes("MacOS") || path.includes("engine") ? 0o755 : 0o644);
    };
    await put("Contents/Info.plist", null, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.swarmlet.node</string><key>CFBundleExecutable</key><string>swarmlet-node-shell</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
    await put("Contents/MacOS/swarmlet-node-shell", "/usr/bin/true");
    await sign(join(app, "Contents/MacOS/swarmlet-node-shell"), "--identifier", "ai.swarmlet.node");
    await put("Contents/MacOS/swarmlet-node", join(agent, "swarmlet-node"));
    await put("Contents/Resources/engine/llama-server", join(agent, "engine/llama-server"));
    await put("Contents/Resources/agent-build.json", null, JSON.stringify({ sha256: createHash("sha256").update(await readFile(join(agent, "swarmlet-node"))).digest("hex") }));
    await sign(app);
    await packageMacApp(agent, app);
    await attestMacRelease(agent);
    await checkMacAttestation(agent);
    // Replace only the agent, as 2026091903 did: it is validly signed on its own, the sealed app is not.
    await rm(join(agent, MAC_ATTESTATION));
    await copyFile("/bin/echo", join(agent, "swarmlet-node"));
    await sign(join(agent, "swarmlet-node"), "--identifier", "swarmlet-node");
    await expect(attestMacRelease(agent)).rejects.toThrow("fails codesign --verify --deep --strict");
    await expect(stat(join(agent, MAC_ATTESTATION))).rejects.toThrow();
    const opts = { dataDir: dir, source: agent, platform: "darwin" as const, arch: "arm64" as const, sequence: 1, version: "test-1", ...await keys() };
    await expect(publishRelease(opts)).rejects.toThrow("codesign");
    await expect(stat(join(dir, "releases/darwin-arm64/manifest.json"))).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60_000);
