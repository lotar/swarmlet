import { validReleasePath, type ReleaseManifest } from './release.ts';

export const MAC_APP_ID = 'ai.swarmlet.node';
// The flat runtime namespace is understood by already-installed v1 bootstrappers.
export const MAC_APP_DESCRIPTOR = 'engine/desktop-app.json';
export interface DesktopFile { path: string; source: string; mode: 420 | 493 }
export interface MacDesktop { kind: 'swarmlet-macos-app'; schema: 1; bundleId: typeof MAC_APP_ID; files: DesktopFile[] }

export function parseMacDesktop(raw: string, release: Pick<ReleaseManifest, 'platform' | 'files'>): MacDesktop {
  if (Buffer.byteLength(raw) > 128 * 1024 || release.platform !== 'darwin') throw new Error('invalid desktop descriptor');
  const value = JSON.parse(raw) as MacDesktop;
  if (!value || value.kind !== 'swarmlet-macos-app' || value.schema !== 1 || value.bundleId !== MAC_APP_ID ||
      !Array.isArray(value.files) || value.files.length < 5 || value.files.length > 256) throw new Error('invalid desktop descriptor');
  const destinations = new Set<string>();
  const sources = new Set(release.files.map(file => file.path));
  for (const file of value.files) {
    if (!file || typeof file.path !== 'string' || file.path.length > 240 ||
        !/^Contents\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(file.path) ||
        file.path.split('/').some(part => part === '.' || part === '..' || part.endsWith('.')) ||
        typeof file.source !== 'string' || !validReleasePath(file.source) || !sources.has(file.source) ||
        ![0o644, 0o755].includes(file.mode)) throw new Error('invalid desktop file');
    const folded = file.path.toLowerCase();
    if (destinations.has(folded)) throw new Error('duplicate desktop destination');
    destinations.add(folded);
  }
  for (const required of ['Contents/Info.plist', 'Contents/_CodeSignature/CodeResources', 'Contents/MacOS/swarmlet-node-shell', 'Contents/MacOS/swarmlet-node', 'Contents/Resources/agent-build.json']) {
    if (!value.files.some(file => file.path === required)) throw new Error('desktop missing ' + required);
  }
  if (value.files.find(file => file.path === 'Contents/MacOS/swarmlet-node')!.source !== 'swarmlet-node') throw new Error('desktop must use the canonical service agent');
  for (const executable of ['Contents/MacOS/swarmlet-node', 'Contents/MacOS/swarmlet-node-shell']) {
    if (value.files.find(file => file.path === executable)!.mode !== 0o755) throw new Error('desktop executable is not runnable');
  }
  // Reject file/directory collisions before creating anything.
  for (const path of destinations) for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1)) {
    if (destinations.has(path.slice(0, at))) throw new Error('desktop path collision');
  }
  return value;
}
