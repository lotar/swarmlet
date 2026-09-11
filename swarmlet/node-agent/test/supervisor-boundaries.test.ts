import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentPaths } from '../paths.ts';
import { readUpdateState, writeUpdateState } from '../update-state.ts';
for (const phase of ['download', 'key', 'lease', 'drain']) test(`supervisor rejects changed controller during ${phase}`, async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/update-rebind.ts'), phase], { stdout: 'pipe', stderr: 'pipe' });
  const output = new Response(p.stdout).text();
  const errors = new Response(p.stderr).text();
  expect(await p.exited).toBe(0);
  const lines = (await output).trim().split('\n'), result = JSON.parse(lines.at(-1)!);
  expect(result.rebound).toBe(true); expect(result.state.active).toBeNull(); expect(result.state.pending).toBeNull();
  expect(result.state.acceptedSequence).toBe(0);
  if (phase === 'download' || phase === 'key') expect(result.leaseHosts).toEqual([]);
  expect(await errors).toBe('');
}, 10000);
test('missing accepted executable falls back without lowering replay floor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarmlet-missing-test-'));
  try {
    const paths = agentPaths(dir), statePath = join(paths.stateDir, 'updates.json');
    await writeUpdateState(statePath, { acceptedSequence: 7, active: { sequence: 7, directory: '7-' + crypto.randomUUID() }, previous: null, pending: null });
    const runner = join(dir, 'runner.ts');
    await writeFile(runner, `import {supervise} from ${JSON.stringify(join(import.meta.dir, '../supervisor.ts'))};await supervise([process.execPath,'-e','process.exit(0)'],{initialMs:60000,crashMs:1});`);
    const p = Bun.spawn([process.execPath, runner], { env: { ...process.env, SWARMLET_HOME: dir }, stdout: 'pipe', stderr: 'pipe' });
    expect(await p.exited).toBe(0);
    const state = await readUpdateState(statePath);
    expect(state.active).toBeNull(); expect(state.pending).toBeNull(); expect(state.acceptedSequence).toBe(7);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);
