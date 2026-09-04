// Binary stream multiplexing over one WebSocket (or any ordered byte-frame transport).
//
// frame := u32 streamId (big-endian) | u8 op | payload
//   op 1 OPEN  payload = JSON StreamHeader
//   op 2 DATA  payload = bytes
//   op 3 CLOSE payload = optional JSON { reason }
// Stream ids: the side created with parity 1 allocates odd ids, the other even, so both sides can
// open streams without coordination. A relay is two streams bridged by the control plane.

import type { StreamHeader } from "./types.ts";

export const OP_OPEN = 1;
export const OP_DATA = 2;
export const OP_CLOSE = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(streamId: number, op: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, streamId >>> 0, false);
  out[4] = op;
  out.set(payload, 5);
  return out;
}

export interface Frame { streamId: number; op: number; payload: Uint8Array }

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.byteLength < 5) throw new Error(`frame too short (${buf.byteLength})`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const op = buf[4]!;
  if (op !== OP_OPEN && op !== OP_DATA && op !== OP_CLOSE) throw new Error(`unknown op ${op}`);
  return { streamId: view.getUint32(0, false), op, payload: buf.subarray(5) };
}

export type Sender = (frame: Uint8Array) => void;

export class MuxStream {
  private dataCb: ((chunk: Uint8Array) => void) | null = null;
  private endCb: ((reason?: string) => void) | null = null;
  private pending: Uint8Array[] = [];
  private ended = false;
  private endedReason: string | undefined;
  private closedLocally = false;

  constructor(readonly id: number, readonly header: StreamHeader, private readonly mux: StreamMux) {}

  /** Register the data handler; buffered chunks are flushed synchronously. */
  onData(cb: (chunk: Uint8Array) => void): this {
    this.dataCb = cb;
    for (const c of this.pending) cb(c);
    this.pending = [];
    return this;
  }

  onEnd(cb: (reason?: string) => void): this {
    this.endCb = cb;
    if (this.ended) cb(this.endedReason);
    return this;
  }

  write(chunk: Uint8Array): void {
    if (this.closedLocally) return;
    this.mux.send(encodeFrame(this.id, OP_DATA, chunk));
  }

  /** Close from this side; the peer receives CLOSE. Idempotent. */
  close(reason?: string): void {
    if (this.closedLocally) return;
    this.closedLocally = true;
    const payload = reason ? encoder.encode(JSON.stringify({ reason })) : new Uint8Array(0);
    this.mux.send(encodeFrame(this.id, OP_CLOSE, payload));
    this.mux.forget(this.id);
  }

  get isClosed(): boolean {
    return this.closedLocally || this.ended;
  }

  /** @internal */
  _deliver(chunk: Uint8Array): void {
    if (this.dataCb) this.dataCb(chunk);
    else this.pending.push(chunk);
  }

  /** @internal */
  _end(reason?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.endedReason = reason;
    if (this.endCb) this.endCb(reason);
  }
}

export class StreamMux {
  private streams = new Map<number, MuxStream>();
  private nextId: number;
  private bytesIn = 0;
  private bytesOut = 0;

  /**
   * @param send   writes one frame to the transport
   * @param onOpen called for every stream the peer opens; return false to reject (CLOSE is sent)
   * @param parity 1 = this side allocates odd ids, 0 = even
   */
  constructor(
    private readonly sendRaw: Sender,
    private readonly onOpen: (stream: MuxStream) => boolean | void,
    parity: 0 | 1 = 1,
  ) {
    this.nextId = parity === 1 ? 1 : 2;
  }

  /** @internal */
  send(frame: Uint8Array): void {
    this.bytesOut += frame.byteLength;
    this.sendRaw(frame);
  }

  /** @internal */
  forget(id: number): void {
    this.streams.delete(id);
  }

  open(header: StreamHeader): MuxStream {
    const id = this.nextId;
    this.nextId += 2;
    const stream = new MuxStream(id, header, this);
    this.streams.set(id, stream);
    this.send(encodeFrame(id, OP_OPEN, encoder.encode(JSON.stringify(header))));
    return stream;
  }

  /** Feed one incoming transport frame. */
  handleFrame(buf: Uint8Array): void {
    this.bytesIn += buf.byteLength;
    const { streamId, op, payload } = decodeFrame(buf);
    if (op === OP_OPEN) {
      if (this.streams.has(streamId)) throw new Error(`stream ${streamId} already open`);
      const header = JSON.parse(decoder.decode(payload)) as StreamHeader;
      const stream = new MuxStream(streamId, header, this);
      this.streams.set(streamId, stream);
      const accepted = this.onOpen(stream);
      if (accepted === false) stream.close("rejected");
      return;
    }
    const stream = this.streams.get(streamId);
    if (!stream) return; // late frame for a closed stream: drop
    if (op === OP_DATA) {
      stream._deliver(payload);
    } else {
      let reason: string | undefined;
      if (payload.byteLength) {
        try { reason = (JSON.parse(decoder.decode(payload)) as { reason?: string }).reason; } catch { /* ignore */ }
      }
      this.streams.delete(streamId);
      stream._end(reason);
    }
  }

  /** Transport went away: end every stream. */
  closeAll(reason = "transport closed"): void {
    for (const s of [...this.streams.values()]) s._end(reason);
    this.streams.clear();
  }

  get openStreams(): number {
    return this.streams.size;
  }

  get stats(): { bytesIn: number; bytesOut: number; open: number } {
    return { bytesIn: this.bytesIn, bytesOut: this.bytesOut, open: this.streams.size };
  }
}

/** Pipe two streams into each other (relay). Closing either side closes the other. */
export function bridge(a: MuxStream, b: MuxStream): void {
  a.onData((c) => b.write(c));
  b.onData((c) => a.write(c));
  a.onEnd((r) => b.close(r ?? "peer closed"));
  b.onEnd((r) => a.close(r ?? "peer closed"));
}
