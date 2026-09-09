// Self-signed X.509 certificate for the node's TLS data listener, built with WebCrypto only so every
// platform (including Windows, which ships no openssl) produces the same artifact: ECDSA P-256 key
// as PKCS#8 PEM and a certificate signed with ecdsa-with-SHA256. Peers pin the certificate's SHA-256
// fingerprint (chain validation is off in the transport), so the certificate carries only what TLS
// stacks require to accept it as a server and client certificate: CN, validity, basicConstraints
// CA:false, keyUsage digitalSignature, extKeyUsage serverAuth + clientAuth.

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** Tag-length-value. */
export function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}

const SEQUENCE = 0x30, SET = 0x31, INTEGER = 0x02, BIT_STRING = 0x03, OCTET_STRING = 0x04, NULL = 0x05, OID = 0x06, UTF8_STRING = 0x0c, BOOLEAN = 0x01;
const UTC_TIME = 0x17, GENERALIZED_TIME = 0x18;

/** Dotted OID -> DER OBJECT IDENTIFIER. */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const first = arcs[0] ?? 0, second = arcs[1] ?? 0;
  const bytes: number[] = [first * 40 + second];
  for (const arc of arcs.slice(2)) {
    const enc: number[] = [arc & 0x7f];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) enc.unshift((v & 0x7f) | 0x80);
    bytes.push(...enc);
  }
  return tlv(OID, Uint8Array.from(bytes));
}

/** Unsigned big-endian bytes -> DER INTEGER (positive: a leading 0x00 is added when the top bit is set). */
export function derUnsignedInteger(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  const trimmed = bytes.subarray(i);
  return tlv(INTEGER, (trimmed[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** UTCTime for 1950..2049, GeneralizedTime otherwise (RFC 5280 4.1.2.5). */
export function derTime(d: Date): Uint8Array {
  const y = d.getUTCFullYear();
  const rest = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return y >= 1950 && y < 2050
    ? tlv(UTC_TIME, new TextEncoder().encode(`${pad(y % 100)}${rest}`))
    : tlv(GENERALIZED_TIME, new TextEncoder().encode(`${pad(y, 4)}${rest}`));
}

/** WebCrypto's raw r||s ECDSA signature -> DER ECDSA-Sig-Value. */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return tlv(SEQUENCE, derUnsignedInteger(raw.subarray(0, half)), derUnsignedInteger(raw.subarray(half)));
}

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const CN = "2.5.4.3";
const BASIC_CONSTRAINTS = "2.5.29.19", KEY_USAGE = "2.5.29.15", EXT_KEY_USAGE = "2.5.29.37";
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1", CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

function name(cn: string): Uint8Array {
  return tlv(SEQUENCE, tlv(SET, tlv(SEQUENCE, oid(CN), tlv(UTF8_STRING, new TextEncoder().encode(cn)))));
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return tlv(SEQUENCE, oid(id), ...(critical ? [tlv(BOOLEAN, Uint8Array.of(0xff))] : []), tlv(OCTET_STRING, value));
}

export function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export interface SelfSigned { certPem: string; keyPem: string; certDer: Uint8Array }

/** Certificate DER for an already generated key pair (exported so tests can sign with a fixed key). */
export async function buildCertificate(keys: CryptoKeyPair, cn: string, notBefore: Date, notAfter: Date, serial: Uint8Array): Promise<Uint8Array> {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const algorithm = tlv(SEQUENCE, oid(ECDSA_WITH_SHA256));
  const extensions = tlv(0xa3, tlv(SEQUENCE,
    extension(BASIC_CONSTRAINTS, true, tlv(SEQUENCE)),
    extension(KEY_USAGE, true, tlv(BIT_STRING, Uint8Array.of(0x07, 0x80))), // digitalSignature
    extension(EXT_KEY_USAGE, false, tlv(SEQUENCE, oid(SERVER_AUTH), oid(CLIENT_AUTH))),
  ));
  const tbs = tlv(SEQUENCE,
    tlv(0xa0, tlv(INTEGER, Uint8Array.of(2))), // version v3
    derUnsignedInteger(serial),
    algorithm,
    name(cn),
    tlv(SEQUENCE, derTime(notBefore), derTime(notAfter)),
    name(cn),
    spki,
    extensions,
  );
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, tbs as BufferSource));
  const signature = tlv(BIT_STRING, Uint8Array.of(0), ecdsaRawToDer(raw));
  return tlv(SEQUENCE, tbs, algorithm, signature);
}

/** New P-256 key pair and a self-signed certificate valid from now for `days`. */
export async function generateSelfSigned(cn: string, days = 3650): Promise<SelfSigned> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const serial = crypto.getRandomValues(new Uint8Array(16));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000); // tolerate a peer's clock running a minute behind
  const notAfter = new Date(now.getTime() + days * 86_400_000);
  const certDer = await buildCertificate(keys, cn, notBefore, notAfter, serial);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  return { certPem: pem("CERTIFICATE", certDer), keyPem: pem("PRIVATE KEY", pkcs8), certDer };
}

export { NULL as DER_NULL };
