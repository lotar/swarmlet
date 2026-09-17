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

/** Same shape as supervisor.test.ts: the real supervisor, a real compiled fixture agent, a real signed feed.
 *  The fixture reports `connected: mode === "good"`, so `behavior` is the node's control link: "good" = up,
 *  anything else = a node whose local API answers while its control connection does not. */
async function harness(initialMode: string) {
  const dir = await mkdtemp(join(tmpdir(), "swarmlet-supervisor-link-"));
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
  // Before any release is installed the fixture takes its mode from this default, which is how a test starts
  // the supervisor with a node whose control link is already down.
  await writeFile(runner, "process.env.SWARMLET_FIXTURE_DEFAULT = " + JSON.stringify(initialMode) + ";\n"
    + "import { supervise } from " + JSON.stringify(supervisor) + ";\n"
    + "await supervise([process.execPath, " + JSON.stringify(fixture) + "], { initialMs: 100, checkMs: 200, retryMs: 200, healthMs: 1800, stopMs: 2000, crashMs: 100 });\n");
  const source = join(dir, "source");
  await mkdir(join(source, "engine"), { recursive: true });
  const binary = join(source, process.platform === "win32" ? "swarmlet-node.exe" : "swarmlet-node");
  const compile = Bun.spawn([process.execPath, "build", "--compile", fixture, "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
  expect(await compile.exited).toBe(0);
  const publish = async (sequence: number, behavior: string) => {
    await writeFile(join(source, "engine/behavior"), behavior);
    await publishRelease({ dataDir: dir, source, platform: process.platform as ReleaseManifest["platform"], arch: process.arch as ReleaseManifest["arch"], sequence, version: `test-${sequence}`, priv: pair.privateKey, pub });
  };
  const start = () => Bun.spawn([process.execPath, runner], { env: { ...process.env, SWARMLET_HOME: paths.home, SWARMLET_ENGINE: undefined }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const status = async () => { try { return await (await fetch(`http://127.0.0.1:${uiPort}/api/status`, { signal: AbortSignal.timeout(500) })).json(); } catch { return null; } };
  const statePath = join(paths.stateDir, "updates.json");
  return {
    paths, uiPort, start, status, publish, statePath,
    cleanup: async (child: ReturnType<typeof start> | null) => {
      if (child) { child.kill("SIGKILL"); await child.exited; }
      server.stop(true); manager.dispose(); reg.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const until = async (predicate: () => Promise<boolean>, current: () => ReturnType<typeof Bun.spawn> | null, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    const child = current();
    if (child && child.exitCode !== null) throw new Error(`supervisor exited ${child.exitCode}: ${await new Response(child.stderr as ReadableStream | null).text()}`);
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(50);
  }
};

test("a node whose agent cannot reach control still installs an update", async () => {
  // The live shape of the node this trapped: local API answering, right release, no control link. The
  // pre-swap gate used to require `connected`, which gated the update on the very thing the update repairs.
  const h = await harness("silent");
  let child: ReturnType<typeof h.start> | null = null;
  try {
    child = h.start();
    await until(async () => (await h.status())?.releaseSequence === 0, () => child);
    expect((await h.status())?.connected).toBe(false);   // the node really is in the broken state

    await h.publish(1, "good");
    await until(async () => (await readUpdateState(h.statePath)).active?.sequence === 1, () => child);
    expect((await h.status())?.releaseSequence).toBe(1);
    expect((await h.status())?.connected).toBe(true);    // and the new release brought the link back
  } finally { await h.cleanup(child); }
}, 60_000);

test("a release that cannot reconnect is still refused when the running one can", async () => {
  // The safety property the gate was protecting: a release must not replace one that is connected if it
  // cannot connect itself. That is why the requirement moved to the trial rather than disappearing.
  const h = await harness("good");
  let child: ReturnType<typeof h.start> | null = null;
  try {
    child = h.start();
    await until(async () => (await h.status())?.releaseSequence === 0, () => child);
    await h.publish(1, "good");
    await until(async () => (await readUpdateState(h.statePath)).active?.sequence === 1, () => child);

    await h.publish(2, "silent");
    await until(async () => (await readUpdateState(h.statePath)).pending?.sequence === 2, () => child);
    await until(async () => (await readUpdateState(h.statePath)).pending === null, () => child);
    // The failed trial stops its process before the previous release is respawned, so wait for the agent
    // to be answering again rather than sampling into that gap.
    await until(async () => (await h.status())?.releaseSequence === 1, () => child);
    expect((await readUpdateState(h.statePath)).active?.sequence).toBe(1);   // rolled back
    expect((await h.status())?.releaseSequence).toBe(1);
  } finally { await h.cleanup(child); }
}, 60_000);
