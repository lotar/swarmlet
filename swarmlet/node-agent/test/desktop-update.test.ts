import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopAppUpdater, installMacDesktop, isTerminalUpdateFailure, normaliseUpdateError, swapMacDirectories } from '../desktop-update.ts';
import { MAC_APP_DESCRIPTOR, MAC_APP_ID, parseMacDesktop, type MacDesktop } from '../../protocol/desktop.ts';
import type { ReleaseManifest } from '../../protocol/release.ts';
import { agentPaths } from '../paths.ts';
import { writeUpdateState } from '../update-state.ts';
import { makeLogger } from '../../control/log.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'swarmlet-desktop-')); roots.push(root);
  const releaseDir = join(root, 'release'), target = join(root, 'Swarmlet Node.app');
  await mkdir(join(releaseDir, 'engine'), { recursive: true }); await mkdir(target); await writeFile(join(target, 'old.txt'), 'old app remains runnable');
  const contents = [
    ['Contents/Info.plist', 'engine/desktop-app-000.bin', 'new plist'],
    ['Contents/_CodeSignature/CodeResources', 'engine/desktop-app-001.bin', 'new signature'],
    ['Contents/MacOS/swarmlet-node-shell', 'engine/desktop-app-002.bin', 'new shell'],
    ['Contents/MacOS/swarmlet-node', 'swarmlet-node', 'new canonical agent'],
    ['Contents/Resources/agent-build.json', 'engine/desktop-app-003.bin', '{"revision":"new"}'],
  ] as const;
  const desktop: MacDesktop = { kind: 'swarmlet-macos-app', schema: 1, bundleId: MAC_APP_ID, files: contents.map(([path, source]) => ({ path, source, mode: path.includes('/MacOS/') ? 0o755 : 0o644 })) };
  const release: ReleaseManifest = { kind: 'swarmlet-release', schema: 1, platform: 'darwin', arch: 'arm64', sequence: 2, version: 'test.2', issuedAt: 1, expiresAt: Date.now() + 60000, signature: '', files: [] };
  for (const [, path, content] of contents) { await writeFile(join(releaseDir, path), content); release.files.push({ path, bytes: Buffer.byteLength(content), sha256: digest(content) }); }
  async function saveDescriptor() {
    const content = JSON.stringify(desktop); await writeFile(join(releaseDir, MAC_APP_DESCRIPTOR), content);
    release.files = release.files.filter(file => file.path !== MAC_APP_DESCRIPTOR);
    release.files.push({ path: MAC_APP_DESCRIPTOR, bytes: Buffer.byteLength(content), sha256: digest(content) });
  }
  await saveDescriptor();
  const swap = async (from: string, to: string) => {
    if (process.platform === 'darwin') await swapMacDirectories(from, to);
    else { const temp = to + '.test-swap'; await rename(to, temp); await rename(from, to); await rename(temp, from); }
  };
  const options = { releaseDir, release, target, isCurrent: async () => true, verifyBundle: async () => {}, verifyExisting: async () => {}, swap };
  return { root, target, releaseDir, desktop, release, options, saveDescriptor };
}

async function unchanged(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await readFile(join(f.target, 'old.txt'), 'utf8')).toBe('old app remains runnable');
  expect((await readdir(f.root)).some(name => name.startsWith('.Swarmlet Node.update-'))).toBe(false);
}

test('desktop promotion preserves the previous app and reuses the canonical agent; repeat is idempotent', async () => {
  const f = await fixture(), installed = await installMacDesktop(f.options);
  expect(installed.changed).toBe(true);
  expect(await readFile(join(f.target, 'Contents/MacOS/swarmlet-node'), 'utf8')).toBe('new canonical agent');
  expect(await readFile(join(installed.backup!, 'old.txt'), 'utf8')).toBe('old app remains runnable');
  expect((await installMacDesktop(f.options)).changed).toBe(false);
  expect(await readFile(join(installed.backup!, 'old.txt'), 'utf8')).toBe('old app remains runnable');
});

test('tampered desktop bytes and descriptor leave the installed app untouched', async () => {
  for (const path of ['engine/desktop-app-002.bin', MAC_APP_DESCRIPTOR]) {
    const f = await fixture(); await writeFile(join(f.releaseDir, path), 'tampered');
    await expect(installMacDesktop(f.options)).rejects.toThrow('mismatch'); await unchanged(f);
  }
});

