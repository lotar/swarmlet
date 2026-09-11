#!/usr/bin/env bun
// Control plane entry point. `bun run control/main.ts` (or the compiled binary).
// Env: SWARMLET_CONTROL_DIR, SWARMLET_CONTROL_HOST, SWARMLET_CONTROL_PORT, SWARMLET_ADMIN_TOKEN, SWARMLET_CONTROL_URL, SWARMLET_LOG.

import { loadControlConfig } from "./config.ts";
import { bootControl } from "./server.ts";
import { broadcastControl } from "./discovery.ts";

const cfg = loadControlConfig();
const { server, channel, log, deployments, telemetry } = await bootControl(cfg);
const stopBroadcast = await broadcastControl(cfg, server.port!, log);
let sweepTicks = 0;
const sweeper = setInterval(() => {
  if (++sweepTicks % 10 === 0) channel.sweep();
  if (sweepTicks % 60 === 0) { try { telemetry?.prune(); } catch { log.warn("telemetry retention cleanup failed"); } }
  void deployments.reconcile().catch((e) => log.error("deployment reconciliation failed", { error: String(e) }));
}, 1000);
log.info(`web UI http://${cfg.host}:${server.port}/  admin token in ${cfg.dataDir}/control.json  join codes: POST /api/join-codes`);

const shutdown = () => {
  clearInterval(sweeper);
  stopBroadcast();
  deployments.dispose();
  channel.shuttingDown = true; // agent disconnects caused by our exit are not node failures
  server.stop(true);
  telemetry?.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
