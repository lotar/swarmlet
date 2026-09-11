// Run after codesigning: the descriptor reconstructs exactly the signed bundle from the release.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAC_APP_ID, parseMacDesktop, type MacDesktop } from '../../protocol/desktop.ts';
import type { ReleaseFile } from '../../protocol/release.ts';

async function hash(path: string): Promise<string> {
  const value = createHash('sha256');
  for await (const chunk of createReadStream(path)) value.update(chunk);
  return value.digest('hex');
}

export async function packageMacApp(agent: string, app: string): Promise<void> {
  const engine = join(agent, 'engine');
  for (const name of await readdir(engine)) if (name === 'desktop-app.json' || /^desktop-app-\d{3}\.bin$/.test(name)) {
    if (!(await lstat(join(engine, name))).isFile()) throw new Error('invalid old desktop payload');
    await unlink(join(engine, name));
  }
  const descriptor: MacDesktop = { kind: 'swarmlet-macos-app', schema: 1, bundleId: MAC_APP_ID, files: [] };
  const inventory = new Map<string, ReleaseFile>();
  let payload = 0;
  async function walk(relative: string) {
    for (const name of (await readdir(join(app, relative))).sort()) {
      const path = relative ? relative + '/' + name : name, sourcePath = join(app, path);
      const stat = await lstat(sourcePath);
      if (stat.isDirectory()) { await walk(path); continue; }
      if (!stat.isFile()) throw new Error('desktop bundle contains a link or special file: ' + path);
      let source: string;
      if (path === 'Contents/MacOS/swarmlet-node') source = 'swarmlet-node';
      else if (path.startsWith('Contents/Resources/engine/')) source = 'engine/' + path.slice('Contents/Resources/engine/'.length);
      else {
        source = 'engine/desktop-app-' + String(payload++).padStart(3, '0') + '.bin';
        await copyFile(sourcePath, join(agent, source));
      }
      const sha256 = await hash(join(agent, source));
      if (await hash(sourcePath) !== sha256) throw new Error('desktop and service bytes differ: ' + path);
      inventory.set(source, { path: source, bytes: stat.size, sha256 });
      descriptor.files.push({ path, source, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  await walk('');
  const build = JSON.parse(await readFile(join(app, 'Contents/Resources/agent-build.json'), 'utf8'));
  if (build.sha256 !== await hash(join(agent, 'swarmlet-node'))) throw new Error('desktop agent manifest mismatch');
  parseMacDesktop(JSON.stringify(descriptor), { platform: 'darwin', files: [...inventory.values()] });
  await writeFile(join(engine, 'desktop-app.json'), JSON.stringify(descriptor, null, 2) + '\n');
  console.log(`packaged signed Mac app: ${descriptor.files.length} files, ${payload} additional payloads`);
}

if (import.meta.main) {
  const [agent, app] = process.argv.slice(2);
  if (!agent || !app) throw new Error('usage: package-macos.ts <agent-dist> <signed-app>');
  await packageMacApp(agent, app);
}