test('a bundle signature failure, obsolete activation or failed atomic swap leaves the old app in place', async () => {
  for (const change of [
    { verifyBundle: async () => { throw Error('signature rejected'); } },
    { isCurrent: async () => false },
    { swap: async () => { throw Error('swap rejected'); } },
  ]) {
    const f = await fixture(); await expect(installMacDesktop({ ...f.options, ...change })).rejects.toThrow(); await unchanged(f);
  }
});

test('desktop descriptors reject traversal, unknown sources, aliases, collisions and a different service agent', async () => {
  const f = await fixture();
  for (const mutate of [
    (d: MacDesktop) => { d.files[0]!.path = 'Contents/../../victim'; },
    (d: MacDesktop) => { d.files[0]!.source = 'engine/not-in-signed-inventory'; },
    (d: MacDesktop) => { d.files.push({ ...d.files[0]!, path: 'contents/info.plist' }); },
    (d: MacDesktop) => { d.files.push({ ...d.files[0]!, path: 'Contents/MacOS' }); },
    (d: MacDesktop) => { d.files[3]!.source = 'engine/desktop-app-002.bin'; },
    (d: MacDesktop) => { d.files[0]!.mode = 0o777 as 493; },
    (d: MacDesktop) => { d.files[3]!.mode = 0o644; },
  ]) {
    const d = structuredClone(f.desktop); mutate(d);
    expect(() => parseMacDesktop(JSON.stringify(d), f.release)).toThrow();
  }
});

test('a pending trial is never used to install the Mac app', async () => {
  const f = await fixture(), paths = agentPaths(join(f.root, 'home'));
  await writeUpdateState(join(paths.stateDir, 'updates.json'), { acceptedSequence: 2, active: null, previous: null, pending: { sequence: 2, directory: '2-12345678-1234-1234-1234-123456789012' } });
  const oldSequence = process.env.SWARMLET_RELEASE_SEQUENCE, oldSupervised = process.env.SWARMLET_SUPERVISED;
  try {
    process.env.SWARMLET_RELEASE_SEQUENCE = '2'; process.env.SWARMLET_SUPERVISED = '1';
    const updater = new DesktopAppUpdater(paths, () => null, makeLogger('desktop-test'));
    await updater.tick(); expect(updater.status.state).toBe(process.platform === 'darwin' ? 'waiting' : 'not-applicable');
    await unchanged(f);
  } finally {
    if (oldSequence === undefined) delete process.env.SWARMLET_RELEASE_SEQUENCE; else process.env.SWARMLET_RELEASE_SEQUENCE = oldSequence;
    if (oldSupervised === undefined) delete process.env.SWARMLET_SUPERVISED; else process.env.SWARMLET_SUPERVISED = oldSupervised;
  }
});

// The failure this guards against, measured on a real machine: the updater is handed a temp directory whose
// name carries a fresh uuid per attempt, the verifier quotes that name back, so every attempt looked like a
// NEW error and the "already reported this one" guard never fired. 8499 identical warnings, every ~30 s.
test('a repeated installer failure is recognised as the same failure', () => {
  const a = 'Mac app signature verification failed: /Users/x/Applications/.Swarmlet Node.update-68c5d426-14c8-4111-8eb9-64e758f68393.app: invalid signature (code or signature have been modified)';
  const b = 'Mac app signature verification failed: /Users/x/Applications/.Swarmlet Node.update-9a8daebb-58c5-48c9-971e-9a0f53940ce2.app: invalid signature (code or signature have been modified)';
  expect(normaliseUpdateError(a)).toBe(normaliseUpdateError(b));
  expect(normaliseUpdateError(a)).toMatch(/\.update-<id>/);
  // Two genuinely different failures must still look different, or the guard would hide a new problem.
  expect(normaliseUpdateError('disk full')).not.toBe(normaliseUpdateError(a));
});

test('a payload that cannot verify is terminal, a transient error is not', () => {
  expect(isTerminalUpdateFailure('Mac app signature verification failed: /tmp/x: invalid signature')).toBe(true);
  for (const transient of ['fetch failed', 'ETIMEDOUT', 'disk full', 'Mac app update is already in progress']) {
    expect(isTerminalUpdateFailure(transient)).toBe(false);
  }
});
