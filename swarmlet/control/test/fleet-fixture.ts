import type { NodeRow } from '../registry.ts';
import type { Deployment } from '../../protocol/types.ts';
const ts = new Date().toISOString();
export function fleetNode(id: string, overrides: Partial<NodeRow> = {}): NodeRow {
  return { id, hostname: id, os: 'linux', arch: 'x64', enrolledAt: ts, lastSeen: ts, online: true, pubJwk: {}, certFp: id, agentVersion: '0.1.0',
    caps: { allocationVersion: 1, os: 'linux', arch: 'x64', hostname: id, ramMiB: 16384, ramReserveMiB: 4096, cpuCores: 10,
      gpus: [{ id: 'cuda:0', name: 'Test GPU', backend: 'cuda', engineName: 'CUDA0', totalMiB: 8192 }], diskFreeMiB: 100000, privateIps: [], measuredAt: ts, net: { rttMs: 10, measuredAt: ts } },
    offer: { enabled: true, roles: { worker: true, coordinator: true, replica: true }, gpu: [{ id: 'cuda:0', memMiB: 8192 }], ramMiB: 12288, cpuCores: 10, diskMiB: 100000, modelsDir: '/models' },
    models: [{ name: 'Qwen3.5-2B-Q8_0.gguf', path: '/models/Qwen3.5-2B-Q8_0.gguf', kind: 'gguf', sizeBytes: 2200000000 }], metrics: null, ...overrides };
}
export function fleetDeployment(id: string): Deployment {
  return { id, spec: { name: id, kind: 'replica', profile: 'qwen35-2b-q8', ctx: 4096 }, state: 'planned', createdAt: ts, updatedAt: ts };
}
