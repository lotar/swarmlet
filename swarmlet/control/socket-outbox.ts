// Bun send=-1 already queued the frame; send=0 lost it. Never continue a byte stream
// after loss, and wait for drain before submitting another frame under backpressure.
export type SocketFrame = string | Uint8Array;
const MAX_QUEUED_BYTES = 1024 * 1024 * 1024; // Covers the qualified Flash-Next expert tensors.

export class SocketOutbox {
  private queue: Array<SocketFrame | undefined> = [];
  private head = 0;
  private bytes = 0;
  private blocked = false;
  private closed = false;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly sendRaw: (frame: SocketFrame) => number,
    private readonly disconnect: (reason: string) => void,
    private readonly limit = MAX_QUEUED_BYTES,
  ) {}

  send(frame: SocketFrame): boolean {
    if (this.closed) return false;
    const size = this.size(frame);
    if (size > this.limit - this.bytes) return this.fail("outbound queue limit exceeded");
    if (!this.blocked && this.head === this.queue.length) return this.submit(frame);
    this.queue.push(typeof frame === "string" ? frame : new Uint8Array(frame));
    this.bytes += size;
    return true;
  }

  drain(): void {
    if (this.closed || this.resumeTimer !== undefined) return;
    // Sending inside Bun 1.3.14's native drain callback can strand its final partial
    // frame. Resume on the next event-loop turn, after that callback has unwound.
    this.resumeTimer = setTimeout(() => { this.resumeTimer = undefined; this.flush(); }, 0);
  }

  private flush(): void {
    if (this.closed) return;
    this.blocked = false;
    while (!this.blocked && this.head < this.queue.length) {
      const frame = this.queue[this.head]!;
      this.queue[this.head++] = undefined;
      this.bytes -= this.size(frame);
      if (!this.submit(frame)) return;
    }
    if (this.head === this.queue.length) { this.queue = []; this.head = 0; }
    else if (this.head > 4096 && this.head * 2 > this.queue.length) { this.queue = this.queue.slice(this.head); this.head = 0; }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.resumeTimer); this.resumeTimer = undefined;
    this.queue = []; this.head = 0; this.bytes = 0;
  }

  get queuedBytes(): number { return this.bytes; }

  private size(frame: SocketFrame): number { return typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength; }

  private submit(frame: SocketFrame): boolean {
    try {
      const result = this.sendRaw(frame);
      if (result === 0) return this.fail("WebSocket dropped an outbound frame");
      this.blocked = result < 0;
      return true;
    } catch { return this.fail("WebSocket send failed"); }
  }

  private fail(reason: string): false {
    this.close();
    this.disconnect(reason);
    return false;
  }
}
