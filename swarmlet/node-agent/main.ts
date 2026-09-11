#!/usr/bin/env bun
// Swarmlet node agent: daemon + CLI in one binary.
//   swarmlet-node run                          run the daemon (what the service does)
//   swarmlet-node join <control-url> <code>    enroll with a join code from the control web UI
//   swarmlet-node status                       print the daemon's /api/status
//   swarmlet-node offer set key=value ...      e.g. enabled=true ramMiB=8192 cpuCores=6 gpu.cuda:0=3072 roles.worker=true
//   swarmlet-node install | uninstall          run at login as a user service (launchd / systemd --user)
//   swarmlet-node ui                           open http://127.0.0.1:47800 in the browser
// Env: SWARMLET_HOME (state dir), SWARMLET_ENGINE (engine binaries dir), SWARMLET_LOG (debug|info|warn).

import { join as joinPath } from "node:path";
import { hostname as osHostname } from "node:os";
import { makeLogger } from "../control/log.ts";
import { validateOffer } from "../protocol/validate.ts";
import type { Capabilities, ModelFile, NetMeasurement, NodeMetrics, Offer } from "../protocol/types.ts";
import { AGENT_VERSION, AgentClient, enroll } from "./agent.ts";
import { AssignmentRunner } from "./assignments.ts";
import { loadNodeConfig, saveNodeConfig, type NodeConfig } from "./config.ts";
import { loadIdentity, type Identity } from "./identity.ts";
import { installService, uninstallService } from "./install.ts";
import { startLocalApi } from "./localapi.ts";
import { createNodeInference } from "./inference.ts";
import { discoverControl } from "./discovery.ts";
import { FanManager } from "./fans.ts";
import { NetworkSampler } from "./probe/network.ts";
import { UpdateDrain } from "./update-drain.ts";
import { supervise } from "./supervisor.ts";
import { DesktopAppUpdater } from "./desktop-update.ts";
import { agentPaths, type AgentPaths } from "./paths.ts";
import { listModels, measureNet, probeCapabilities, probeMetrics, publicIp } from "./probe/index.ts";
import { startDataListener } from "./transport/dataListener.ts";

const log = makeLogger("agent", (process.env.SWARMLET_LOG as "debug" | "info" | "warn" | undefined) ?? "info");

