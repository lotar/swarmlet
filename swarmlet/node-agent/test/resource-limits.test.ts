import { expect, test } from "bun:test";
import { startLocalApi, type LocalApiDeps } from "../localapi.ts";
import type { Capabilities, Offer } from "../../protocol/types.ts";

for (const [os, reserve] of [["darwin", 12288], ["win32", 6144], ["linux", 4096]] as const) {
  test(`${os}: displayed 100% RAM matches enforced reserve and rejects consuming host reserve`, async () => {
    const caps = { os, ramMiB: 32768, ramReserveMiB: 0, cpuCores: 7, diskFreeMiB: 100000, gpus: [] } as unknown as Capabilities;
    let offer: Offer = { enabled: false, roles: { worker: true, coordinator: false, replica: false }, ramMiB: 8193, cpuCores: 3, diskMiB: 0, gpu: [], modelsDir: "/models" };
    const server = startLocalApi(0, { caps: () => caps, offer: () => offer, setOffer: async value => { offer = value; } } as LocalApiDeps);
    const url = `http://127.0.0.1:${server.port}/api/offer`;
    try {
      const { limits } = await (await fetch(url)).json();
      expect(limits.ramMaxMiB).toBe(32768 - reserve);
      for (const pct of [0, 25, 50, 100]) {
        const ramMiB = Math.floor(limits.ramMaxMiB * pct / 100);
        const res = await fetch(url, { method: "PUT", body: JSON.stringify({ ...offer, ramMiB }) });
        expect(res.status).toBe(200);
        expect((await (await fetch(url)).json()).offer.ramMiB).toBe(ramMiB);
      }
      const before = offer;
      const res = await fetch(url, { method: "PUT", body: JSON.stringify({ ...offer, ramMiB: limits.ramMaxMiB + 1 }) });
      expect(res.status).toBe(400);
      expect(offer).toEqual(before);
    } finally { server.stop(true); }
  });
}
