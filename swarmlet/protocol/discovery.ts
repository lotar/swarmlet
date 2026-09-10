import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { canonicalize, importPublicJwk, verifyObject } from "./sign.ts";

export const DISCOVERY_PORT = 47901;
export interface ControlAnnouncement {
  t: "swarmlet-control"; version: 1; url: string; time: number; pubJwk: JsonWebKey; signature?: string;
}
export function privateIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 127 || a === 10 || a === 192 && b === 168 || a === 172 && b! >= 16 && b! <= 31;
}
export function lanBroadcasts(host: string): Array<{ address: string; broadcast: string }> {
  return Object.values(networkInterfaces()).flatMap(list => (list ?? []).flatMap(n => {
    if (n.family !== "IPv4" || n.internal || !privateIPv4(n.address) || host !== "0.0.0.0" && host !== n.address) return [];
    const mask = n.netmask.split(".").map(Number);
    return [{ address: n.address, broadcast: n.address.split(".").map((x, i) => Number(x) | (~mask[i]! & 255)).join(".") }];
  }));
}
/** LAN discovery is trust-on-first-use; a saved controller key prevents silent rebinding. */
export async function verifyAnnouncement(bytes: Uint8Array, source: string, pinned?: JsonWebKey): Promise<ControlAnnouncement | null> {
  if (bytes.byteLength > 4096 || !privateIPv4(source)) return null;
  try {
    const message = JSON.parse(new TextDecoder().decode(bytes)) as ControlAnnouncement;
    if (message.t !== "swarmlet-control" || message.version !== 1 || !Number.isFinite(message.time) || Math.abs(Date.now() - message.time) > 30_000) return null;
    const url = new URL(message.url);
    if (url.protocol !== "http:" || url.hostname !== source || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (pinned && canonicalize(pinned) !== canonicalize(message.pubJwk)) return null;
    return await verifyObject(message, await importPublicJwk(message.pubJwk)) ? message : null;
  } catch { return null; }
}
