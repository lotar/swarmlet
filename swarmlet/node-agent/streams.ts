// Glue between mux streams (protocol/frame.ts) and TCP sockets (node:net / node:tls in Bun).
// Explicit data handlers with drain-based backpressure; no pause()/pipe() tricks, which behave
// differently across runtimes when listeners are added or removed mid-stream.

import type { Socket } from "node:net";
import type { MuxStream } from "../protocol/frame.ts";

/** Mux stream <-> socket, two-way; closing either side closes the other. */
export function pipe(stream: MuxStream, sock: Socket): void {
  let socketClosed = false;
  sock.on("data", (chunk: Buffer) => { stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); });
  sock.on("close", () => { socketClosed = true; stream.close("socket closed"); });
  sock.on("error", (e: Error) => { socketClosed = true; stream.close(`socket error: ${e.message}`); });
  stream.onData((chunk) => { if (!socketClosed) sock.write(Buffer.from(chunk)); });
  stream.onEnd(() => { if (!socketClosed) sock.destroy(); });
}

/** Socket <-> socket, two-way, with drain-based backpressure. */
export function pipeSockets(a: Socket, b: Socket): void {
  const fwd = (src: Socket, dst: Socket) => {
    src.on("data", (chunk: Buffer) => { if (!dst.write(chunk)) src.pause(); });
    dst.on("drain", () => src.resume());
    src.on("end", () => dst.end());
    src.on("error", () => dst.destroy());
    src.on("close", () => dst.destroy());
  };
  fwd(a, b);
  fwd(b, a);
}

/** Collects chunks until a sink is attached, then forwards everything in order. */
export class EarlyBuffer {
  private chunks: Buffer[] = [];
  private sink: ((c: Buffer) => void) | null = null;
  push(c: Buffer): void { if (this.sink) this.sink(c); else this.chunks.push(c); }
  attach(sink: (c: Buffer) => void): void { this.sink = sink; for (const c of this.chunks.splice(0)) sink(c); }
}
