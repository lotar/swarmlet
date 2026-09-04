#!/usr/bin/env bun
// Control plane entry point. `bun run control/main.ts` (or the compiled binary).
// Env: SWARMLET_CONTROL_DIR, SWARMLET_CONTROL_HOST, SWARMLET_CONTROL_PORT, SWARMLET_ADMIN_TOKEN, SWARMLET_CONTROL_URL, SWARMLET_LOG.

import { loadControlConfig } from "./config.ts";
import { bootControl } from "./server.ts";

const cfg = loadControlConfig();
const { server, channel, log } = await bootControl(cfg);
const sweeper = setInterval(() => channel.sweep(), 10_000);
log.info(`admin token in ${cfg.dataDir}/control.json; enroll nodes with a join code from POST /api/join-codes`);

const shutdown = () => {
  clearInterval(sweeper);
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
