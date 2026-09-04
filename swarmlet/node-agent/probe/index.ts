// Hardware/OS probes for the node agent: what this machine has (Capabilities), what it is doing
// (NodeMetrics), which GGUF files it holds (listModels) and how it reaches control (measureNet).
// Nothing here throws because a tool is missing: every collector degrades to partial data and logs.

import { availableParallelism, homedir, hostname, totalmem, userInfo } from "node:os";
import { defaultRamReserveMiB } from "../../protocol/validate.ts";
import type { Capabilities, GpuDevice, NodeMetrics } from "../../protocol/types.ts";
import { makeLogger, type Logger } from "../../control/log.ts";
import { darwinCpuPct, darwinFreeRamMiB, darwinGpusFallback } from "./darwin.ts";
import { engineDevices, engineInfo } from "./engine.ts";
import { diskFreeMiB, privateIps, rssMiB } from "./host.ts";
import { linuxCgroup, linuxCpuPct, linuxFreeRamMiB, linuxGpuUsed, linuxGpusFallback } from "./linux.ts";
import { measureNet, publicIp } from "./net.ts";

export * from "./exec.ts";
export * from "./engine.ts";
export * from "./host.ts";
export * from "./darwin.ts";
export * from "./linux.ts";
export * from "./models.ts";
export * from "./net.ts";

const MiB = 1024 * 1024;

function platformOf(p: string): Capabilities["os"] {
  if (p === "darwin" || p === "linux") return p;
  throw new Error(`unsupported platform ${p}`);
}

function archOf(a: string): Capabilities["arch"] {
  if (a === "arm64" || a === "x64") return a;
  throw new Error(`unsupported arch ${a}`);
}

const uid = (): number => process.getuid?.() ?? userInfo().uid;

async function attempt<T>(log: Logger, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    log.warn(`${what}: ${(e as Error).message}`);
    return undefined;
  }
}

/** The engine's own device list is authoritative; OS tools only stand in when it cannot run. */
async function probeGpus(os: Capabilities["os"], arch: string, enginePath: string, ramMiB: number, log: Logger): Promise<GpuDevice[]> {
  const fromEngine = await engineDevices(enginePath);
  if (fromEngine.ok) {
    if (fromEngine.gpus.length === 0) log.warn("gpu: engine lists no GPU device", { enginePath });
    return fromEngine.gpus;
  }
  log.warn(`gpu: ${fromEngine.reason}; falling back to ${os === "darwin" ? "system_profiler" : "nvidia-smi"}`);
  const fallback = await attempt(log, "gpu", () => (os === "darwin" ? darwinGpusFallback(ramMiB, arch) : linuxGpusFallback()));
  return fallback ?? [];
}

export interface ProbeCapabilitiesOptions {
  /** Directory holding llama-server and ggml-rpc-server (and their sha256.txt). */
  enginePath: string;
  /** When given, net (rtt/down/up) and publicIp are measured against control. */
  controlUrl?: string;
  log?: Logger;
}

export async function probeCapabilities(opts: ProbeCapabilitiesOptions): Promise<Capabilities> {
  const log = opts.log ?? makeLogger("probe");
  const os = platformOf(process.platform);
  const arch = archOf(process.arch);
  const ramMiB = Math.floor(totalmem() / MiB);
  const cpuCores = availableParallelism();

  const [gpus, disk, cgroup, engine] = await Promise.all([
    probeGpus(os, arch, opts.enginePath, ramMiB, log),
    attempt(log, "disk", () => diskFreeMiB(homedir())),
    os === "linux" ? attempt(log, "cgroup", () => linuxCgroup(uid())) : Promise.resolve(undefined),
    engineInfo(opts.enginePath, log),
  ]);
  // network last, so the local probes do not compete with the transfer legs
  const controlUrl = opts.controlUrl;
  const net = controlUrl ? await attempt(log, "net", () => measureNet(controlUrl)) : undefined;
  const ip = controlUrl ? await publicIp(controlUrl) : undefined;

  const caps: Capabilities = {
    os,
    arch,
    hostname: hostname(),
    ramMiB,
    ramReserveMiB: defaultRamReserveMiB(os),
    cpuCores,
    gpus,
    diskFreeMiB: disk ?? 0,
    privateIps: privateIps(),
    measuredAt: new Date().toISOString(),
  };
  if (ip) caps.publicIp = ip;
  if (os === "linux") caps.cgroup = cgroup ?? { memory: false, cpu: false };
  if (engine) caps.engine = engine;
  if (net) caps.net = net;
  return caps;
}

export interface ProbeMetricsOptions {
  /** Engine processes whose resident memory is summed. */
  pids?: number[];
  /** Devices from Capabilities; per-device usage is reported for these ids only. */
  gpus: GpuDevice[];
  /** Linux cpu sampling window (default 1000 ms); darwin reads the kernel's figure instantly. */
  sampleMs?: number;
  log?: Logger;
}

const warned = new Set<string>();
function warnOnce(log: Logger, key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(msg);
}

export async function probeMetrics(opts: ProbeMetricsOptions): Promise<NodeMetrics> {
  const log = opts.log ?? makeLogger("probe");
  const os = process.platform;
  const once = <T>(key: string, fn: () => Promise<T>): Promise<T | undefined> =>
    fn().catch((e: unknown) => { warnOnce(log, key, `${key}: ${(e as Error).message}`); return undefined; });
  const wantGpu = os === "linux" && opts.gpus.some((g) => g.backend === "cuda");

  const [cpuPct, rss, freeRam, gpu] = await Promise.all([
    once("cpu", () => (os === "darwin" ? darwinCpuPct(availableParallelism()) : linuxCpuPct(opts.sampleMs ?? 1000))),
    once("rss", () => rssMiB(opts.pids ?? [])),
    once("freeRam", () => (os === "darwin" ? darwinFreeRamMiB() : linuxFreeRamMiB())),
    wantGpu ? once("gpu", () => linuxGpuUsed()) : Promise.resolve(undefined),
  ]);

  const m: NodeMetrics = { ts: new Date().toISOString() };
  if (cpuPct !== undefined) m.cpuPct = cpuPct;
  if (rss !== undefined) m.rssMiB = rss;
  if (freeRam !== undefined) m.freeRamMiB = freeRam;
  if (gpu) {
    const known = new Set(opts.gpus.map((g) => g.id));
    m.gpu = gpu.filter((g) => known.has(g.id));
  }
  return m;
}
