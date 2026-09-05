#!/usr/bin/env bun
// Swarmlet node agent: daemon + CLI in one binary.
//   swarmlet-node run                          run the daemon (what the service does)
//   swarmlet-node join <control-url> <code>    enroll with a join code from the control web UI
//   swarmlet-node status                       print the daemon's /api/status
//   swarmlet-node offer set key=value ...      e.g. enabled=true ramMiB=8192 cpuCores=6 gpu.cuda:0=3072 roles.worker=true
//   swarmlet-node install | uninstall          run at login as a user service (launchd / systemd --user)
//   swarmlet-node ui                           open http://127.0.0.1:47800 in the browser
// Env: SWARMLET_HOME (state dir), SWARMLET_ENGINE (engine binaries dir), SWARMLET_LOG (debug|info|warn).

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

  constructor(home?: string) {
    this.paths = agentPaths(home);
    this.cfg = loadNodeConfig(this.paths);
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
    this.models = await listModels(this.cfg.offer.modelsDir);
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

  async join(controlUrl: string, code: string): Promise<{ nodeId: string }> {
    const caps = await this.refreshCaps();
    const res = await enroll(controlUrl, code, this.id, caps);
    this.cfg.controlUrl = controlUrl.replace(/\/$/, "");
    this.cfg.agentUrl = res.agentUrl;
    this.cfg.enrolledNodeId = res.nodeId;
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
      }),
      status: () => ({
        nodeId: this.id.nodeId, hostname: this.hostname, agentVersion: AGENT_VERSION, certFp: this.id.certFp, connected: this.client?.connected ?? false,
        controlUrl: this.cfg.controlUrl, enabled: this.cfg.offer.enabled, caps: this.caps, offer: this.cfg.offer, offerErrors: this.offerErrors(),
        assignments: this.runner.snapshot(), metrics: this.metrics, net: this.net,
      }),
      caps: () => this.caps,
      offer: () => this.cfg.offer,
      setOffer: async (offer) => { this.cfg.offer = offer; saveNodeConfig(this.paths, this.cfg); this.models = await listModels(offer.modelsDir); this.client?.sendOffer(); this.client?.sendModels(); },
      setEnabled: async (enabled) => { this.cfg.offer.enabled = enabled; saveNodeConfig(this.paths, this.cfg); this.client?.sendOffer(); },
      models: () => ({ modelsDir: this.cfg.offer.modelsDir, models: this.models }),
      rescanModels: async () => { this.models = await listModels(this.cfg.offer.modelsDir, { hash: true }); this.client?.sendModels(); return this.models; },
      join: (url, code) => this.join(url, code),
      measureNet: () => this.measure(),
      logs: (assignment, lines = 200) => (assignment ? this.runner.recentLog(assignment, lines) : this.agentLog.slice(-lines)),
    });
    log.info(`local UI http://127.0.0.1:${this.cfg.uiPort}  node ${this.id.nodeId}  cert ${this.id.certFp.slice(0, 16)}`);
    this.connect();
    this.timers.push(setInterval(() => { void this.tick(); }, 2000));
    this.timers.push(setInterval(() => { void this.refreshCaps().then(() => this.client?.send({ t: "heartbeat", ts: new Date().toISOString(), metrics: this.metrics ?? { ts: new Date().toISOString() }, caps: this.caps ?? undefined })); }, 5 * 60_000));
    this.timers.push(setInterval(() => { void this.measure().catch(() => undefined); }, 60 * 60_000));
    if (this.cfg.controlUrl) setTimeout(() => { void this.measure().catch(() => undefined); }, 3000);
    const shutdown = async () => { log.info("shutting down"); for (const t of this.timers) clearInterval(t); await this.runner.stopAll(); this.client?.stop(); process.exit(0); };
    process.on("SIGINT", () => { void shutdown(); });
    process.on("SIGTERM", () => { void shutdown(); });
  }

  private async tick(): Promise<void> {
    try {
      const pids = this.runner.snapshot().map((s) => s.pid).filter((p): p is number => typeof p === "number");
      const m = await probeMetrics({ pids, gpus: this.caps?.gpus ?? [], sampleMs: 500 });
      const srv = await this.runner.serverMetrics();
      this.metrics = { ...m, ...(srv ?? {}) };
    } catch (e) { log.debug("metrics failed", { err: (e as Error).message }); }
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
      saveNodeConfig(paths, cfg);
      try { await fetch(`http://127.0.0.1:${cfg.uiPort}/api/offer`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg.offer), signal: AbortSignal.timeout(3000) }); } catch { /* daemon not running: file updated */ }
      console.log(JSON.stringify(cfg.offer, null, 2)); return;
    }
    case "install": { const p = await installService(process.execPath.endsWith("bun") ? `${process.execPath} ${import.meta.path}` : process.execPath, paths.home, paths.logsDir); console.log(`installed ${p}`); return; }
    case "uninstall": { await uninstallService(); console.log("uninstalled"); return; }
    case "ui": { const port = loadNodeConfig(paths).uiPort; Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", `http://127.0.0.1:${port}/`]); return; }
    default: throw new Error(`unknown command ${cmd}`);
  }
}

if (import.meta.main) {
  cli(process.argv.slice(2)).catch((e: Error) => { console.error(e.message); process.exit(1); });
}
