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
  let candidate: { manifest: ReleaseManifest; directory: string } | null = null;
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
  const healthy = async (current: ReturnType<typeof Bun.spawn>, release: InstalledRelease | null, deadline: number): Promise<boolean> => {
    while (!stopping && Date.now() < deadline && current.exitCode === null) {
      try {
        const cfg = loadNodeConfig(paths);
        const response = await fetch(`http://127.0.0.1:${cfg.uiPort}/api/status`, { signal: AbortSignal.timeout(2000) });
        const value = await response.json() as { pid?: number; nodeId?: string; connected?: boolean; releaseSequence?: number };
        if (response.ok && value.pid === current.pid && value.nodeId === identity.nodeId &&
            value.releaseSequence === (release?.sequence ?? 0) && (!cfg.controlUrl || value.connected)) return true;
      } catch { /* startup may still be probing hardware or connecting */ }
      await Bun.sleep(500);
    }
    return false;
  };
  const shutdown = () => { stopping = true; void stopChild(); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  let nextCheck = Date.now() + (timing.initialMs ?? 30_000);
  let crashDelay = timing.crashMs ?? 5000;
  let startedAt = Date.now();
  child = spawn(state.active);
  try {
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
        child = spawn(state.active); startedAt = Date.now();
      }
      if (Date.now() >= nextCheck) {
        nextCheck = Date.now() + (timing.checkMs ?? 5 * 60_000);
        let switching = false;
        try {
          const cfg = loadNodeConfig(paths);
          if (cfg.controlUrl && cfg.controlPubJwk) {
            if (!candidate) {
              const manifest = await fetchRelease({ controlUrl: cfg.controlUrl, pinnedKey: cfg.controlPubJwk,
                platform: process.platform, arch: process.arch, acceptedSequence: state.acceptedSequence, fetcher: download });
              if (manifest) {
                const directory = await stageRelease({ controlUrl: cfg.controlUrl, manifest, releasesDir, fetcher: download });
                candidate = { manifest, directory };
                log(`verified release ${manifest.sequence}`);
              }
            }
            if (candidate && child?.exitCode === null && !stopping) {
              if (candidate.manifest.expiresAt <= Date.now()) { candidate = null; continue; }
              try { await verifyRelease(JSON.stringify(candidate.manifest), cfg.controlPubJwk, { platform: process.platform, arch: process.arch, acceptedSequence: state.acceptedSequence }); }
              catch (error) { candidate = null; throw error; } // a manual controller rebind invalidates staged trust
              if (!await healthy(child, state.active, Date.now() + 2000)) { nextCheck = Date.now() + (timing.retryMs ?? 30_000); continue; }
              const leaseOpts = { controlUrl: cfg.controlUrl, pinnedKey: cfg.controlPubJwk, identity };
              const lease = await requestUpdateLease(leaseOpts);
              if (lease) {
                try {
                  if (await ipc("drain") && Date.now() < lease.expiresAt - 30_000 && !stopping) {
                    switching = true;
                    const next = { directory: basename(candidate.directory), sequence: candidate.manifest.sequence };
                    state = { ...state, acceptedSequence: next.sequence, pending: next };
                    await writeUpdateState(statePath, state);
                    candidate = null;
                    if (!await stopChild()) throw new Error("old agent did not stop; retaining previous release");
                    if (stopping) break;
                    const trial = spawn(next); child = trial;
                    if (await healthy(trial, next, Math.min(lease.expiresAt - 5000, Date.now() + (timing.healthMs ?? 90_000)))) {
                      state = { ...state, previous: state.active, active: next, pending: null };
                      await writeUpdateState(statePath, state);
                      log(`activated release ${next.sequence}`);
                    } else {
                      if (!await stopChild()) throw new Error("unhealthy agent did not stop; awaiting service recovery");
                      state.pending = null; await writeUpdateState(statePath, state);
                      if (!stopping) child = spawn(state.active);
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
