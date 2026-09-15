import { describe, expect, test } from "bun:test";
import {
  NatMapper, addMapping, isTrustedLocation, locationHost, parseTag, portFor, soapErrorCode,
  type Igd,
} from "../nat.ts";

const igd: Igd = { controlUrl: "http://192.168.1.1:5000/ctl/IPConn", serviceType: "urn:schemas-upnp-org:service:WANIPConnection:2", gateway: "192.168.1.1" };

describe("discovery trust", () => {
  test("accepts only the gateway's own http location", () => {
    expect(isTrustedLocation("http://192.168.1.1:5000/rootDesc.xml", "192.168.1.1")).toBe(true);
    // An attacker on the LAN answering the M-SEARCH must not be able to point our SOAP calls away.
    expect(isTrustedLocation("http://192.168.1.50:5000/rootDesc.xml", "192.168.1.1")).toBe(false);
    expect(isTrustedLocation("http://evil.example/rootDesc.xml", "192.168.1.1")).toBe(false);
    expect(isTrustedLocation("https://192.168.1.1/rootDesc.xml", "192.168.1.1")).toBe(false);
    expect(locationHost("not a url")).toBeUndefined();
  });
});

describe("external port", () => {
  test("is stable, in range, and never the listener port", () => {
    const p = portFor("30f05a2670c368d0", 47801);
    expect(p).toBe(portFor("30f05a2670c368d0", 47801));
    expect(p).toBeGreaterThanOrEqual(40000);
    expect(p).toBeLessThan(60000);
    expect(p).not.toBe(47801);
    expect(portFor("26bc380240373930", 47801)).not.toBe(p);
  });
});

describe("soap parsing", () => {
  test("reads tags and UPnP error codes", () => {
    expect(parseTag("<a><NewExternalIPAddress>1.2.3.4</NewExternalIPAddress></a>", "NewExternalIPAddress")).toBe("1.2.3.4");
    expect(parseTag("<a></a>", "Nope")).toBeUndefined();
    expect(soapErrorCode("<s:Body><s:Fault><detail><UPnPError><errorCode>718</errorCode></UPnPError></detail></s:Fault></s:Body>")).toBe(718);
  });

  test("a 718 conflict is cleared and retried once on the same port", async () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      const action = /<u:(\w+)/.exec(init.body ?? "")?.[1] ?? "?";
      calls.push(action);
      // First AddPortMapping conflicts (what a restart looks like), the retry succeeds.
      const body = action === "AddPortMapping" && calls.filter((c) => c === "AddPortMapping").length === 1
        ? "<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>718</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>"
        : `<s:Envelope><s:Body><u:${action}Response/></s:Body></s:Envelope>`;
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expect(await addMapping(igd, 41234, "192.168.1.181", 47801, "30f05a2670c368d0")).toBe(true);
      expect(calls).toEqual(["AddPortMapping", "DeletePortMapping", "AddPortMapping"]);
    } finally { globalThis.fetch = real; }
  });
});

describe("NatMapper", () => {
  const mapper = (over: Partial<Record<string, unknown>> = {}, events: string[] = []) => new NatMapper(
    { nodeId: "30f05a2670c368d0", dataPort: 47801, log: (e) => events.push(e) },
    {
      defaultRoute: async () => ({ gateway: "192.168.1.1", iface: "en0" }),
      discoverIgd: async () => "http://192.168.1.1:5000/rootDesc.xml",
      resolveIgd: async () => igd,
      externalIp: async () => "93.139.213.145",
      addMapping: async () => true,
      deleteMapping: async () => {},
      ...over,
    } as never,
  );

  test("advertises the mapped endpoint, with the listener port as the internal target", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const m = await mapper({ addMapping: async (i: Igd, ext: number, internal: string, internalPort: number) => { seen.push({ ext, internal, internalPort }); return true; } });
    await m.start();
    const endpoints = m.endpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.host).toBe("93.139.213.145");
    expect(endpoints[0]!.port).toBe(portFor("30f05a2670c368d0", 47801));
    expect(seen[0]).toEqual({ ext: endpoints[0]!.port, internal: "192.168.1.181", internalPort: 47801 });
    await m.stop();
  });

  test("stop() deletes the mapping and stops advertising it", async () => {
    const deleted: number[] = [];
    const m = await mapper({ deleteMapping: async (_i: Igd, port: number) => { deleted.push(port); } });
    await m.start();
    await m.stop();
    expect(deleted).toEqual([portFor("30f05a2670c368d0", 47801)]);
    expect(m.endpoints()).toEqual([]);
    await m.stop(); // idempotent
  });

  test("fail-soft: no route, no IGD, no external address, or a refused port all mean no endpoint", async () => {
    const cases = [
      { defaultRoute: async () => undefined },
      { discoverIgd: async () => undefined },
      { resolveIgd: async () => undefined },
      { externalIp: async () => undefined },
      { addMapping: async () => false },
    ];
    for (const over of cases) {
      const m = await mapper(over);
      await m.start(); // must not throw
      expect(m.endpoints()).toEqual([]);
    }
  });

  test("never advertises a port the router did not accept", async () => {
    // The first candidate conflicts, the second is taken by someone else, the third succeeds.
    const tried: number[] = [];
    const m = await mapper({ addMapping: async (_i: Igd, ext: number) => { tried.push(ext); return tried.length === 3; } });
    await m.start();
    const first = portFor("30f05a2670c368d0", 47801);
    expect(tried).toEqual([first, first + 1, first + 2]);
    expect(m.endpoints()[0]!.port).toBe(first + 2);
    await m.stop();
  });
});
