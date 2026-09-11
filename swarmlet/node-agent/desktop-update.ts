import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MAC_APP_DESCRIPTOR, MAC_APP_ID, parseMacDesktop, type MacDesktop } from '../protocol/desktop.ts';
import { verifyRelease, type ReleaseFile, type ReleaseManifest } from '../protocol/release.ts';
import { syncDirectory } from '../protocol/durable-files.ts';
import { readUpdateState } from './update-state.ts';
import { exec } from './probe/exec.ts';
import type { AgentPaths } from './paths.ts';
import type { Logger } from '../control/log.ts';

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function verifyFile(path: string, expected: ReleaseFile): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== expected.bytes) throw new Error('desktop payload size/type mismatch: ' + expected.path);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256) throw new Error('desktop payload hash mismatch: ' + expected.path);
}

async function bundleId(path: string): Promise<void> {
  const info = join(path, 'Contents/Info.plist');
  if (!(await lstat(path)).isDirectory() || !(await lstat(info)).isFile()) throw new Error('invalid installed Mac app');
  const result = await exec(['/usr/libexec/PlistBuddy', '-c', 'Print :CFBundleIdentifier', info]);
  if (result.code || result.stdout.trim() !== MAC_APP_ID) throw new Error('Mac app bundle identifier mismatch');
}

export async function verifyMacApp(path: string): Promise<void> {
  await bundleId(path);
  const signed = await exec(['/usr/bin/codesign', '--verify', '--deep', '--strict', path], { timeoutMs: 60_000 });
  if (signed.code) throw new Error('Mac app signature verification failed: ' + signed.stderr.trim().slice(-500));
}

/** APFS/HFS+ swap keeps the installed app present even if the process or host crashes. */
export async function swapMacDirectories(from: string, to: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Mac app swap requires macOS');
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const system = dlopen('/usr/lib/libSystem.B.dylib', {
    renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  });
  const source = Buffer.from(from + '\0'), destination = Buffer.from(to + '\0');
  try {
    // sys/stdio.h: RENAME_SWAP = 0x00000002. No delete-and-rename fallback.
    if (system.symbols.renamex_np(ptr(source), ptr(destination), 0x2) !== 0) throw new Error('atomic Mac app swap failed');
  } finally { system.close(); }
}

async function verifyContents(root: string, desktop: MacDesktop, release: ReleaseManifest): Promise<void> {
  for (const file of desktop.files) await verifyFile(join(root, file.path), release.files.find(source => source.path === file.source)!);
}

