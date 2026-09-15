// A node behind a router its owner does not administer still has to be diallable by its peers,
// otherwise every RPC ring falls back to the relay: on this rig that is my Mac -> Cloudflare edge
// -> VPS -> peer, ~113 ms per boundary exchange against ~26 ms measured direct. The owner cannot
// be asked for a router change and we will never hold credentials for the routers of nodes we
// have not met yet, so the node asks its OWN GATEWAY for a port mapping over UPnP-IGD.
//
// What a mapping exposes is the TLS data listener, and nothing else. That listener authenticates
// its callers: it requires a client certificate and destroys any connection whose SHA-256
// fingerprint is not in the assignment's allowed set (transport/dataListener.ts). A mapping is a
// transport address, not a grant - the same bytes still have to present a pinned certificate.
//
// Deliberate security rules, because this is the only code here that changes a device we do not
// own and listens on a public address:
//   1. Only the default gateway may answer discovery, and the SOAP control URL must live on that
//      same host over http. Without this, any hostile device on the LAN could answer the SSDP
//      M-SEARCH and point our SOAP calls at a host of its choosing.
//   2. The mapping covers only the data listener's port, TCP, on the address of the interface that
//      actually holds the default route.
//   3. It carries a lease and is renewed at half life, so an agent that is killed or crashes leaves
//      no hole behind; stop() deletes it outright. A crash costs at most one lease.
//   4. Failure is silent and total: no gateway, no IGD, no mapping, mapping refused - the node
//      reports no endpoint and peers keep using the relay. Nothing here may take the agent down.
//
// No third-party dependencies: SSDP is dgram, SOAP is the platform fetch. The XML that UPnP-IGD
// defines is fixed-shape, so these are targeted regexes rather than a parser.

import { createSocket } from "node:dgram";
import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
const SSDP_HOST = "239.255.255.250";
const SSDP_PORT = 1900;
const SOAP_TIMEOUT_MS = 5_000;
const DISCOVER_TIMEOUT_MS = 4_000;
const LEASE_SECONDS = 3_600;

export type Endpoint = { host: string; port: number };

/** Host of a discovery reply, or undefined when the reply is malformed. */
export function locationHost(location: string): string | undefined {
  try {
    const u = new URL(location);
    return u.protocol === "http:" ? u.hostname : undefined;
  } catch { return undefined; }
}

/**
 * A discovery reply is trusted only when it points back at the gateway we are already routing
 * through. This is the check that keeps a device on the LAN from hijacking our SOAP traffic.
 */
export function isTrustedLocation(location: string, gateway: string): boolean {
  return locationHost(location) === gateway;
}

/**
 * External port is derived from the node id so it is stable across restarts without persisting
 * anything, and kept out of the way of the well-known listener port. This is not a secret and is
 * not relied on for security: the fingerprint check is what admits a peer.
 */
export function portFor(nodeId: string, dataPort: number): number {
  let h = 5381;
  for (const ch of nodeId) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  let port = 40000 + (h % 20000);
  if (port === dataPort) port += 1; // never collide with the listener's own port
  return port;
}

/** Pull a single element's text out of a SOAP response. */
export function parseTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m?.[1]?.trim();
}

/** UPnP error code from a SOAP fault, e.g. 718 ConflictInMappingEntry. */
export function soapErrorCode(xml: string): number | undefined {
  const code = parseTag(xml, "errorCode") ?? parseTag(xml, "UPnPErrorCode");
  return code && /^\d+$/.test(code) ? Number(code) : undefined;
}

function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Default gateway and the interface that holds the default route, per platform. */
async function defaultRoute(): Promise<{ gateway: string; iface?: string } | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await run("route", ["-n", "get", "default"], { timeout: 4_000 });
      const gw = /^\s*gateway:\s*(\S+)/m.exec(stdout)?.[1];
      const iface = /^\s*interface:\s*(\S+)/m.exec(stdout)?.[1];
      return gw ? { gateway: gw, iface } : undefined;
    }
    if (process.platform === "linux") {
      const { stdout } = await run("ip", ["route", "show", "default"], { timeout: 4_000 });
      const gw = /default via (\S+)/.exec(stdout)?.[1];
      const iface = /dev (\S+)/.exec(stdout)?.[1];
      return gw ? { gateway: gw, iface } : undefined;
    }
  } catch { /* no default route, or the tool is missing: feature stays off */ }
  return undefined;
}