export class AgentRuntime {
  paths: AgentPaths;
  cfg: NodeConfig;
  id!: Identity;
  caps: Capabilities | null = null;
  models: ModelFile[] = [];
  metrics: NodeMetrics | null = null;
  net: NetMeasurement | null = null;
  client: AgentClient | null = null;
  runner!: AssignmentRunner;
  private agentLog: string[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private ticking = false;
  private fans: FanManager;
  private network = new NetworkSampler();
  private updateDrain = new UpdateDrain();
  private desktop: DesktopAppUpdater;

  constructor(home?: string) {
    this.paths = agentPaths(home);
    this.cfg = loadNodeConfig(this.paths);
    this.fans = new FanManager(this.cfg.enginePath);
    this.desktop = new DesktopAppUpdater(this.paths, () => this.cfg.controlPubJwk, log);
  }

  get hostname(): string { return this.caps?.hostname ?? osHostname(); }

  async init(): Promise<void> {
    this.id = await loadIdentity(this.paths);
    this.runner = new AssignmentRunner({
      cfg: () => this.cfg, stateDir: this.paths.stateDir, certPem: this.id.certPem, keyPem: this.id.keyPem, log,
      report: (id, state, detail, ports) => this.client?.reportAssignment(id, state, detail, ports),
      logLine: (id, line) => { this.client?.logLine(id, line); },
      openRelay: (t, p) => this.client?.openRelay(t, p) ?? null,
      freeRamMiB: async () => (await probeMetrics({ gpus: this.caps?.gpus ?? [] })).freeRamMiB,
    });
    await this.runner.recover();
    await this.refreshCaps();
    this.models = await listModels(this.cfg.offer.modelsDir, { cacheFile: joinPath(this.paths.stateDir, "model-hashes.json") });
  }

  async refreshCaps(): Promise<Capabilities> {
    const caps = await probeCapabilities({ enginePath: this.cfg.enginePath, controlUrl: this.cfg.controlUrl ?? undefined, log });
    caps.dataPort = this.cfg.dataPort;
    if (this.net) caps.net = this.net;
    this.caps = caps;
    return caps;
  }

  offerErrors(): string[] {
    if (!this.caps) return [];
    const v = validateOffer(this.cfg.offer, this.caps);
    return v.ok ? [] : v.errors;
  }

  /** The offer control sees: disabled (and therefore unusable) when the owner's offer is invalid for this machine. */
  effectiveOffer(): Offer {
    const errs = this.offerErrors();
    return errs.length ? { ...this.cfg.offer, enabled: false } : this.cfg.offer;
  }

  async join(controlUrl: string, code: string, expectedKey?: JsonWebKey): Promise<{ nodeId: string }> {
    const caps = await this.refreshCaps();
    const res = await enroll(controlUrl, code, this.id, caps, expectedKey);
    this.cfg.controlUrl = controlUrl.replace(/\/$/, "");
    this.cfg.agentUrl = res.agentUrl;
    this.cfg.enrolledNodeId = res.nodeId;
    this.cfg.controlPubJwk = res.controlPubJwk;
    saveNodeConfig(this.paths, this.cfg);
    this.connect();
    setTimeout(() => { void this.measure().catch(() => undefined); }, 3000); // rtt/bandwidth right after joining, not only hourly
    return { nodeId: res.nodeId };
  }

  connect(): void {
    if (!this.cfg.agentUrl) return;
    this.client?.stop();
    this.client = new AgentClient(this.cfg.agentUrl, this.id, {
      caps: () => this.caps!,
      offer: () => this.effectiveOffer(),
      models: () => this.models,
      metrics: () => this.metrics ?? { ts: new Date().toISOString() },
      assignments: () => this.runner.states(),
      onAssign: (a) => this.runner.handle(a),
      allowedPorts: () => this.runner.allowedPorts(),
    }, log);
    this.client.start();
  }

  async start(): Promise<void> {
    await this.init();
    startDataListener({
      host: "0.0.0.0", port: this.cfg.dataPort, certPem: this.id.certPem, keyPem: this.id.keyPem, log,
      policy: { allowedFingerprints: () => this.runner.allowedFingerprints(), allowedPorts: () => this.runner.allowedPorts() },
    });
    startLocalApi(this.cfg.uiPort, {
      inference: createNodeInference({
        local: () => this.runner.inferenceTargets(),
        remote: () => {
          if (!this.cfg.agentUrl || !this.client?.inferenceKey) return null;
          const url = new URL(this.cfg.agentUrl);
          url.protocol = url.protocol === "wss:" ? "https:" : "http:";
          url.pathname = "/"; url.search = ""; url.hash = "";
          return { url: url.toString(), key: this.client.inferenceKey };
        },
        nodeId: () => this.id.nodeId,
        admit: () => this.updateDrain.admit(),
      }),
      status: () => ({
        nodeId: this.id.nodeId, pid: process.pid, releaseSequence: Number(process.env.SWARMLET_RELEASE_SEQUENCE ?? 0), hostname: this.hostname, agentVersion: AGENT_VERSION, certFp: this.id.certFp, connected: this.client?.connected ?? false,
        controlUrl: this.cfg.controlUrl, enabled: this.cfg.offer.enabled, caps: this.caps, offer: this.cfg.offer, offerErrors: this.offerErrors(),
        assignments: this.runner.snapshot(), metrics: this.metrics, net: this.net,
        desktopUpdate: this.desktop.status,
      }),
      caps: () => this.caps,
      offer: () => this.cfg.offer,
      setOffer: async (offer) => { this.runner.assertOfferChange(offer); this.cfg.offer = offer; saveNodeConfig(this.paths, this.cfg); this.models = await listModels(offer.modelsDir, { cacheFile: joinPath(this.paths.stateDir, "model-hashes.json") }); this.client?.sendOffer(); this.client?.sendModels(); },
      setEnabled: async (enabled) => { const next = { ...this.cfg.offer, enabled }; if (!this.caps) throw new Error("capabilities not probed yet"); const v = validateOffer(next, this.caps); if (!v.ok) throw new Error(v.errors.join("; ")); this.runner.assertOfferChange(next); this.cfg.offer.enabled = enabled; saveNodeConfig(this.paths, this.cfg); this.client?.sendOffer(); },
      models: () => ({ modelsDir: this.cfg.offer.modelsDir, models: this.models }),
      rescanModels: async () => { this.models = await listModels(this.cfg.offer.modelsDir, { hash: true, cacheFile: joinPath(this.paths.stateDir, "model-hashes.json") }); this.client?.sendModels(); return this.models; },
      join: (url, code) => this.join(url, code),
      measureNet: () => this.measure(),
      logs: (assignment, lines = 200) => (assignment ? this.runner.recentLog(assignment, lines) : this.agentLog.slice(-lines)),
      shutdown: () => shutdown("local api"),
    });
    log.info(`local UI http://127.0.0.1:${this.cfg.uiPort}  node ${this.id.nodeId}  cert ${this.id.certFp.slice(0, 16)}`);
    this.connect();
    this.timers.push(setTimeout(() => { void this.desktop.tick(); }, 5000));
    this.timers.push(setInterval(() => { void this.desktop.tick(); }, 30000));
    this.timers.push(setInterval(() => { void this.tick(); }, 2000));
    const stopDiscovery = this.cfg.discovery !== false ? discoverControl({ bound: () => !!this.cfg.controlUrl, join: (url, key) => this.join(url, "", key), log }) : () => {};
    this.timers.push(setInterval(() => { void this.refreshCaps().then(() => this.client?.send({ t: "heartbeat", ts: new Date().toISOString(), metrics: this.metrics ?? { ts: new Date().toISOString() }, caps: this.caps ?? undefined })); }, 5 * 60_000));
    this.timers.push(setInterval(() => { void this.measure().catch(() => undefined); }, 60 * 60_000));
    if (this.cfg.controlUrl) setTimeout(() => { void this.measure().catch(() => undefined); }, 3000);
    let stopping = false;
    const shutdown = async (why: string) => {
      if (stopping) return; stopping = true;
      log.info("shutting down", { why }); stopDiscovery(); for (const t of this.timers) clearInterval(t);
      try { await this.runner.stopAll(); }
      catch (error) { log.error("runner shutdown failed", { error: String(error) }); }
      finally {
        await this.fans.stop().catch(error => log.error("fan restoration failed", { error: String(error) }));
        this.client?.stop();
      }
      process.exit(0);
    };
    process.on("SIGINT", () => { void shutdown("SIGINT"); });
    process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
    if (process.env.SWARMLET_SUPERVISED === "1") process.on("disconnect", () => { void shutdown("service supervisor disconnected"); });
    // IPC exists only when our service supervisor spawned this process; no HTTP shutdown token.
    process.on("message", (message: unknown) => {
      const m = message as { kind?: string; id?: string; action?: string } | null;
      if (m?.kind !== "swarmlet-supervisor" || typeof m.id !== "string" || !process.send) return;
      if (m.action === "drain") process.send({ kind: "swarmlet-supervisor-result", id: m.id, ok: this.updateDrain.begin() });
      if (m.action === "resume") { this.updateDrain.resume(); process.send({ kind: "swarmlet-supervisor-result", id: m.id, ok: true }); }
      if (m.action === "stop") void shutdown("service supervisor");
    });
    await this.fans.start().catch(error => log.warn("fan control unavailable", { error: String(error) }));
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const pids = [process.pid, ...this.runner.snapshot().map((s) => s.pid).filter((p): p is number => typeof p === "number")];
      const [m, hardware, network] = await Promise.all([
        probeMetrics({ pids, gpus: this.caps?.gpus ?? [], sampleMs: 500 }),
        this.fans.sample().catch(() => undefined),
        this.network.sample().catch(() => undefined),
      ]);
      const srv = await this.runner.serverMetrics();
      this.metrics = { ...m, ...(srv ?? {}), link: this.client?.link, hardware, network };
    } catch (e) { log.debug("metrics failed", { err: (e as Error).message }); }
    finally { this.ticking = false; }
  }

