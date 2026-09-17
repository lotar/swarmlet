// Stable service entry point. Updated agents/engines run from immutable side-by-side
// directories; the bootstrap executable itself is never overwritten while running.
import { basename, join } from "node:path";
import { agentPaths } from "./paths.ts";
import { loadNodeConfig } from "./config.ts";
import { loadIdentity } from "./identity.ts";
import { fetchRelease, stageRelease } from "./update-stage.ts";
import { requestUpdateLease } from "./update-lease.ts";
import { pruneReleases, readUpdateState, writeUpdateState, type InstalledRelease } from "./update-state.ts";
import { verifyRelease, type ReleaseManifest } from "../protocol/release.ts";
import { releaseFetcher } from "../protocol/release-auth.ts";

export async function supervise(baseCommand: string[], timing: Partial<Record<"initialMs" | "checkMs" | "retryMs" | "healthMs" | "stopMs" | "crashMs", number>> = {}): Promise<void> {
  const paths = agentPaths();
  const statePath = join(paths.stateDir, "updates.json");
  const releasesDir = join(paths.home, "releases");
  let state = await readUpdateState(statePath);
  // A process/host crash before health confirmation rolls back, but never lowers the replay floor.
  if (state.pending) { state.pending = null; await writeUpdateState(statePath, state); }
  const identity = await loadIdentity(paths);
  const download = releaseFetcher(identity);
  const log = (message: string) => console.log(`[updater] ${new Date().toISOString()} ${message}`);
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let candidate: { manifest: ReleaseManifest; directory: string; binding: string } | null = null;
  const binding = (cfg: ReturnType<typeof loadNodeConfig>) => JSON.stringify([cfg.controlUrl, cfg.controlPubJwk?.kty, cfg.controlPubJwk?.crv, cfg.controlPubJwk?.x]);
  const assertBinding = (expected: string) => {
    if (binding(loadNodeConfig(paths)) !== expected) { candidate = null; throw new Error("controller binding changed during update"); }
  };
  const replies = new Map<string, (ok: boolean) => void>();
  const spawn = (release: InstalledRelease | null) => {
    const env = { ...process.env, SWARMLET_HOME: paths.home, SWARMLET_SUPERVISED: "1", SWARMLET_RELEASE_SEQUENCE: String(release?.sequence ?? 0) };
    let command = baseCommand;
    if (release) {
      const directory = join(releasesDir, release.directory);
      command = [join(directory, process.platform === "win32" ? "swarmlet-node.exe" : "swarmlet-node")];
      Object.assign(env, { SWARMLET_ENGINE: join(directory, "engine") });
    }
    child = Bun.spawn([...command, "run"], { env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      ipc(message: unknown) {
        const m = message as { kind?: string; id?: string; ok?: boolean } | null;
        if (m?.kind === "swarmlet-supervisor-result" && m.id) replies.get(m.id)?.(m.ok === true);
      },
    });
    log(`started agent ${child.pid}, release ${release?.sequence ?? "bootstrap"}`);
    return child;
  };
  const ipc = async (action: "drain" | "resume"): Promise<boolean> => {
    const current = child;
    if (!current || current.exitCode !== null) return false;
    const id = crypto.randomUUID();
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { replies.delete(id); resolve(false); }, 5000);
      replies.set(id, ok => { clearTimeout(timer); replies.delete(id); resolve(ok); });
      try { current.send({ kind: "swarmlet-supervisor", id, action }); }
      catch { clearTimeout(timer); replies.delete(id); resolve(false); }
    });
  };
  const stopChild = async (): Promise<boolean> => {
    const current = child;
    if (!current || current.exitCode !== null) return true;
    try { current.send({ kind: "swarmlet-supervisor", id: crypto.randomUUID(), action: "stop" }); }
    catch { current.kill("SIGTERM"); }
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), timing.stopMs ?? 30_000);
      void current.exited.then(() => { clearTimeout(timer); resolve(true); });
    });
  };
  /** What the running child says about itself right now, or null when its local API does not answer. */
  const probe = async (current: ReturnType<typeof Bun.spawn>): Promise<{ pid?: number; nodeId?: string; connected?: boolean; releaseSequence?: number } | null> => {
    try {
      const cfg = loadNodeConfig(paths);
      const response = await fetch(`http://127.0.0.1:${cfg.uiPort}/api/status`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return null;
      return await response.json() as { pid?: number; nodeId?: string; connected?: boolean; releaseSequence?: number };
    } catch { /* startup may still be probing hardware or connecting */ return null; }
  };
  /** `requireConnected` separates the two questions this gate answers. "Is the child the process we think it is,
   *  serving the release we think it is, answering locally?" is asked before staging a swap. "And can it talk to
   *  control?" is only asked of a *trial* release, and only when the release it would replace could. */
  const healthy = async (current: ReturnType<typeof Bun.spawn>, release: InstalledRelease | null, deadline: number, requireConnected: boolean): Promise<boolean> => {
    while (!stopping && Date.now() < deadline && current.exitCode === null) {
      const cfg = loadNodeConfig(paths);
      const value = await probe(current);
      if (value && value.pid === current.pid && value.nodeId === identity.nodeId &&
          value.releaseSequence === (release?.sequence ?? 0) && (!requireConnected || !cfg.controlUrl || value.connected)) return true;
      await Bun.sleep(500);
    }
    return false;
  };
  const shutdown = () => { stopping = true; void stopChild(); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  let nextCheck = Date.now() + (timing.initialMs ?? 30_000);
  let crashDelay = timing.crashMs ?? 5000;
  let startedAt = Date.now();
  const spawnActive = async () => {
    while (!stopping) {
      try { child = spawn(state.active); return; }
      catch (error) {
        if (!state.active) throw error;
        log(`agent could not launch; rolling back release ${state.active.sequence}: ${String(error)}`);
        state = { ...state, active: state.previous, previous: null, pending: null };
        await writeUpdateState(statePath, state);
      }
    }
  };
  try {
    await spawnActive();
    while (!stopping) {
      if (!child || child.exitCode !== null) {
        if (child?.exitCode === 0) break;
        if (state.active) {
          log(`agent exited unexpectedly; rolling back release ${state.active.sequence}`);
          state = { ...state, active: state.previous, previous: null, pending: null };
          await writeUpdateState(statePath, state);
        }
        if (Date.now() - startedAt >= 60_000) crashDelay = timing.crashMs ?? 5000;
        await Bun.sleep(crashDelay);
        crashDelay = Math.min(60_000, crashDelay * 2);
        if (stopping) break;
        await spawnActive(); startedAt = Date.now();
      }
      if (Date.now() >= nextCheck) {
        nextCheck = Date.now() + (timing.checkMs ?? 5 * 60_000);
        let switching = false;
        try {
          const cfg = loadNodeConfig(paths);
          const authority = binding(cfg);
          if (candidate && candidate.binding !== authority) candidate = null;
          if (cfg.controlUrl && cfg.controlPubJwk) {
            if (!candidate) {
              const manifest = await fetchRelease({ controlUrl: cfg.controlUrl, pinnedKey: cfg.controlPubJwk,
                platform: process.platform, arch: process.arch, acceptedSequence: state.acceptedSequence, fetcher: download });
              if (manifest) {
                const directory = await stageRelease({ controlUrl: cfg.controlUrl, manifest, releasesDir, fetcher: download });
                assertBinding(authority);
                candidate = { manifest, directory, binding: authority };
                log(`verified release ${manifest.sequence}`);
              }
            }
            if (candidate && child?.exitCode === null && !stopping) {
              assertBinding(candidate.binding);
              if (candidate.manifest.expiresAt <= Date.now()) { candidate = null; continue; }
              try { await verifyRelease(JSON.stringify(candidate.manifest), cfg.controlPubJwk, { platform: process.platform, arch: process.arch, acceptedSequence: state.acceptedSequence }); }
              catch (error) { candidate = null; throw error; } // a manual controller rebind invalidates staged trust
              // Asked without `connected` on purpose. The update is fetched and staged over plain outbound
              // HTTPS, so it is the repair path for a node whose control link is broken - and requiring
              // control connectivity to install it is a bootstrap deadlock: the node that most needs the new
              // release is the node that cannot pass this check. A live node did exactly that (reconnecting
              // ~100x/day for five days, never reaching the lease, with nothing in its log to say why).
              if (!await healthy(child, state.active, Date.now() + 2000, false)) { nextCheck = Date.now() + (timing.retryMs ?? 30_000); continue; }
              assertBinding(authority);
              // Remember what the outgoing release could do, so the trial is held to the same standard it met.
              const wasConnected = Boolean((await probe(child))?.connected);
              const leaseOpts = { controlUrl: cfg.controlUrl, pinnedKey: cfg.controlPubJwk, identity };
              const lease = await requestUpdateLease(leaseOpts);
              if (lease) {
                try {
                  assertBinding(authority);
                  if (await ipc("drain") && Date.now() < lease.expiresAt - 30_000 && !stopping) {
                    assertBinding(authority);
                    switching = true;
                    const next = { directory: basename(candidate.directory), sequence: candidate.manifest.sequence };
                    state = { ...state, acceptedSequence: next.sequence, pending: next };
                    await writeUpdateState(statePath, state);
                    try { assertBinding(authority); }
                    catch (error) { state.pending = null; await writeUpdateState(statePath, state); switching = false; throw error; }
                    candidate = null;
                    if (!await stopChild()) throw new Error("old agent did not stop; retaining previous release");
                    if (stopping) break;
                    let trial: ReturnType<typeof Bun.spawn> | null = null;
                    let accepted = false;
                    try {
                      assertBinding(authority);
                      trial = spawn(next); child = trial;
                      accepted = await healthy(trial, next, Math.min(lease.expiresAt - 5000, Date.now() + (timing.healthMs ?? 90_000)), wasConnected);
                      assertBinding(authority);
                    } catch (error) { log(`trial rejected: ${String(error)}`); }
                    if (accepted && binding(loadNodeConfig(paths)) === authority) {
                      state = { ...state, previous: state.active, active: next, pending: null };
                      await writeUpdateState(statePath, state);
                      log(`activated release ${next.sequence}`);
                    } else {
                      if (!await stopChild()) throw new Error("unhealthy agent did not stop; awaiting service recovery");
                      state.pending = null; await writeUpdateState(statePath, state);
                      if (!stopping) await spawnActive();
                      log(`release ${next.sequence} failed health check; previous release restored`);
                    }
                    switching = false;
                    await pruneReleases(releasesDir, state).catch(error => log(`old release cleanup deferred: ${String(error)}`));
                  }
                } finally {
                  await ipc("resume");
                  await requestUpdateLease({ ...leaseOpts, token: lease.token }).catch(error => log(`lease release delayed: ${String(error)}`));
                }
              }
              if (candidate) nextCheck = Date.now() + (timing.retryMs ?? 30_000);
            }
          }
        } catch (error) {
          if (switching) throw error; // restart the supervisor; durable pending state selects rollback
          log(`update deferred: ${String(error)}`);
        }
      }
      await Bun.sleep(1000);
    }
  } finally {
    stopping = true;
    if (!await stopChild()) throw new Error("agent shutdown timed out");
    process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown);
  }
}
