// The WebCrypto self-signed certificate must be accepted by the TLS stack as both a server and a
// client certificate, and its fingerprint must be what peers see (that is what the transport pins).
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { connect, createServer } from "node:tls";
import { derTime, derUnsignedInteger, ecdsaRawToDer, generateSelfSigned, oid, tlv } from "../selfsigned.ts";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

test("DER primitives", () => {
  expect(hex(oid("2.5.4.3"))).toBe("0603550403");
  expect(hex(oid("1.2.840.10045.4.3.2"))).toBe("06082a8648ce3d040302");
  expect(hex(derUnsignedInteger(Uint8Array.of(0x80)))).toBe("02020080"); // positive: leading zero added
  expect(hex(derUnsignedInteger(Uint8Array.of(0x00, 0x00, 0x7f)))).toBe("02017f"); // leading zeros trimmed
  expect(hex(derTime(new Date("2026-09-09T17:00:05Z")))).toBe(`170d${Buffer.from("260909170005Z").toString("hex")}`);
  expect(hex(derTime(new Date("2050-01-01T00:00:00Z")))).toBe(`180f${Buffer.from("20500101000000Z").toString("hex")}`);
  const sig = ecdsaRawToDer(new Uint8Array([...Array(32).fill(1), ...Array(32).fill(0xff)]));
  expect(sig[0]).toBe(0x30);
  expect(hex(sig)).toContain("0221" + "00" + "ff".repeat(32)); // s needed a sign byte
  expect(hex(tlv(0x30, new Uint8Array(200)))).toStartWith("3081c8"); // long-form length
});

test("self-signed P-256 certificate: PEM shapes, TLS handshake both ways, pinned fingerprint matches", async () => {
  const a = await generateSelfSigned("swarmlet-node-aaaa");
  const b = await generateSelfSigned("swarmlet-node-bbbb");
  expect(a.certPem).toStartWith("-----BEGIN CERTIFICATE-----\n");
  expect(a.keyPem).toStartWith("-----BEGIN PRIVATE KEY-----\n");
  const fpA = createHash("sha256").update(a.certDer).digest("hex");
  const fpB = createHash("sha256").update(b.certDer).digest("hex");
  const seenByServer = new Promise<string>((resolve) => {
    const srv = createServer({ cert: a.certPem, key: a.keyPem, requestCert: true, rejectUnauthorized: false }, (sock) => {
      const c = sock.getPeerCertificate() as { fingerprint256?: string; subject?: { CN?: string } };
      resolve(`${(c.fingerprint256 ?? "").replace(/:/g, "").toLowerCase()} ${c.subject?.CN}`);
      sock.end(); srv.close();
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      const cli = connect({ host: "127.0.0.1", port, cert: b.certPem, key: b.keyPem, rejectUnauthorized: false });
      cli.once("secureConnect", () => {
        const c = cli.getPeerCertificate() as { fingerprint256?: string };
        expect((c.fingerprint256 ?? "").replace(/:/g, "").toLowerCase()).toBe(fpA);
        cli.end();
      });
    });
  });
  expect(await seenByServer).toBe(`${fpB} swarmlet-node-bbbb`);
});
