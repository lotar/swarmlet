// TunnelPool: a 127.0.0.1 port on the control host for every (node, port) the router talks to.
// Each accepted connection becomes one {kind:"http"} stream on that node's agent channel, so the
// router can use plain fetch() and get streaming responses without an HTTP parser of its own.

import { createServer, type Server } from "node:net";
import type { AgentChannel } from "./channel.ts";
import type { Logger } from "./log.ts";
import { pipe } from "../node-agent/streams.ts";

export class TunnelPool {
  private tunnels = new Map<string, { server: Server; port: number }>();

  constructor(private readonly channel: AgentChannel, private readonly log: Logger) {}

  async localPort(nodeId: string, remotePort: number): Promise<number> {
    const key = `${nodeId}:${remotePort}`;
    const existing = this.tunnels.get(key);
    if (existing) return existing.port;
    const server = createServer((sock) => {
      sock.setNoDelay(true);
      const stream = this.channel.openStream(nodeId, { kind: "http", port: remotePort });
      if (!stream) { this.log.warn("tunnel: node offline", { nodeId }); sock.destroy(); return; }
      pipe(stream, sock);
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const port = (server.address() as { port: number }).port;
    this.tunnels.set(key, { server, port });
    return port;
  }

  close(nodeId?: string): void {
    for (const [key, t] of this.tunnels) {
      if (nodeId && !key.startsWith(`${nodeId}:`)) continue;
      t.server.close();
      this.tunnels.delete(key);
    }
  }
}
