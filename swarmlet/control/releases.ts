import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { MAX_MANIFEST_BYTES, validReleasePath } from "../protocol/release.ts";
import { importPublicJwk, verifyObject } from "../protocol/sign.ts";
import type { Registry } from "./registry.ts";

export async function authenticatedReleaseRead(req: Request, reg: Registry): Promise<boolean> {
  const raw = req.headers.get("x-swarmlet-release-auth");
  if (!raw || raw.length > 2048) return false;
  try {
    const auth = JSON.parse(raw);
    if (!auth || auth.kind !== "swarmlet-release-read" || auth.method !== req.method || auth.path !== new URL(req.url).pathname ||
        !Number.isSafeInteger(auth.time) || Math.abs(Date.now() - auth.time) > 30_000 || typeof auth.nodeId !== "string") return false;
    const node = reg.getNode(auth.nodeId);
    return !!node && await verifyObject(auth, await importPublicJwk(node.pubJwk));
  } catch { return false; }
}

/** Read-only release feed. Publishing is an operator filesystem action, never an HTTP upload.
 * Only the inventory and explicitly inventoried files are exposed; keys/config are unreachable. */
export async function serveRelease(dataDir: string, req: Request): Promise<Response> {
  const missing = () => new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const match = /^\/releases\/(darwin|linux|win32)-(arm64|x64)\/(manifest\.json|([1-9][0-9]{0,15})\/(.+))$/.exec(new URL(req.url).pathname);
  if (!match) return missing();
  const root = join(dataDir, "releases", `${match[1]}-${match[2]}`);
  try {
    const inventory = join(root, match[4] ?? "", "manifest.json");
    if ((await lstat(inventory)).size > MAX_MANIFEST_BYTES) return missing();
    const rootReal = await realpath(root);
    const withinRoot = async (path: string) => {
      const rel = relative(rootReal, await realpath(path));
      return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
    };
    if (!await withinRoot(inventory)) return missing();
    const raw = await readFile(inventory, "utf8");
    if (Buffer.byteLength(raw) > MAX_MANIFEST_BYTES) return missing();
    if (!match[4]) return new Response(req.method === "HEAD" ? null : raw, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    const manifest = JSON.parse(raw);
    const path = match[5]!;
    if (!validReleasePath(path) || manifest.sequence !== Number(match[4]) || !Array.isArray(manifest.files) || !manifest.files.some((f: { path?: string }) => f?.path === path)) return missing();
    const file = join(root, match[4], path);
    if (!await withinRoot(file) || !(await lstat(file)).isFile()) return missing();
    return new Response(req.method === "HEAD" ? null : Bun.file(file), { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
  } catch { return missing(); }
}
