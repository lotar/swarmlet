// Glue between mux streams (protocol/frame.ts) and TCP sockets (node:net / node:tls in Bun).
// pipeStreamToSocket: a stream from the channel <-> a local TCP connection (127.0.0.1:port).
// pipeSocketToStream: an accepted local TCP connection <-> a stream we opened towards the channel.

import type { Socket } from "node:net";
import type { MuxStream } from "../protocol/frame.ts";

/** Two-way pipe; closing either side closes the other. Returns when both ends are done. */
export function pipe(stream: MuxStream, sock: Socket): void {
  let socketClosed = false;
  sock.on("data", (chunk: Buffer) => { stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); });
  sock.on("close", () => { socketClosed = true; stream.close("socket closed"); });
  sock.on("error", (e: Error) => { socketClosed = true; stream.close(`socket error: ${e.message}`); });
  stream.onData((chunk) => { if (!socketClosed) sock.write(Buffer.from(chunk)); });
  stream.onEnd(() => { if (!socketClosed) sock.destroy(); });
}
