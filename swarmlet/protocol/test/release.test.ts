import { describe, expect, test } from "bun:test";
import { signObject } from "../sign.ts";
import { MAX_MANIFEST_BYTES, verifyRelease, validReleasePath, type ReleaseManifest } from "../release.ts";

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
const now = 1_800_000_000_000;
const target = { platform: "linux", arch: "arm64", acceptedSequence: 3, now };
const base: Omit<ReleaseManifest, "signature"> = {
  kind: "swarmlet-release", schema: 1, sequence: 4, version: "0.2.0",
  platform: "linux", arch: "arm64", issuedAt: now - 1000, expiresAt: now + 60_000,
  files: [{ path: "swarmlet-node", bytes: 100, sha256: "a".repeat(64) }],
};
const signed = async (patch: Record<string, unknown> = {}) => JSON.stringify(await signObject({ ...base, ...patch }, pair.privateKey));

describe("signed releases", () => {
  test("accepts a newer release for the pinned key and exact platform", async () => {
    expect((await verifyRelease(await signed(), key, target)).sequence).toBe(4);
  });
  test("rejects payload tampering and an independently signed release", async () => {
    const raw = await signed();
    await expect(verifyRelease(raw.replace('"bytes":100', '"bytes":101'), key, target)).rejects.toThrow("signature");
    const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const forged = JSON.stringify(await signObject(base, other.privateKey));
    await expect(verifyRelease(forged, key, target)).rejects.toThrow("signature");
  });
  test("rejects replay, expiry, future dates and wrong target even when correctly signed", async () => {
    for (const patch of [
      { sequence: 3 }, { sequence: 2 }, { sequence: 4.1 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
      { expiresAt: now }, { issuedAt: now + 60_001 }, { issuedAt: -1 },
      { platform: "win32" }, { arch: "x64" }, { schema: 2 },
    ]) await expect(verifyRelease(await signed(patch), key, target)).rejects.toThrow();
  });
  test("rejects oversized manifests before parsing", async () => {
    await expect(verifyRelease(" ".repeat(MAX_MANIFEST_BYTES + 1), key, target)).rejects.toThrow("too large");
  });
  test("rejects traversal and Windows aliases on every platform", async () => {
    for (const path of ["../evil", "/evil", "engine/../evil", "engine\\evil", "C:evil", "engine/nul.dll", "CON", "foo.", "foo:bar", "engine/sub/file", "engine/."]) {
      expect(validReleasePath(path)).toBe(false);
      await expect(verifyRelease(await signed({ files: [{ ...base.files[0], path }] }), key, target)).rejects.toThrow("file");
    }
    expect(validReleasePath("engine/libggml-cpu.so.0")).toBe(true);
    expect(validReleasePath("engine/llama-server.exe")).toBe(true);
  });
  test("rejects case collisions, missing agent, invalid lengths and digests", async () => {
    for (const files of [
      [...base.files, { ...base.files[0], path: "SWARMLET-NODE" }],
      [{ ...base.files[0], path: "engine/lib.so" }],
      [{ ...base.files[0], bytes: 0 }], [{ ...base.files[0], bytes: 5 * 1024 ** 3 }],
      [{ ...base.files[0], sha256: "z".repeat(64) }], [],
    ]) await expect(verifyRelease(await signed({ files }), key, target)).rejects.toThrow();
  });
});
