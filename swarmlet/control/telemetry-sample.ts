/** Operational fields only. Never persist arbitrary strings or serialized node objects. */
import type { NodeRow } from './registry.ts';
import type { NodeMetrics } from '../protocol/types.ts';

export type MetricValues = Record<string, number>;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function numeric(source: unknown, keys: string[]): MetricValues {
  const result: MetricValues = {};
  if (!source || typeof source !== 'object') return result;
  for (const key of keys) { const value = (source as Record<string, unknown>)[key]; if (number(value)) result[key] = value; }
  return result;
}
const sum = (rows: MetricValues[], key: string): number | undefined => {
  const values = rows.map(r => r[key]).filter(number); return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
};
const max = (rows: MetricValues[], key: string): number | undefined => {
  const values = rows.map(r => r[key]).filter(number); return values.length ? Math.max(...values) : undefined;
};
export function anonymousSample(node: NodeRow, metrics: NodeMetrics, rates: { inBps: number; outBps: number }, at: number) {
  const gpus = (metrics.gpu ?? []).slice(0, 64).map(g => numeric(g, ['usedMiB', 'utilizationPct', 'temperatureC', 'powerW', 'fanPct']));
  const fans = (metrics.hardware?.fans ?? []).slice(0, 128).map(f => numeric(f, ['rpm', 'targetRpm', 'minRpm', 'maxRpm']));
  const temperatures = (metrics.hardware?.temperatures ?? []).slice(0, 2048).map(t => numeric(t, ['celsius']));
  const network = (metrics.network ?? []).slice(0, 128).map(n => numeric(n, ['rxBps', 'txBps']));
  const values = numeric(metrics, ['cpuPct', 'rssMiB', 'freeRamMiB', 'tokPerSec', 'tokPerSecAvg', 'tokensTotal', 'inflight']);
  Object.assign(values, numeric({
    ramMiB: node.caps?.ramMiB, cpuCores: node.caps?.cpuCores, diskFreeMiB: node.caps?.diskFreeMiB,
    offeredRamMiB: node.offer?.ramMiB, offeredCpuCores: node.offer?.cpuCores, offeredDiskMiB: node.offer?.diskMiB,
    gpuUsedMiB: sum(gpus, 'usedMiB'), gpuUtilizationPct: max(gpus, 'utilizationPct'), gpuPowerW: sum(gpus, 'powerW'),
    temperatureC: max(temperatures, 'celsius'), fanRpm: max(fans, 'rpm'), rxBps: sum(network, 'rxBps'), txBps: sum(network, 'txBps'),
    rttMs: metrics.link?.rttMs, relayInBps: rates.inBps, relayOutBps: rates.outBps,
    sampleAgeMs: Math.max(0, at - Date.parse(metrics.ts)),
    serverSampleAgeMs: metrics.serverMetricsTs ? Math.max(0, at - Date.parse(metrics.serverMetricsTs)) : undefined,
    hardwareSampleAgeMs: metrics.hardware?.measuredAt ? Math.max(0, at - Date.parse(metrics.hardware.measuredAt)) : undefined,
    linkSampleAgeMs: metrics.link?.measuredAt ? Math.max(0, at - Date.parse(metrics.link.measuredAt)) : undefined,
  }, ['ramMiB', 'cpuCores', 'diskFreeMiB', 'offeredRamMiB', 'offeredCpuCores', 'offeredDiskMiB', 'gpuUsedMiB', 'gpuUtilizationPct', 'gpuPowerW', 'temperatureC', 'fanRpm', 'rxBps', 'txBps', 'rttMs', 'relayInBps', 'relayOutBps', 'sampleAgeMs', 'serverSampleAgeMs', 'hardwareSampleAgeMs', 'linkSampleAgeMs']));
  const runtime = numeric(metrics.runtime, ['releaseSequence', 'uptimeSec', 'workers', 'coordinators', 'replicas', 'stages']);
  const os = ['darwin', 'linux', 'win32'].includes(node.os) ? node.os : 'other';
  const arch = ['arm64', 'x64'].includes(node.arch) ? node.arch : 'other';
  const serverMetricsState = ['ok', 'partial', 'unavailable'].includes(metrics.serverMetricsState ?? '') ? metrics.serverMetricsState : 'unavailable';
  const fanControl = ['max', 'requested', 'automatic', 'unsupported', 'permission-required', 'error'].includes(metrics.hardware?.fanControl.state ?? '') ? metrics.hardware!.fanControl.state : 'unsupported';
  return { os, arch, enabled: node.offer?.enabled === true, serverMetricsState, fanControl, values, runtime,
    gpus, fans, temperatures, network,
    capacity: (node.caps?.gpus ?? []).slice(0, 64).map(g => numeric(g, ['totalMiB', 'freeMiB'])),
    offeredGpu: (node.offer?.gpu ?? []).slice(0, 64).map(g => numeric(g, ['memMiB'])),
  };
}
export type AnonymousSample = ReturnType<typeof anonymousSample>;
