#!/usr/bin/env bun
// bun run control/publish-release.ts <control-data-dir> <agent-dist> <platform> <arch> <sequence> <version>
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { signObject } from "../protocol/sign.ts";
import { verifyRelease, type ReleaseFile, type ReleaseManifest } from "../protocol/release.ts";
import { syncDirectory } from "../protocol/durable-files.ts";

export async function publishRelease(opts: {
  dataDir: string; source: string; platform: ReleaseManifest["platform"]; arch: ReleaseManifest["arch"];
  sequence: number; version: string; priv: CryptoKey; pub: JsonWebKey;
}): Promise<ReleaseManifest> {
  if (!["darwin", "linux", "win32"].includes(opts.platform) || !["arm64", "x64"].includes(opts.arch) ||
      !Number.isSafeInteger(opts.sequence) || opts.sequence < 1) throw new Error("invalid release target or sequence");
  const root = join(opts.dataDir, "releases", `${opts.platform}-${opts.arch}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Exclusive publisher lock prevents concurrent releases from moving the feed backwards.
  const lockPath = join(root, ".publish-lock");
  const lock = await open(lockPath, "wx", 0o600);
  const staging = join(root, `.partial-${randomUUID()}`);
  let tempFeed: string | null = null;
  try {
    let acceptedSequence = 0;
    try { acceptedSequence = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).sequence; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await mkdir(join(staging, "engine"), { recursive: true, mode: 0o700 });
    const paths = [opts.platform === "win32" ? "swarmlet-node.exe" : "swarmlet-node"];
    // Native engine builds must supply all of their runtime libraries. Reject subdirectories
    // and links so the release is a portable, flat inventory without extraction semantics.
    for (const name of await readdir(join(opts.source, "engine"))) paths.push(`engine/${name}`);
    const files: ReleaseFile[] = [];
    for (const path of paths) {
      const src = join(opts.source, path);
      const info = await lstat(src);
      if (!info.isFile()) throw new Error(`release source is not a regular file: ${path}`);
      const dest = join(staging, path);
      await copyFile(src, dest);
      const copied = await open(dest, "r+");
      try { await copied.sync(); } finally { await copied.close(); }
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(dest)) { hash.update(chunk); bytes += chunk.length; }
      files.push({ path, bytes, sha256: hash.digest("hex") });
    }
    const now = Date.now();
    const manifest = await signObject({ kind: "swarmlet-release" as const, schema: 1 as const,
      sequence: opts.sequence, version: opts.version, platform: opts.platform, arch: opts.arch,
      issuedAt: now, expiresAt: now + 30 * 24 * 60 * 60_000, files,
    }, opts.priv);
    const raw = JSON.stringify(manifest);
    await verifyRelease(raw, opts.pub, { ...opts, acceptedSequence, now });
    const inventory = await open(join(staging, "manifest.json"), "wx", 0o600);
    try { await inventory.writeFile(raw); await inventory.sync(); } finally { await inventory.close(); }
    await syncDirectory(join(staging, "engine")); await syncDirectory(staging);
    // Never overwrite an already published sequence, even if it is no longer the current feed.
    const destination = join(root, String(opts.sequence));
    try { await lstat(destination); throw new Error("release sequence already exists"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await rename(staging, destination);
    await syncDirectory(root);
    tempFeed = join(root, `.feed-${randomUUID()}`);
    const feed = await open(tempFeed, "wx", 0o600);
    try { await feed.writeFile(raw); await feed.sync(); } finally { await feed.close(); }
    await rename(tempFeed, join(root, "manifest.json"));
    await syncDirectory(root);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (tempFeed) await rm(tempFeed, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

if (import.meta.main) {
  const [dataDir, source, platform, arch, sequence, version] = process.argv.slice(2);
  if (!dataDir || !source || !platform || !arch || !sequence || !version) throw new Error("usage: publish-release <control-data-dir> <agent-dist> <platform> <arch> <sequence> <version>");
  // Fail closed if existing keys cannot be read. Publishing must never generate a new identity.
  const priv = await crypto.subtle.importKey("jwk", JSON.parse(await readFile(join(dataDir, "keys/private.jwk.json"), "utf8")), { name: "Ed25519" }, false, ["sign"]);
  const pub = JSON.parse(await readFile(join(dataDir, "keys/public.jwk.json"), "utf8"));
  const m = await publishRelease({ dataDir, source, platform: platform as ReleaseManifest["platform"], arch: arch as ReleaseManifest["arch"], sequence: Number(sequence), version, priv, pub });
  console.log(`published ${m.platform}-${m.arch} release ${m.sequence} (${m.version}, ${m.files.length} files)`);
}
