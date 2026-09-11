import { expect, test } from 'bun:test';
import { Registry } from '../registry.ts';
import { AgentChannel } from '../channel.ts';
import { StreamMux, encodeFrame, OP_OPEN, OP_DATA, MAX_PENDING_STREAM_BYTES } from '../../protocol/frame.ts';
import { parseAgentMessage } from '../../protocol/validate.ts';
import { fleetNode } from './fleet-fixture.ts';
const log = { info() {}, warn() {}, debug() {}, error() {} };
const frame = (v: unknown) => encodeFrame(1, OP_OPEN, new TextEncoder().encode(JSON.stringify(v)));

test('malformed hello and telemetry are rejected before registry writes', async () => {
  const node = fleetNode('node'), reg = new Registry(':memory:');
  reg.upsertNode({ ...node, caps: node.caps! });
  const channel = new AgentChannel(reg, log);
  const ws = { data: { authed: true, nodeId: node.id }, send: () => 1, close() {} } as any;
  const hello = { t: 'hello', proto: 1, agentVersion: '1', caps: node.caps, offer: node.offer, models: node.models, assignments: [] };
  try {
    expect(parseAgentMessage(JSON.stringify(hello)).ok).toBe(true);
    for (const patch of [{ caps: {} }, { offer: {} }, { models: [null] }, { assignments: [null] }]) {
      const raw = JSON.stringify({ ...hello, ...patch });
      expect(parseAgentMessage(raw).ok).toBe(false);
      const before = reg.getNode(node.id);
      await channel.message(ws, raw);
      expect(reg.getNode(node.id)).toEqual(before);
    }
    expect(parseAgentMessage(JSON.stringify({ t: 'heartbeat', ts: 'now', metrics: {}, caps: { gpus: [null] } })).ok).toBe(false);
    expect(parseAgentMessage(JSON.stringify({ t: 'heartbeat', ts: 'now', metrics: { gpu: [null] } })).ok).toBe(false);
  } finally { reg.close(); }
});

test('relay requires assignment peer ownership and either endpoint releases accounting', () => {
  const reg = new Registry(':memory:'), channel = new AgentChannel(reg, log);
  for (const id of ['source', 'target', 'stranger']) { const n = fleetNode(id); reg.upsertNode({ ...n, caps: n.caps! }); }
  reg.putAssignment({ kind: 'worker', id: 'worker', deploymentId: 'dep', port: 8099, peerPort: 8100, device: 'CUDA0', threads: 1, allow: ['source'] }, 'target', 'listening');
  try {
    for (const initiator of ['stranger', 'source']) {
      const right = new StreamMux(() => {}, () => {}, 0);
      (channel as any).conns.set('target', { data: { mux: right } });
      const left = new StreamMux(() => {}, s => (channel as any).onAgentStream(initiator, s), 0);
      left.handleFrame(frame({ kind: 'relay', from: initiator, target: 'target', port: 8099 }));
      expect(left.openStreams).toBe(initiator === 'source' ? 1 : 0);
      expect(channel.openRelayStreams).toBe(initiator === 'source' ? 1 : 0);
      right.closeAll('target closed');
      expect(left.openStreams).toBe(0); expect(channel.openRelayStreams).toBe(0);
      left.closeAll(); expect(channel.openRelayStreams).toBe(0);
    }
    const right = new StreamMux(() => {}, () => {}, 0);
    (channel as any).conns.set('target', { data: { mux: right } });
    const left = new StreamMux(() => {}, s => (channel as any).onAgentStream('source', s), 0);
    left.handleFrame(frame({ kind: 'relay', from: 'source', target: 'target', port: 8100 }));
    expect(channel.openRelayStreams).toBe(1);
    left.closeAll('source closed'); expect(right.openStreams).toBe(0); expect(channel.openRelayStreams).toBe(0);
  } finally { reg.close(); }
});

test('logs reject foreign ownership and cap retained content', async () => {
  const reg = new Registry(':memory:'), channel = new AgentChannel(reg, log);
  reg.putAssignment({ kind: 'worker', id: 'w', deploymentId: 'dep', port: 8099, device: 'CUDA0', threads: 1, allow: [] }, 'owner');
  const send = (nodeId: string, line: string) => channel.message({ data: { authed: true, nodeId } } as any, JSON.stringify({ t: 'log', assignmentId: 'w', line }));
  try {
    await send('stranger', 'forged'); expect(channel.recentLogs('w')).toEqual([]);
    for (let i = 0; i < 20; i++) await send('owner', 'a'.repeat(20000));
    expect(channel.recentLogs('w').join('').length).toBeLessThanOrEqual(65536);
    expect(channel.recentLogs('w')[0]!.length).toBe(8192);
  } finally { reg.close(); }
});

test('invalid headers and throwing callbacks cannot retain streams; pending data is bounded', () => {
  const invalid = new StreamMux(() => {}, () => { throw Error('callback'); }, 0);
  expect(() => invalid.handleFrame(frame(null))).toThrow('invalid stream header');
  expect(invalid.openStreams).toBe(0);
  expect(() => invalid.handleFrame(frame({ kind: 'http', port: 80 }))).toThrow('callback');
  expect(invalid.openStreams).toBe(0);
  const pending = new StreamMux(() => {}, () => {}, 0);
  pending.handleFrame(frame({ kind: 'http', port: 80 }));
  pending.handleFrame(encodeFrame(1, OP_DATA, new Uint8Array(MAX_PENDING_STREAM_BYTES)));
  expect(pending.openStreams).toBe(1);
  pending.handleFrame(encodeFrame(1, OP_DATA, new Uint8Array(1)));
  expect(pending.openStreams).toBe(0);
});