/** Caller supplies the pinned-key-verified active release. Failed staging never changes the installed app. */
export async function installMacDesktop(options: {
  releaseDir: string; release: ReleaseManifest; target: string;
  isCurrent: () => Promise<boolean>;
  verifyBundle?: (path: string) => Promise<void>;
  verifyExisting?: (path: string) => Promise<void>;
  swap?: (from: string, to: string) => void | Promise<void>;
}): Promise<{ changed: boolean; backup?: string }> {
  const { release, releaseDir, target } = options;
  const descriptorFile = release.files.find(file => file.path === MAC_APP_DESCRIPTOR);
  if (!descriptorFile || descriptorFile.bytes > 128 * 1024) throw new Error('release missing bounded Mac app descriptor');
  await verifyFile(join(releaseDir, MAC_APP_DESCRIPTOR), descriptorFile);
  const desktop = parseMacDesktop(await readFile(join(releaseDir, MAC_APP_DESCRIPTOR), 'utf8'), release);
  const verifyBundle = options.verifyBundle ?? verifyMacApp;
  const verifyExisting = options.verifyExisting ?? bundleId;
  await verifyExisting(target);
  try {
    await verifyContents(target, desktop, release);
    await verifyBundle(target);
    return { changed: false };
  } catch (_) { /* Installed bundle differs: build the replacement beside it. */ }
  const parent = dirname(target), backup = join(parent, '.Swarmlet Node.previous.app');
  if (await exists(backup)) await verifyExisting(backup);
  const staging = join(parent, '.Swarmlet Node.update-' + randomUUID() + '.app');
  await mkdir(staging, { mode: 0o755 });
  let swapped = false;
  try {
    for (const file of desktop.files) {
      const source = release.files.find(value => value.path === file.source)!;
      await verifyFile(join(releaseDir, file.source), source);
      const destination = join(staging, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await copyFile(join(releaseDir, file.source), destination);
      await chmod(destination, file.mode);
      await verifyFile(destination, source);
      const handle = await open(destination, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    const directories = new Set<string>([staging]);
    for (const file of desktop.files) {
      let directory = dirname(join(staging, file.path));
      while (directory !== staging) { directories.add(directory); directory = dirname(directory); }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(directory);
    await verifyBundle(staging);
    if (!await options.isCurrent()) throw new Error('desktop release is no longer active');
    await verifyExisting(target);
    await (options.swap ?? swapMacDirectories)(staging, target);
    swapped = true;
    await syncDirectory(parent);
    // The former app remains available throughout backup rotation.
    try {
      if (await exists(backup)) { await verifyExisting(backup); await rm(backup, { recursive: true }); }
      await rename(staging, backup); await syncDirectory(parent);
      return { changed: true, backup };
    } catch (_) { return { changed: true, backup: staging }; }
  } finally {
    if (!swapped) await rm(staging, { recursive: true, force: true });
  }
}

export interface DesktopUpdateStatus {
  state: 'not-applicable' | 'waiting' | 'not-installed' | 'unavailable' | 'installing' | 'installed' | 'error';
  sequence?: number; version?: string; path?: string; backup?: string; detail?: string;
}

export class DesktopAppUpdater {
  status: DesktopUpdateStatus = { state: process.platform === 'darwin' ? 'waiting' : 'not-applicable' };
  private busy = false;
  private completed = 0;
  constructor(private paths: AgentPaths, private key: () => JsonWebKey | null | undefined, private log: Logger) {}

  async tick(): Promise<void> {
    const sequence = Number(process.env.SWARMLET_RELEASE_SEQUENCE ?? 0);
    if (process.platform !== 'darwin' || process.env.SWARMLET_SUPERVISED !== '1' || !sequence || this.busy || this.completed === sequence) return;
    this.busy = true;
    try {
      const state = await readUpdateState(join(this.paths.stateDir, 'updates.json'));
      // Do not install a trial that the stable supervisor has not accepted as healthy.
      if (state.pending || state.active?.sequence !== sequence) return;
      const root = join(this.paths.home, 'releases', state.active.directory), pinned = this.key();
      if (!pinned || await realpath(process.execPath) !== await realpath(join(root, 'swarmlet-node'))) return;
      const release = await verifyRelease(await readFile(join(root, 'manifest.json'), 'utf8'), pinned,
        { platform: 'darwin', arch: process.arch, acceptedSequence: 0 });
      if (release.sequence !== sequence) throw new Error('desktop active manifest sequence mismatch');
      if (!release.files.some(file => file.path === MAC_APP_DESCRIPTOR)) { this.status = { state: 'unavailable', sequence }; return; }
      const userApp = join(homedir(), 'Applications/Swarmlet Node.app');
      const systemApp = '/Applications/Swarmlet Node.app';
      const target = await exists(userApp) ? userApp : await exists(systemApp) ? systemApp : null;
      if (!target) { this.status = { state: 'not-installed', sequence }; return; }
      this.status = { state: 'installing', sequence, version: release.version, path: target };
      const result = await installMacDesktop({ releaseDir: root, release, target, isCurrent: async () => {
        const current = await readUpdateState(join(this.paths.stateDir, 'updates.json'));
        return !current.pending && current.active?.sequence === sequence && resolve(root) === resolve(this.paths.home, 'releases', current.active.directory);
      } });
      this.status = { state: 'installed', sequence, version: release.version, path: target, backup: result.backup };
      this.completed = sequence;
      this.log.info(result.changed ? 'Mac app automatically installed' : 'Mac app matches active release', this.status as unknown as Record<string, unknown>);
    } catch (error) {
      const detail = (error as Error).message;
      if (this.status.state !== 'error' || this.status.detail !== detail) this.log.warn('Mac app update failed', { detail });
      this.status = { state: 'error', sequence, detail };
    } finally { this.busy = false; }
  }
}
