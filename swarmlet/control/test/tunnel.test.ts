import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import { TunnelPool } from '../tunnel.ts';
import type { AgentChannel } from '../channel.ts';
const pool = () => new TunnelPool({ openStream: () => null } as unknown as AgentChannel, { warn() {}, info() {}, debug() {}, error() {} });
const accepts = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});
test('concurrent first tunnel requests share a listener which close releases', async () => {
  const p = pool();
  try {
    const ports = await Promise.all([p.localPort('node', 1), p.localPort('node', 1)]);
    expect(ports[0]).toBe(ports[1]);
    p.close();
    expect(await accepts(ports[0]!)).toBe(false);
  } finally { p.close(); }
});
test('close during listen cancels startup and allows a fresh tunnel', async () => {
  const p = pool();
  try {
    const pending = p.localPort('node', 1);
    p.close('node');
    await expect(pending).rejects.toThrow('closed during startup');
    const port = await p.localPort('node', 1);
    expect(port).toBeGreaterThan(0);
    p.close();
    expect(await accepts(port)).toBe(false);
  } finally { p.close(); }
});
