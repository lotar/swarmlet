#!/usr/bin/env bun
// bun run control/macos-release-check.ts <agent-dist>   (on a Mac, after node-shell/scripts/build-release.sh)
// A darwin release is published only when its agent and the Mac app a node assembles from it pass codesign.
// The controller host is Linux and has no codesign, so the Mac writes an attestation of the bytes it verified
// and the publisher checks that the release it is about to sign carries exactly those bytes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAC_APP_DESCRIPTOR, parseMacDesktop } from "../protocol/desktop.ts";
import type { ReleaseFile } from "../protocol/release.ts";

export const MAC_ATTESTATION = "macos-codesign.json";

export interface MacAttestation { kind: "swarmlet-macos-codesign"; schema: 1; verifiedAt: string; files: Record<string, string> }
export type CodesignRunner = (args: string[]) => Promise<{ code: number; output: string }>;

const codesign: CodesignRunner = async (args) => {
  const proc = Bun.spawn(["/usr/bin/codesign", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 300_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: (stdout + stderr).trim() };
  } finally { clearTimeout(timer); }
};

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** The service agent, the descriptor and every file the descriptor installs, as release paths. */
async function macPayload(source: string) {
  let raw: string;
  try { raw = await readFile(join(source, MAC_APP_DESCRIPTOR), "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`darwin release has no ${MAC_APP_DESCRIPTOR}; build it with node-shell/scripts/build-release.sh`);
    throw e;
  }
  const present = ["swarmlet-node", ...(await readdir(join(source, "engine"))).map((name) => `engine/${name}`)];
  const desktop = parseMacDesktop(raw, { platform: "darwin", files: present.map((path) => ({ path }) as ReleaseFile) });
  const sources = [...new Set(["swarmlet-node", MAC_APP_DESCRIPTOR, ...desktop.files.map((f) => f.source)])].sort();
  return { desktop, sources };
}

async function hashes(source: string, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of paths) {
    if (!(await lstat(join(source, path))).isFile()) throw new Error(`release source is not a regular file: ${path}`);
    out[path] = await sha256(join(source, path));
  }
  return out;
}

/** macOS only: codesign the agent alone, then the app exactly as a node rebuilds it, and record the bytes. */
export async function attestMacRelease(source: string, run: CodesignRunner = codesign): Promise<MacAttestation> {
  const { desktop, sources } = await macPayload(source);
  const agent = await run(["--verify", "--strict", join(source, "swarmlet-node")]);
  if (agent.code !== 0) throw new Error(`swarmlet-node fails codesign --verify --strict: ${agent.output.slice(-500)}`);
  const scratch = await mkdtemp(join(tmpdir(), "swarmlet-macos-check-"));
  try {
    const app = join(scratch, "Swarmlet Node.app");
    for (const file of desktop.files) {
      const destination = join(app, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await copyFile(join(source, file.source), destination);
      await chmod(destination, file.mode);
    }
    const bundle = await run(["--verify", "--deep", "--strict", app]);
    if (bundle.code !== 0) throw new Error(`Mac app assembled from ${MAC_APP_DESCRIPTOR} fails codesign --verify --deep --strict: ${bundle.output.slice(-500)}`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  const attestation: MacAttestation = { kind: "swarmlet-macos-codesign", schema: 1, verifiedAt: new Date().toISOString(), files: await hashes(source, sources) };
  await writeFile(join(source, MAC_ATTESTATION), JSON.stringify(attestation, null, 2) + "\n");
  return attestation;
}

/** Any host: the release must carry exactly the bytes a Mac verified, no more and no fewer. */
export async function checkMacAttestation(source: string): Promise<void> {
  let attestation: MacAttestation;
  try { attestation = JSON.parse(await readFile(join(source, MAC_ATTESTATION), "utf8")); }
  catch { throw new Error(`darwin release has no readable ${MAC_ATTESTATION}; run control/macos-release-check.ts on a Mac and ship the file with the payload`); }
  if (attestation?.kind !== "swarmlet-macos-codesign" || attestation.schema !== 1 || !attestation.files || typeof attestation.files !== "object") throw new Error(`invalid ${MAC_ATTESTATION}`);
  const { sources } = await macPayload(source);
  const actual = await hashes(source, sources);
  const attested = Object.keys(attestation.files).sort();
  if (attested.join("\n") !== sources.join("\n")) throw new Error(`${MAC_ATTESTATION} covers a different file set than this release`);
  for (const path of sources) if (attestation.files[path] !== actual[path]) throw new Error(`${path} differs from the codesign-verified build`);
}

/** The publisher's gate. On a Mac it re-verifies; elsewhere it trusts only a matching attestation. */
export async function verifyMacReleaseSource(source: string, opts: { host?: string; run?: CodesignRunner } = {}): Promise<void> {
  if ((opts.host ?? process.platform) === "darwin") await attestMacRelease(source, opts.run);
  await checkMacAttestation(source);
}

if (import.meta.main) {
  const [source] = process.argv.slice(2);
  if (!source) throw new Error("usage: macos-release-check.ts <agent-dist>");
  if (process.platform !== "darwin") throw new Error("codesign verification needs macOS");
  const a = await attestMacRelease(source);
  console.log(`codesign verified: agent ${a.files["swarmlet-node"]}, ${Object.keys(a.files).length} files attested in ${join(source, MAC_ATTESTATION)}`);
}
