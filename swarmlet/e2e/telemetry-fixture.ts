// Real controller/history/UI, synthetic metrics; never accesses the production fleet.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryStore } from '../control/telemetry.ts';
import { bootControl } from '../control/server.ts';
import { loadControlConfig } from '../control/config.ts';
import { fleetNode } from '../control/test/fleet-fixture.ts';
const dir = mkdtempSync(join(tmpdir(), 'swarmlet-telemetry-browser-'));
let at = Date.now() - 30 * 60 * 1000;
const history = new TelemetryStore(join(dir, 'telemetry'), { now: () => at });
for (let i = 0; i < 120; i++, at += 15000) for (let n = 0; n < 4; n++) {
  const node = fleetNode('private-hostname-' + n);
  history.sample(node, { ts: new Date(at).toISOString(), cpuPct: 25 + 15 * Math.sin(i / 8 + n), rssMiB: 1200 + n * 300, freeRamMiB: 12000 - n * 300,
    tokPerSec: 7 + 2 * Math.sin(i / 9), inflight: i % 4, serverMetricsTs: new Date(at).toISOString(), serverMetricsState: 'ok',
    gpu: [{ id: 'private-gpu', usedMiB: 2400 + i * 2, utilizationPct: 45 + n * 8, temperatureC: 55 }],
    link: { rttMs: 20 + n * 10, measuredAt: new Date(at).toISOString() },
    network: [{ name: 'private-interface', rxBps: 45000, txBps: 8000 }],
    hardware: { measuredAt: new Date(at).toISOString(), fans: [{ id: 'fan', name: 'private-sensor', rpm: 2800 }], temperatures: [{ name: 'private-sensor', celsius: 50 + n * 5 }], fanControl: { state: 'requested', detail: 'private' } },
    runtime: { releaseSequence: 2026091104, uptimeSec: i * 15, workers: 1, coordinators: 0, replicas: 0, stages: 0 },
  }, { inBps: 1200, outBps: 400 });
  if (i % 8 === 0) history.request(node.id, { endpoint: 'chat', status: i % 24 ? 200 : 502, durationMs: 1200 + i * 2, firstByteMs: 150, bytes: 4000, outcome: i % 24 ? 'complete' : 'error' });
}
history.close();
const cfg = loadControlConfig({ dataDir: dir, host: '0.0.0.0', port: Number(process.env.TELEMETRY_FIXTURE_PORT || 47830), publicWeb: true, adminTrustLoopback: false, adminToken: 'telemetry-fixture-only', logLevel: 'warn' });
const ctl = await bootControl(cfg);
const stop = () => { ctl.channel.shuttingDown = true; ctl.server.stop(true); ctl.telemetry?.close(); ctl.deployments.dispose(); ctl.reg.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
console.log('TELEMETRY_FIXTURE_READY port=' + cfg.port);
