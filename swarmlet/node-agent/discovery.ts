import { createSocket } from "node:dgram";
import { DISCOVERY_PORT, verifyAnnouncement } from "../protocol/discovery.ts";
import type { Logger } from "../control/log.ts";

export function discoverControl(options: { bound: () => boolean; join: (url: string, key: JsonWebKey) => Promise<unknown>; log: Logger; port?: number; onListening?: (port: number) => void }): () => void {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  let busy = false, stopped = false, retryAfter = 0;
  socket.on("error", error => options.log.warn("LAN discovery unavailable", { error: error.message }));
  socket.on("message", (bytes, remote) => {
    if (stopped || busy || options.bound() || Date.now() < retryAfter) return;
    busy = true;
    void (async () => {
      const announcement = await verifyAnnouncement(bytes, remote.address);
      if (!announcement || stopped || options.bound()) return;
      try { await options.join(announcement.url, announcement.pubJwk); }
      catch (error) { retryAfter = Date.now() + 15_000; options.log.warn("automatic LAN registration failed", { error: String(error) }); }
    })().catch(error => options.log.warn("LAN announcement failed", { error: String(error) })).finally(() => { busy = false; });
  });
  socket.bind(options.port ?? DISCOVERY_PORT, "0.0.0.0", () => options.onListening?.(socket.address().port));
  return () => { if (stopped) return; stopped = true; try { socket.close(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error; } };
}
