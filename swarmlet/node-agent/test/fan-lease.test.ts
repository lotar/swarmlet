import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFanLease } from '../fan-lease.ts';

let temp: string;
let fixture: string;
const native = process.platform === 'darwin' ? test : test.skip;
beforeAll(async () => {
  if (process.platform !== 'darwin') return;
  temp = await mkdtemp(join(tmpdir(), 'swarmlet-fan-lease-'));
  fixture = join(temp, 'fan-fixture');
  const base = resolve(import.meta.dir, '../native-fans/darwin');
  const compile = Bun.spawn(['swiftc', ...['FanController.swift','FanKeys.swift','SMCBackend.swift','FanHold.swift','test/main.swift'].map(p => join(base,p)), '-o',fixture], {stdout:'pipe',stderr:'pipe'});
  const error = await new Response(compile.stderr).text();
  if (await compile.exited !== 0) throw new Error(error);
});
afterAll(async () => { if (temp) await rm(temp,{recursive:true,force:true}); });

native('holding fan helper restores automatically when the owner closes its pipe', async () => {
  const lease = await startFanLease([fixture,'--hold-fixture']);
  expect(lease.exitCode).toBeNull();
  await lease.stop();
  expect(lease.exitCode).toBe(0);
});
native('fan helper watchdog restores control when heartbeat stops', async () => {
  const child = Bun.spawn([fixture,'--hold-fixture'],{stdin:'pipe',stdout:'pipe',stderr:'pipe',env:{...process.env,FAN_TEST_WATCHDOG:'0.3'}});
  child.stdin.write('ping\n'); await child.stdin.flush();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toBe('ready\nrestored\n');
  child.stdin.end();
});
native('fan helper restores on a malformed heartbeat and reports failure', async () => {
  const child = Bun.spawn([fixture,'--hold-fixture'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  child.stdin.write('invalid\n'); child.stdin.end();
  expect(await child.exited).not.toBe(0);
  expect(await new Response(child.stdout).text()).toBe('restored\n');
  expect(await new Response(child.stderr).text()).toContain('Invalid fan heartbeat');
});
native('killing the owner closes the helper pipe and restores automatic control', async () => {
  const marker = join(temp,'owner-death');
  const code = "import {startFanLease} from "+JSON.stringify(resolve(import.meta.dir,'../fan-lease.ts'))+"; await startFanLease("+JSON.stringify([fixture,'--hold-fixture'])+"); console.log('ready'); await Bun.sleep(60000);";
  const owner = Bun.spawn([process.execPath,'--eval',code],{stdout:'pipe',stderr:'pipe',env:{...process.env,FAN_TEST_RESULT:marker}});
  const reader = owner.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('ready');
    owner.kill('SIGKILL');
    await owner.exited;
    let restored = '';
    const deadline = Date.now()+12_000;
    while (Date.now()<deadline) {
      try { restored = await readFile(marker,'utf8'); break; } catch {}
      await Bun.sleep(100);
    }
    expect(restored).toBe('auto');
  } finally {reader.releaseLock(); if(owner.exitCode===null)owner.kill('SIGKILL');}
},20_000);
native('fan helper restores automatic control on SIGTERM', async () => {
  const child = Bun.spawn([fixture,'--hold-fixture'],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
  child.stdin.write('ping\n'); await child.stdin.flush();
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('ready');
  child.kill('SIGTERM');
  expect(await child.exited).toBe(0);
  expect(new TextDecoder().decode((await reader.read()).value).trim()).toBe('restored');
  reader.releaseLock(); child.stdin.end();
});
native('a refused helper startup does not create a cooling lease', async () => {
  await expect(startFanLease(['/bin/sh','-c','echo permission-denied >&2; exit 1'])).rejects.toThrow('permission-denied');
});