  private async measure(): Promise<NetMeasurement> {
    if (!this.cfg.controlUrl) throw new Error("not joined to a control plane");
    const net = await measureNet(this.cfg.controlUrl);
    this.net = net;
    if (this.caps) {
      this.caps.net = net;
      try { this.caps.publicIp = await publicIp(this.cfg.controlUrl); } catch { /* optional */ }
      this.client?.send({ t: "heartbeat", ts: new Date().toISOString(), metrics: this.metrics ?? { ts: new Date().toISOString() }, caps: { net, publicIp: this.caps.publicIp } });
    }
    return net;
  }
}

// ---------- CLI ----------

async function cli(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "run";
  const paths = agentPaths();
  const status = async () => (await fetch(`http://127.0.0.1:${loadNodeConfig(paths).uiPort}/api/status`, { signal: AbortSignal.timeout(3000) })).json();
  switch (cmd) {
    case "run": { const rt = new AgentRuntime(); await rt.start(); return; }
    case "supervise": {
      await supervise(/(^|[\\/])bun(\.exe)?$/.test(process.execPath) ? [process.execPath, import.meta.path] : [process.execPath]);
      return;
    }
    case "join": {
      const [url, code] = [argv[1], argv[2]];
      if (!url || !code) throw new Error("usage: join <control-url> <code>");
      try { // prefer the running daemon so it reconnects live
        const r = await fetch(`http://127.0.0.1:${loadNodeConfig(paths).uiPort}/api/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ controlUrl: url, code }), signal: AbortSignal.timeout(20_000) });
        const out = (await r.json()) as { nodeId?: string; error?: string };
        if (!r.ok) throw new Error(out.error ?? `status ${r.status}`);
        console.log(`joined as ${out.nodeId} (daemon)`); return;
      } catch (e) {
        if (!(e instanceof TypeError) && !String((e as Error).message).includes("ECONNREFUSED") && !String((e as Error).message).includes("Unable to connect")) throw e;
      }
      const rt = new AgentRuntime(); await rt.init(); const res = await rt.join(url, code); console.log(`joined as ${res.nodeId}; start the daemon with: swarmlet-node run`); rt.client?.stop(); return;
    }
    case "status": { console.log(JSON.stringify(await status(), null, 2)); return; }
    case "offer": {
      if (argv[1] !== "set") throw new Error("usage: offer set key=value ...");
      const cfg = loadNodeConfig(paths); const o = cfg.offer as unknown as Record<string, unknown>;
      for (const kv of argv.slice(2)) {
        const [k, v] = kv.split("=", 2) as [string, string];
        if (k.startsWith("roles.")) (o.roles as Record<string, boolean>)[k.slice(6)] = v === "true";
        else if (k.startsWith("gpu.")) { const id = k.slice(4); const gpu = o.gpu as Array<{ id: string; memMiB: number }>; const cur = gpu.find((g) => g.id === id); if (cur) cur.memMiB = Number(v); else gpu.push({ id, memMiB: Number(v) }); }
        else if (k === "enabled") o.enabled = v === "true";
        else if (k === "modelsDir") o.modelsDir = v;
        else if (["ramMiB", "cpuCores", "diskMiB"].includes(k)) o[k] = Number(v);
        else throw new Error(`unknown offer key ${k}`);
      }
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${cfg.uiPort}/api/offer`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg.offer), signal: AbortSignal.timeout(3000) });
      } catch (error) {
        // A timeout may have applied remotely: only a refused connection proves the daemon is absent.
        if ((error as { code?: string }).code !== "ECONNREFUSED") throw error;
        const caps = await probeCapabilities({ enginePath: cfg.enginePath, log });
        const validated = validateOffer(cfg.offer, caps);
        if (!validated.ok) throw new Error(validated.errors.join("; "));
        cfg.offer = validated.value;
        saveNodeConfig(paths, cfg);
        console.log(JSON.stringify(cfg.offer, null, 2)); return;
      }
      if (!response.ok) throw new Error(`offer rejected (${response.status}): ${await response.text()}`);
      console.log(JSON.stringify(cfg.offer, null, 2)); return;
    }
    case "install": {
      const fromSource = /(^|[\\/])bun(\.exe)?$/.test(process.execPath); // `bun run main.ts install`: the service must run the same source
      const p = await installService(fromSource ? [process.execPath, import.meta.path] : process.execPath, paths.home, paths.logsDir);
      console.log(`installed ${p}`); return;
    }
    case "uninstall": { await uninstallService(); console.log("uninstalled"); return; }
    case "ui": {
      const url = `http://127.0.0.1:${loadNodeConfig(paths).uiPort}/`;
      const opener = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
      Bun.spawn(opener); return;
    }
    default: throw new Error(`unknown command ${cmd}`);
  }
}

if (import.meta.main) {
  cli(process.argv.slice(2)).catch((e: Error) => { console.error(e.message); process.exit(1); });
}
