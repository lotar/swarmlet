// Deliberately tiny agent used to exercise the real compiled-process update lifecycle.
import { join } from "node:path";
import { agentPaths } from "../../paths.ts";
import { loadNodeConfig } from "../../config.ts";
import { loadIdentity } from "../../identity.ts";
const paths = agentPaths();
const cfg = loadNodeConfig(paths);
const identity = await loadIdentity(paths);
const mode = process.env.SWARMLET_ENGINE ? await Bun.file(join(process.env.SWARMLET_ENGINE, "behavior")).text() : "good";
Bun.serve({ hostname: "127.0.0.1", port: cfg.uiPort, fetch: (req) => {
  if (new URL(req.url).pathname === "/api/shutdown" && req.method === "POST") {
    setTimeout(() => process.exit(0), 50);
    return Response.json({ ok: true });
  }
  return Response.json({
  pid: process.pid, nodeId: identity.nodeId, connected: mode === "good",
  releaseSequence: Number(process.env.SWARMLET_RELEASE_SEQUENCE ?? 0),
}); } });
process.on("message", (value: unknown) => {
  const m = value as { kind: string; id: string; action: string };
  if (m.kind !== "swarmlet-supervisor") return;
  if (m.action === "stop") process.exit(0);
  process.send?.({ kind: "swarmlet-supervisor-result", id: m.id, ok: true });
});
process.on("disconnect", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
