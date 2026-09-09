import { expect, test } from "bun:test";
import { SocketOutbox, type SocketFrame } from "../socket-outbox.ts";

test("backpressured frame is not resent; retained binary and text stay ordered", async () => {
  const sent: SocketFrame[] = [], failures: string[] = [];
  const out = new SocketOutbox(frame => { sent.push(frame); return sent.length < 3 ? -1 : 1; }, reason => failures.push(reason));
  const bytes = new Uint8Array([2, 3]);
  expect(out.send("first")).toBe(true);
  out.send(bytes); out.send("stop"); bytes.fill(9);
  expect(sent).toEqual(["first"]);
  expect(out.queuedBytes).toBe(6);
  out.drain(); await Bun.sleep(5); expect(sent).toEqual(["first", new Uint8Array([2, 3])]);
  out.drain(); await Bun.sleep(5); expect(sent).toEqual(["first", new Uint8Array([2, 3]), "stop"]);
  expect(out.queuedBytes).toBe(0); expect(failures).toEqual([]);
});

test("dropped or throwing sends terminate the stream and release pending memory", async () => {
  for (const throwing of [false, true]) {
    const failures: string[] = []; let calls = 0;
    const out = new SocketOutbox(() => { if (++calls === 1) return -1; if (throwing) throw Error("closed"); return 0; }, why => failures.push(why));
    out.send("first"); out.send("next"); out.send("last"); out.drain(); await Bun.sleep(5);
    expect(failures).toHaveLength(1); expect(out.queuedBytes).toBe(0);
    expect(out.send("late")).toBe(false); out.drain(); expect(calls).toBe(2);
  }
});

test("outbound queue is byte bounded and close discards it", () => {
  const failures: string[] = [];
  const out = new SocketOutbox(() => -1, why => failures.push(why), 4);
  out.send("one"); expect(out.send("éé")).toBe(true); expect(out.queuedBytes).toBe(4);
  expect(out.send("x")).toBe(false); expect(failures).toEqual(["outbound queue limit exceeded"]);
  expect(out.queuedBytes).toBe(0);
  const closed = new SocketOutbox(() => -1, () => { throw Error("unexpected"); });
  closed.send("first"); closed.send("pending"); closed.close(); closed.drain();
  expect(closed.queuedBytes).toBe(0); expect(closed.send("late")).toBe(false);
});

test("real Bun WebSocket delivers an ordered 64 MiB burst without losing backpressured frames", async () => {
  const size = 64 * 1024, count = 1024;
  let received = 0, backpressure = 0, failure: unknown;
  let out: SocketOutbox;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(req, server) { return server.upgrade(req) ? undefined : new Response("upgrade required", { status: 400 }); },
    websocket: {
      open(ws) {
        out = new SocketOutbox(frame => { const n = ws.send(frame); if (n < 0) backpressure++; return n; }, why => { failure = Error(why); ws.close(1011, why); });
        for (let i = 0; i < count; i++) {
          const frame = new Uint8Array(size).fill(i % 251); new DataView(frame.buffer).setUint32(0, i);
          out.send(frame);
        }
        out.send("complete");
      },
      drain() { out.drain(); }, message() {}, close() { out.close(); },
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`); ws.binaryType = "arraybuffer";
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error(`received ${received}/${count} frames`)), 5000);
      ws.onmessage = event => {
        try {
          if (typeof event.data === "string") { expect(event.data).toBe("complete"); expect(received).toBe(count); clearTimeout(timeout); resolve(); return; }
          const frame = new Uint8Array(event.data as ArrayBuffer);
          expect(frame.length).toBe(size); expect(new DataView(frame.buffer).getUint32(0)).toBe(received);
          const expected = received % 251;
          if (!frame.subarray(4).every(value => value === expected)) throw Error(`corrupted frame ${received}`);
          received++;
        } catch (error) { clearTimeout(timeout); reject(error); }
      };
      ws.onerror = () => { clearTimeout(timeout); reject(Error("socket error")); };
      ws.onclose = () => { if (received < count) { clearTimeout(timeout); reject(failure ?? Error("early close")); } };
    });
    expect(backpressure).toBeGreaterThan(0); expect(failure).toBeUndefined(); expect(out!.queuedBytes).toBe(0);
  } finally { ws.close(); server.stop(true); }
}, 10_000);
