import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootControl } from '../server.ts';
import { loadControlConfig } from '../config.ts';
import { agentPaths } from '../../node-agent/paths.ts';
import { loadIdentity } from '../../node-agent/identity.ts';
import { AgentClient, enroll } from '../../node-agent/agent.ts';
import { fleetNode } from './fleet-fixture.ts';

test('authenticated real node heartbeats persist history and anonymous web API filters it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swarmlet-telemetry-http-'));
  const cfg = loadControlConfig({ dataDir: join(dir, 'control'), host: '127.0.0.1', port: 0, adminTrustLoopback: false, logLevel: 'warn' });
  const ctl = await bootControl(cfg), base = `http://127.0.0.1:${ctl.server.port}`;
  let client: AgentClient | undefined;
  try {
    const identity = await loadIdentity(agentPaths(join(dir, 'node'))), node = fleetNode('private-name');
    const joined = await enroll(base, ctl.reg.createJoinCode().code, identity, node.caps!);
    client = new AgentClient(joined.agentUrl, identity, { caps: () => node.caps!, offer: () => node.offer!, models: () => [],
      metrics: () => ({ ts: new Date().toISOString(), cpuPct: 17, runtime: { releaseSequence: 2026091104, uptimeSec: 5, workers: 1, coordinators: 0, replicas: 0, stages: 0 } }),
      assignments: () => [], onAssign() {}, allowedPorts: () => new Set<number>(),
    }, ctl.log);
    client.start();
    const deadline = Date.now() + 8000;
    while (!ctl.telemetry!.query().sources.length && Date.now() < deadline) await Bun.sleep(30);
    const request = (path: string, token?: string) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect((await request('/api/telemetry')).status).toBe(401);
    expect((await request('/api/telemetry', ctl.reg.createApiKey('inference'))).status).toBe(401);
    const response = await request('/api/telemetry?range=72h', cfg.adminToken); expect(response.status).toBe(200);
    const data = await response.json(); expect(data.sources).toHaveLength(1); expect(data.sources[0].latest.runtime.releaseSequence).toBe(2026091104);
    expect(JSON.stringify(data)).not.toContain(identity.nodeId); expect(JSON.stringify(data)).not.toContain('private-name');
    const filtered = await request('/api/telemetry?node=' + data.sources[0].source, cfg.adminToken); expect(filtered.status).toBe(200);
    expect((await request('/api/telemetry?range=999h', cfg.adminToken)).status).toBe(400);
    expect((await request('/api/telemetry?node=private-name', cfg.adminToken)).status).toBe(400);
  } finally { client?.stop(); ctl.channel.shuttingDown = true; ctl.server.stop(true); ctl.deployments.dispose(); ctl.telemetry?.close(); ctl.reg.close(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);