/** IPv4 address of the named interface - the address the gateway must map back to. */
function interfaceIpv4(iface: string | undefined): string | undefined {
  if (!iface) return undefined;
  for (const addr of networkInterfaces()[iface] ?? []) {
    if (addr.family === "IPv4" && !addr.internal) return addr.address;
  }
  return undefined;
}

/** Send an SSDP M-SEARCH and return the LOCATION of the first gateway-owned reply. */
export async function discoverIgd(gateway: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    let settled = false;
    const done = (v?: string) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* already closing */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), DISCOVER_TIMEOUT_MS);
    timer.unref?.();
    sock.on("error", () => done(undefined));
    sock.on("message", (msg) => {
      const text = msg.toString("utf8");
      const loc = /^location:\s*(\S+)/im.exec(text)?.[1];
      if (loc && isTrustedLocation(loc, gateway)) done(loc);
    });
    const search = [
      "M-SEARCH * HTTP/1.1",
      `HOST: ${SSDP_HOST}:${SSDP_PORT}`,
      'MAN: "ssdp:discover"',
      "MX: 2",
      "ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1",
      "", "",
    ].join("\r\n");
    try {
      sock.send(Buffer.from(search), SSDP_PORT, SSDP_HOST, (err) => { if (err) done(undefined); });
    } catch { done(undefined); }
  });
}

export type Igd = { controlUrl: string; serviceType: string; gateway: string };

/**
 * Fetch the gateway's description and resolve the WAN connection control endpoint. The control URL
 * is required to sit on the gateway host (rule 1) even though it just came from a trusted reply,
 * because the description itself is fetched from the device we are about to write to.
 */
export async function resolveIgd(location: string, gateway: string): Promise<Igd | undefined> {
  try {
    const xml = await (await fetch(location, { redirect: "error", signal: AbortSignal.timeout(SOAP_TIMEOUT_MS) })).text();
    const base = parseTag(xml, "URLBase");
    for (const m of xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
      const block = m[1];
      if (!block) continue;
      const serviceType = parseTag(block, "serviceType");
      const controlUrl = parseTag(block, "controlURL");
      if (!serviceType || !controlUrl || !/WAN(?:IP|PPP)Connection/i.test(serviceType)) continue;
      const resolved = new URL(controlUrl, base || location);
      if (resolved.protocol !== "http:" || resolved.hostname !== gateway) continue;
      return { controlUrl: resolved.toString(), serviceType, gateway };
    }
  } catch { /* not an IGD we can use */ }
  return undefined;
}

/** SOAP call against the IGD. Returns the body text, or undefined on transport failure. */
async function soap(igd: Igd, action: string, args: string): Promise<string | undefined> {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${igd.serviceType}">${args}</u:${action}></s:Body></s:Envelope>`;
  try {
    const res = await fetch(igd.controlUrl, {
      method: "POST", body,
      headers: { "content-type": 'text/xml; charset="utf-8"', SOAPAction: `"${igd.serviceType}#${action}"`, connection: "close" },
      redirect: "error", signal: AbortSignal.timeout(SOAP_TIMEOUT_MS),
    });
    return await res.text();
  } catch { return undefined; }
}

export async function externalIp(igd: Igd): Promise<string | undefined> {
  const xml = await soap(igd, "GetExternalIPAddress", "");
  const ip = xml && parseTag(xml, "NewExternalIPAddress");
  return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== "0.0.0.0" ? ip : undefined;
}

function mappingArgs(externalPort: number, internalClient: string, internalPort: number, nodeId: string): string {
  return [
    "<NewRemoteHost></NewRemoteHost>",
    `<NewExternalPort>${externalPort}</NewExternalPort>`,
    "<NewProtocol>TCP</NewProtocol>",
    `<NewInternalPort>${internalPort}</NewInternalPort>`,
    `<NewInternalClient>${escapeXml(internalClient)}</NewInternalClient>`,
    "<NewEnabled>1</NewEnabled>",
    `<NewPortMappingDescription>${escapeXml(`swarmlet-${nodeId.slice(0, 12)}`)}</NewPortMappingDescription>`,
    `<NewLeaseDuration>${LEASE_SECONDS}</NewLeaseDuration>`,
  ].join("");
}

export async function deleteMapping(igd: Igd, externalPort: number): Promise<void> {
  await soap(igd, "DeletePortMapping",
    `<NewRemoteHost></NewRemoteHost><NewExternalPort>${externalPort}</NewExternalPort><NewProtocol>TCP</NewProtocol>`);
}

