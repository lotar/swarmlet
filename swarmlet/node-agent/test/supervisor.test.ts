import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { agentPaths } from "../paths.ts";
import { loadNodeConfig, saveNodeConfig } from "../config.ts";
import { loadIdentity } from "../identity.ts";
import { readUpdateState } from "../update-state.ts";
import { publishRelease } from "../../control/publish-release.ts";
import { authenticatedReleaseRead, serveRelease } from "../../control/releases.ts";
import { createUpdateLeaseHandler } from "../../control/update-lease.ts";
import { Registry } from "../../control/registry.ts";
import { DeploymentManager } from "../../control/deployments.ts";
import type { AgentChannel } from "../../control/channel.ts";
import type { ReleaseManifest } from "../../protocol/release.ts";

test("real supervisor activates signed compiled agents, rolls back bad health and recovers a killed update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-supervisor-"));
  const paths = agentPaths(join(dir, "node"));
  const identity = await loadIdentity(paths);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const reg = new Registry(":memory:");
  reg.upsertNode({ id: identity.nodeId, pubJwk: identity.pubJwk, certFp: identity.certFp, hostname: "test", os: process.platform, arch: process.arch });
  const manager = new DeploymentManager({ reg, channel: { isOnline: () => true } as unknown as AgentChannel, profiles: new Map(), log: { debug() {}, info() {}, warn() {}, error() {} } });
  const lease = createUpdateLeaseHandler(reg, manager, async () => pair.privateKey);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => new URL(req.url).pathname === "/node-update-lease" ? lease(req)
    : await authenticatedReleaseRead(req, reg) ? serveRelease(dir, req) : new Response(null, { status: 404 }) });
  const unused = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const uiPort = unused.port!; unused.stop(true);
  const cfg = loadNodeConfig(paths);
  saveNodeConfig(paths, { ...cfg, uiPort, controlUrl: `http://127.0.0.1:${server.port}`, controlPubJwk: pub });
  const fixture = fileURLToPath(new URL("fixtures/update-agent.ts", import.meta.url));
  const supervisor = fileURLToPath(new URL("../supervisor.ts", import.meta.url));
  const runner = join(dir, "supervise.ts");
  await writeFile(runner, `import { supervise } from ${JSON.stringify(supervisor)}; await supervise([process.execPath, ${JSON.stringify(fixture)}], { initialMs: 100, checkMs: 200, retryMs: 200, healthMs: 1800, stopMs: 2000, crashMs: 100 });`);
  const start = () => Bun.spawn([process.execPath, runner], { env: { ...process.env, SWARMLET_HOME: paths.home, SWARMLET_ENGINE: undefined }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let child: ReturnType<typeof start> | null = null;
  const until = async (predicate: () => Promise<boolean>, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (!await predicate()) {
      if (child && child.exitCode !== null) throw new Error(`supervisor exited ${child.exitCode}: ${await new Response(child.stderr).text()}`);
      if (Date.now() > deadline) throw new Error("supervisor condition timed out");
      await Bun.sleep(50);
    }
  };
  const status = async () => { try { return await (await fetch(`http://127.0.0.1:${uiPort}/api/status`, { signal: AbortSignal.timeout(500) })).json(); } catch { return null; } };
  const statePath = join(paths.stateDir, "updates.json");
  try {
    const source = join(dir, "source"); await mkdir(join(source, "engine"), { recursive: true });
    const binary = join(source, process.platform === "win32" ? "swarmlet-node.exe" : "swarmlet-node");
    const compile = Bun.spawn([process.execPath, "build", "--compile", fixture, "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
    expect(await compile.exited).toBe(0);
    const publish = async (sequence: number, behavior: string) => {
      await writeFile(join(source, "engine/behavior"), behavior);
      await publishRelease({ dataDir: dir, source, platform: process.platform as ReleaseManifest["platform"], arch: process.arch as ReleaseManifest["arch"], sequence, version: `test-${sequence}`, priv: pair.privateKey, pub });
    };
    child = start();
    await until(async () => (await status())?.releaseSequence === 0);
    await publish(1, "good");
    expect((await fetch(`${cfg.controlUrl ?? `http://127.0.0.1:${server.port}`}/releases/${process.platform}-${process.arch}/manifest.json`)).status).toBe(404);
    await until(async () => (await readUpdateState(statePath)).active?.sequence === 1);
    expect((await status())?.releaseSequence).toBe(1);
    await publish(2, "bad");
    await until(async () => { const s = await readUpdateState(statePath); return s.acceptedSequence === 2 && s.pending === null; });
    await until(async () => (await status())?.releaseSequence === 1);
    expect((await readUpdateState(statePath)).active?.sequence).toBe(1);
    await publish(3, "bad");
    await until(async () => (await readUpdateState(statePath)).pending?.sequence === 3);
    child!.kill("SIGKILL"); await child!.exited;
    child = null;
    await until(async () => await status() === null); // IPC disconnect also stops the orphan
    child = start();
    await until(async () => (await status())?.releaseSequence === 1);
    const recovered = await readUpdateState(statePath);
    expect(recovered.pending).toBeNull();
    expect(recovered.acceptedSequence).toBe(3);
    // Windows kill(SIGTERM) is unconditional termination. Exercise the same graceful
    // local shutdown route exposed by the real agent; POSIX services use SIGTERM.
    if (process.platform === "win32") expect((await fetch(`http://127.0.0.1:${uiPort}/api/shutdown`, { method: "POST" })).status).toBe(200);
    else child!.kill("SIGTERM");
    expect(await child!.exited).toBe(0); child = null;
    expect(await status()).toBeNull();
  } finally {
    if (child) { child.kill("SIGKILL"); await child.exited; }
    server.stop(true); manager.dispose(); reg.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
