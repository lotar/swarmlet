// The agent's local HTTP surface on 127.0.0.1:47800: JSON API for the GUI shell / browser page and
// the static UI itself (ui/ui.ts). Loopback only, no auth: whoever is logged in on the machine owns it.

import type { Server } from "bun";
import { validateOffer } from "../protocol/validate.ts";
import type { Capabilities, NetMeasurement, NodeMetrics, Offer } from "../protocol/types.ts";
import type { AssignmentSnapshot } from "./assignments.ts";
import { serveUi } from "./ui/ui.ts";

export interface LocalApiDeps {
  status: () => {
    nodeId: string; hostname: string; agentVersion: string; certFp: string; connected: boolean; controlUrl: string | null; enabled: boolean;
    caps: Capabilities | null; offer: Offer; offerErrors: string[]; assignments: AssignmentSnapshot[]; metrics: NodeMetrics | null; net: NetMeasurement | null;
  };
  caps: () => Capabilities | null;
  offer: () => Offer;
  setOffer: (offer: Offer) => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  models: () => { modelsDir: string; models: import("../protocol/types.ts").ModelFile[] };
  rescanModels: () => Promise<import("../protocol/types.ts").ModelFile[]>;
  join: (controlUrl: string, code: string) => Promise<{ nodeId: string }>;
  measureNet: () => Promise<NetMeasurement>;
  logs: (assignment?: string, lines?: number) => string[];
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function startLocalApi(port: number, deps: LocalApiDeps): Server<undefined> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      try {
        if (path === "/api/status") return json(deps.status());
        if (path === "/api/offer" && req.method === "GET") {
          const caps = deps.caps();
          const ramMax = caps ? Math.max(0, caps.ramMiB - caps.ramReserveMiB) : 0;
          return json({ offer: deps.offer(), caps, limits: { ramMaxMiB: ramMax, cpuMax: caps?.cpuCores ?? 0, gpus: (caps?.gpus ?? []).map((g) => ({ id: g.id, name: g.name, totalMiB: g.totalMiB })) } });
        }
        if (path === "/api/offer" && req.method === "PUT") {
          const caps = deps.caps();
          if (!caps) return json({ errors: ["capabilities not probed yet"] }, 400);
          const v = validateOffer(await req.json(), caps);
          if (!v.ok) return json({ errors: v.errors }, 400);
          await deps.setOffer(v.value);
          return json({ ok: true, warnings: v.warnings });
        }
        if (path === "/api/enabled" && req.method === "POST") { const b = (await req.json()) as { enabled?: boolean }; await deps.setEnabled(b.enabled === true); return json({ ok: true }); }
        if (path === "/api/models" && req.method === "GET") return json(deps.models());
        if (path === "/api/models/rescan" && req.method === "POST") return json({ models: await deps.rescanModels() });
        if (path === "/api/join" && req.method === "POST") {
          const b = (await req.json()) as { controlUrl?: string; code?: string };
          if (!b.controlUrl || !b.code) return json({ error: "controlUrl and code required" }, 400);
          try { return json({ ok: true, ...(await deps.join(b.controlUrl, b.code)) }); } catch (e) { return json({ error: (e as Error).message }, 400); }
        }
        if (path === "/api/net/measure" && req.method === "POST") { try { return json(await deps.measureNet()); } catch (e) { return json({ error: (e as Error).message }, 400); } }
        if (path === "/api/logs") return json({ lines: deps.logs(url.searchParams.get("assignment") ?? undefined, Number(url.searchParams.get("lines") ?? 200)) });
        const ui = serveUi(req, path);
        if (ui) return ui;
        return new Response("not found", { status: 404 });
      } catch (e) {
        return json({ error: (e as Error).message }, 500);
      }
    },
  });
}
