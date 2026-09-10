import { createSocket } from "node:dgram";
import { DISCOVERY_PORT, lanBroadcasts, type ControlAnnouncement } from "../protocol/discovery.ts";
import { ensureKeys, readPublicJwk, signObject } from "../protocol/sign.ts";
import type { ControlConfig } from "./config.ts";
import type { Logger } from "./log.ts";

export async function broadcastControl(cfg: ControlConfig, port: number, log: Logger): Promise<() => void> {
  if (!cfg.lanAutoEnroll) return () => {};
  const keys = await ensureKeys(`${cfg.dataDir}/keys`), pubJwk = await readPublicJwk(`${cfg.dataDir}/keys`);
  const socket = createSocket("udp4");
  let stopped = false;
  socket.on("error", error => log.warn("LAN discovery broadcast unavailable", { error: error.message }));
  socket.bind(0, "0.0.0.0", () => { socket.setBroadcast(true); void announce().catch(error => log.warn("discovery failed", { error: String(error) })); });
  async function announce() {
    if (stopped) return;
    for (const target of lanBroadcasts(cfg.host)) {
      const message: ControlAnnouncement = { t: "swarmlet-control", version: 1, url: `http://${target.address}:${port}/`, time: Date.now(), pubJwk };
      const bytes = Buffer.from(JSON.stringify(await signObject(message, keys.priv)));
      if (!stopped) socket.send(bytes, DISCOVERY_PORT, target.broadcast, error => { if (error) log.debug("discovery send failed", { error: error.message }); });
    }
  }
  const timer = setInterval(() => { void announce().catch(error => log.warn("discovery failed", { error: String(error) })); }, 5000);
  return () => { if (stopped) return; stopped = true; clearInterval(timer); try { socket.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error; } };
}
