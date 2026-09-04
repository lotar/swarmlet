#!/usr/bin/env python3
"""TCP delay LINE, multi-port: for each LPORT:TPORT pair, listen on
0.0.0.0:LPORT and forward to TARGET_HOST:TPORT. Every byte chunk is
delivered at (arrival_time + DELAY_MS) in order, without blocking later
reads — a chunk written right behind another is delayed once, not
twice. One process fronts N ports so a single sidecar container can
shape both a node's client-facing port and its peer-facing port with
the same one-way delay.

This is the symmetric-delay counterpart to entrypoint.sh's netem
(egress-only, so it doubles the delay on one direction to get the
round-trip total right). This proxy shapes each direction
independently and identically: client->node and node->client both
cost DELAY_MS through the sidecar in front of the node's client port;
node->peer and peer->node both cost DELAY_MS through the sidecar in
front of the node's peer port. A full round trip through one sidecar
then costs 2*DELAY_MS, matching a real symmetric leg where each
direction costs DELAY_MS — no doubling needed here since both
directions are actually shaped, unlike the netem egress-only case.

usage:
  delay-proxy.py --delay-ms MS --target-host HOST LPORT:TPORT [LPORT:TPORT ...]

example (front node1's client port 50052 and peer port 50053, both at
8ms one-way, forwarding to node1 itself):
  delay-proxy.py --delay-ms 8 --target-host node1 50052:50052 50053:50053
"""
import argparse
import asyncio
import socket
import sys
import time


async def reader_task(reader, q, delay):
    try:
        while True:
            data = await reader.read(1 << 18)
            q.put_nowait((time.monotonic() + delay, data))
            if not data:
                break
    except Exception:
        q.put_nowait((time.monotonic() + delay, b""))


async def writer_task(q, writer):
    try:
        while True:
            due, data = await q.get()
            now = time.monotonic()
            if due > now:
                await asyncio.sleep(due - now)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(cr, cw, target_host, tport, delay):
    try:
        ur, uw = await asyncio.open_connection(target_host, tport)
    except Exception:
        cw.close()
        return
    for w in (cw, uw):
        try:
            w.get_extra_info("socket").setsockopt(
                socket.IPPROTO_TCP, socket.TCP_NODELAY, 1
            )
        except Exception:
            pass
    q1, q2 = asyncio.Queue(), asyncio.Queue()
    await asyncio.gather(
        reader_task(cr, q1, delay),
        writer_task(q1, uw),
        reader_task(ur, q2, delay),
        writer_task(q2, cw),
    )


async def serve_pair(lport, tport, target_host, delay):
    async def _handler(cr, cw):
        await handle(cr, cw, target_host, tport, delay)

    srv = await asyncio.start_server(_handler, "0.0.0.0", lport, limit=1 << 22)
    print(
        f"delay-line 0.0.0.0:{lport} -> {target_host}:{tport} "
        f"+{delay * 1000:.0f} ms one-way",
        flush=True,
    )
    async with srv:
        await srv.serve_forever()


def parse_pair(raw):
    try:
        lport_s, tport_s = raw.split(":", 1)
        return int(lport_s), int(tport_s)
    except Exception:
        raise argparse.ArgumentTypeError(
            f"expected LPORT:TPORT, got {raw!r}"
        )


async def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--delay-ms", type=float, required=True)
    ap.add_argument("--target-host", required=True)
    ap.add_argument("pairs", nargs="+", type=parse_pair, metavar="LPORT:TPORT")
    args = ap.parse_args()

    delay = args.delay_ms / 1000.0
    tasks = [
        serve_pair(lport, tport, args.target_host, delay)
        for lport, tport in args.pairs
    ]
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
