// Local browser acceptance: real controller/API/SQLite, synthetic node inventory
// and acknowledged assignments. Never connects to or edits the user's real fleet.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootControl } from '../control/server.ts';
import { loadControlConfig } from '../control/config.ts';
import { fleetNode } from '../control/test/fleet-fixture.ts';
import type { Assignment, AssignmentState, ControlToAgent } from '../protocol/types.ts';
const cfg = loadControlConfig({ dataDir: mkdtempSync(join(tmpdir(), 'swarmlet-fleet-ui-')), host: '127.0.0.1', port: Number(process.env.FLEET_FIXTURE_PORT || 47830), adminTrustLoopback: true, publicWeb: true, logLevel: 'warn' });
cfg.adminToken = 'fleet-local-test';
const ctl = await bootControl(cfg), nodes = new Set<string>();
const count = Number(process.env.FLEET_FIXTURE_NODES || 12);
for (let i = 0; i < count; i++) {
  const n = fleetNode(`node-${String(i + 1).padStart(3, '0')}`);
  n.hostname = ['compute-zagreb', 'gpu-frankfurt', 'inference-vienna'][i % 3] + '-' + String(i + 1).padStart(3, '0');
  n.caps!.hostname = n.hostname;
  n.caps!.net!.rttMs = 3 + (i % 8) * 12;
  if (i % 4 === 0) { n.caps!.gpus[0]!.name = 'NVIDIA RTX 4090'; n.caps!.gpus[0]!.totalMiB = 24576; n.offer!.gpu[0]!.memMiB = 20480; }
  ctl.reg.upsertNode({ ...n, caps: n.caps! }); ctl.reg.setOffer(n.id, n.offer!); ctl.reg.setModels(n.id, n.models); ctl.reg.setOnline(n.id, true); nodes.add(n.id);
}
const report = (node: string, id: string, state: AssignmentState) => { ctl.reg.setAssignmentState(id, state); ctl.deployments.onAssignmentState(node, id, state); };
const send = (node: string, message: ControlToAgent) => {
  if (!nodes.has(node)) return false;
  if (message.t !== 'assign') return true;
  const a = message.assignment;
  setTimeout(() => report(node, a.id, a.kind === 'stop' ? 'stopped' : a.kind === 'worker' ? 'listening' : 'ready'), 75);
  return true;
};
ctl.channel.isOnline = id => nodes.has(id);
ctl.channel.send = send;
ctl.channel.assign = (node: string, a: Assignment) => { ctl.reg.putAssignment(a, node); return send(node, { t: 'assign', assignment: a }); };
for (const name of ['support-chat', 'coding-assistant', 'batch-indexing']) await ctl.deployments.create({ name, kind: 'replica', profile: 'qwen35-2b-q8', ctx: 4096 });
console.log(`Fleet UI fixture: http://127.0.0.1:${cfg.port}/#fleet (${count} synthetic nodes; no real fleet changes)`);