/**
 * Ask for the mapping. Some routers answer 718 (conflict) for a port they already hold for us,
 * which is what a restart looks like, so an existing entry is cleared and the port retried before
 * moving on.
 */
export async function addMapping(igd: Igd, externalPort: number, internalClient: string, internalPort: number, nodeId: string): Promise<boolean> {
  const xml = await soap(igd, "AddPortMapping", mappingArgs(externalPort, internalClient, internalPort, nodeId));
  if (xml === undefined) return false;
  if (/<u:AddPortMappingResponse/i.test(xml)) return true;
  if (soapErrorCode(xml) === 718) {
    await deleteMapping(igd, externalPort);
    const retry = await soap(igd, "AddPortMapping", mappingArgs(externalPort, internalClient, internalPort, nodeId));
    return retry !== undefined && /<u:AddPortMappingResponse/i.test(retry);
  }
  return false;
}

export type NatLog = (event: string, detail?: Record<string, unknown>) => void;

/**
 * Owns the mapping for the life of the process: establish, renew at half life, delete on stop.
 * `endpoints()` is what the agent publishes in its capabilities; it is empty until a mapping is
 * actually in place, so a node never advertises an address that does not work.
 */
export class NatMapper {
  private igd?: Igd;
  private mapped?: Endpoint;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private internalIp?: string;

  constructor(
    private readonly opts: { nodeId: string; dataPort: number; log: NatLog; leaseSeconds?: number },
    private readonly deps = { defaultRoute, discoverIgd, resolveIgd, externalIp, addMapping, deleteMapping },
  ) {}

  get leaseSeconds(): number { return this.opts.leaseSeconds ?? LEASE_SECONDS; }

  /** Best effort. Never throws; a node with no usable IGD simply reports no endpoint. */
  async start(): Promise<void> {
    try {
      const route = await this.deps.defaultRoute();
      if (!route) return void this.opts.log("nat: no default route, mapping skipped");
      const internalIp = interfaceIpv4(route.iface);
      if (!internalIp) return void this.opts.log("nat: no IPv4 on the default interface, mapping skipped");
      this.internalIp = internalIp;
      const location = await this.deps.discoverIgd(route.gateway);
      if (!location) return void this.opts.log("nat: no gateway IGD answered discovery");
      const igd = await this.deps.resolveIgd(location, route.gateway);
      if (!igd) return void this.opts.log("nat: gateway has no usable WAN connection service");
      this.igd = igd;
      const host = await this.deps.externalIp(igd);
      if (!host) return void this.opts.log("nat: gateway did not report an external address");
      // Try the node's own port first, then a couple of neighbours if the router holds it.
      const first = portFor(this.opts.nodeId, this.opts.dataPort);
      for (const candidate of [first, first + 1, first + 2]) {
        if (await this.deps.addMapping(igd, candidate, internalIp, this.opts.dataPort, this.opts.nodeId)) {
          this.mapped = { host, port: candidate };
          this.opts.log("nat: mapping established", { host, port: candidate, internal: `${internalIp}:${this.opts.dataPort}`, leaseSeconds: this.leaseSeconds });
          // Renew at half life: a process that dies without stop() still expires its own hole.
          this.timer = setInterval(() => { void this.renew(); }, Math.max(30_000, (this.leaseSeconds / 2) * 1_000));
          this.timer.unref?.();
          return;
        }
      }
      this.opts.log("nat: gateway refused every candidate port");
    } catch (e) {
      this.opts.log("nat: mapping failed", { err: e instanceof Error ? e.message : String(e) });
    }
  }

  private async renew(): Promise<void> {
    if (this.stopped || !this.igd || !this.mapped) return;
    if (!this.internalIp) return;
    if (!(await this.deps.externalIp(this.igd))) return; // gateway gone: keep the old lease, retry next tick
    await this.deps.addMapping(this.igd, this.mapped.port, this.internalIp, this.opts.dataPort, this.opts.nodeId);
  }

  /** Endpoints peers may dial directly. Empty unless a mapping is live. */
  endpoints(): Endpoint[] { return this.mapped ? [this.mapped] : []; }

  /** Delete the mapping and stop renewing. Safe to call more than once. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.igd && this.mapped) await this.deps.deleteMapping(this.igd, this.mapped.port);
    this.mapped = undefined;
  }
}
