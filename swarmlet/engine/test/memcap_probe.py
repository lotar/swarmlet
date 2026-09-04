#!/usr/bin/env python3
"""Acceptance probe for ggml-rpc-server --mem-cap-mib (M0).
Talks the raw RPC protocol (HELLO, GET_DEVICE_MEMORY, ALLOC_BUFFER, FREE_BUFFER) to a server started
with a cap and checks: reported total <= cap, an allocation inside the cap succeeds, one that would
exceed it is refused (remote_ptr 0), freeing restores headroom, and the same allocation then succeeds.
usage: memcap_probe.py PORT CAP_MIB  -> prints one line per check, exits 0 only if every check holds."""
import socket, struct, sys
port, cap = int(sys.argv[1]), int(sys.argv[2]); MiB = 1024 * 1024
CMD_ALLOC, CMD_FREE, CMD_DEVMEM, CMD_HELLO = 0, 4, 11, 14
s = socket.create_connection(("127.0.0.1", port), timeout=20); s.settimeout(20)
def rd(n):
    b = b''
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c: raise RuntimeError('closed')
        b += c
    return b
def rpc(cmd, payload):
    s.sendall(bytes([cmd]) + struct.pack('<Q', len(payload)) + payload)
    return rd(struct.unpack('<Q', rd(8))[0])
def devmem(dev=0):
    return struct.unpack('<QQ', rpc(CMD_DEVMEM, struct.pack('<I', dev)))
def alloc(size, dev=0):
    return struct.unpack('<QQ', rpc(CMD_ALLOC, struct.pack('<IQ', dev, size)))
def free(ptr):  # FREE_BUFFER carries no reply in protocol 8.x; the next in-order request proves it was applied
    p = struct.pack('<Q', ptr); s.sendall(bytes([CMD_FREE]) + struct.pack('<Q', len(p)) + p)
ok = True
def check(name, cond, detail=''):
    global ok; ok &= bool(cond); print(f"{'PASS' if cond else 'FAIL'} {name} {detail}")
h = rpc(CMD_HELLO, b'\x00' * 24); print(f"HELLO proto {h[0]}.{h[1]}.{h[2]}")
free0, total0 = devmem(); check('total<=cap', total0 <= cap * MiB, f'total={total0//MiB} MiB cap={cap}')
check('free<=cap', free0 <= cap * MiB, f'free={free0//MiB} MiB')
half = (cap // 2) * MiB
p1, sz1 = alloc(half); check('alloc half ok', p1 != 0 and sz1 >= half, f'ptr={p1:#x} size={sz1//MiB} MiB')
free1, _ = devmem(); check('free shrank', free1 <= cap * MiB - half, f'free={free1//MiB} MiB')
p2, _ = alloc(half + 8 * MiB); check('alloc over cap refused', p2 == 0, f'ptr={p2:#x}')
if p1: free(p1)
free2, _ = devmem(); check('free restored', free2 >= min(free0, cap * MiB) - MiB, f'free={free2//MiB} MiB')
p3, sz3 = alloc(half + 8 * MiB); check('alloc after free ok', p3 != 0, f'ptr={p3:#x} size={sz3//MiB} MiB')
if p3: free(p3)
s.close(); sys.exit(0 if ok else 1)
