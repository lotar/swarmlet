import { Database } from 'bun:sqlite';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeRow } from './registry.ts';
import type { NodeMetrics } from '../protocol/types.ts';
import { anonymousSample, type AnonymousSample } from './telemetry-sample.ts';

export const TELEMETRY_MAX_BYTES = 2_000_000_000;
export const TELEMETRY_MAX_AGE_MS = 72 * 60 * 60 * 1000;
const FIELDS = ['cpuPct', 'rssMiB', 'freeRamMiB', 'gpuUsedMiB', 'gpuUtilizationPct', 'temperatureC', 'fanRpm', 'rxBps', 'txBps', 'rttMs', 'tokPerSec', 'inflight'] as const;
export interface TelemetryPoint extends Record<string, number | null> { at: number; samples: number }
type Kind = 'sample' | 'request' | 'online' | 'offline';
interface RecordData { at: number; kind: Kind; source: string; data: AnonymousSample | RequestTelemetry | Record<string, never> }
export interface RequestTelemetry { status: number; durationMs: number; firstByteMs?: number; bytes: number; outcome: 'complete' | 'cancelled' | 'error'; endpoint: 'chat' | 'completion' | 'embedding'; deployment?: string }
interface Segment { path: string; created: number }
interface Options { now?: () => number; maxBytes?: number; maxAgeMs?: number; segmentBytes?: number; segmentMs?: number }

/** Dedicated bounded files: deleting old telemetry returns real disk space without vacuuming
 * the control registry. Two full segment sizes are reserved for SQLite journals/rotation. */
export class TelemetryStore {
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly segmentBytes: number;
  private readonly segmentMs: number;
  private active: { segment: Segment; db: Database | null } | null = null;
  private segments: Segment[] = [];
  private dropped = 0;
  private lastError: string | null = null;
  constructor(private readonly directory: string, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? TELEMETRY_MAX_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? TELEMETRY_MAX_AGE_MS;
    this.segmentBytes = options.segmentBytes ?? 16 * 1024 * 1024;
    this.segmentMs = options.segmentMs ?? 15 * 60 * 1000;
    if (![this.segmentBytes, this.maxBytes, this.maxAgeMs, this.segmentMs].every(Number.isFinite) || this.segmentMs <= 0 || this.segmentBytes < 512 * 1024 || this.maxBytes < this.segmentBytes * 4 || this.maxAgeMs <= 0 || this.maxBytes > TELEMETRY_MAX_BYTES || this.maxAgeMs > TELEMETRY_MAX_AGE_MS) throw new Error('invalid telemetry limits');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, 'anonymous.key');
    try { this.key = readFileSync(keyPath); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.key = randomBytes(32); writeFileSync(keyPath, this.key, { mode: 0o600, flag: 'wx' }); }
    if (this.key.length !== 32) throw new Error('invalid telemetry identity key');
    for (const name of readdirSync(directory)) {
      const match = /^segment-(\d{13})-[0-9a-f]{16}\.sqlite$/.exec(name);
      if (match) {
        const path = join(directory, name), db = new Database(path);
        // Opening writable permits SQLite to recover a hot journal after an unclean exit.
        try { db.query('SELECT COUNT(*) FROM sqlite_master').get(); } finally { db.close(); }
        this.segments.push({ path, created: Number(match[1]) });
      }
    }
    this.segments.sort((a, b) => a.created - b.created || a.path.localeCompare(b.path));
    this.prune();
  }
  anonymousId(id: string, kind = 'node'): string { return `${kind}-${createHmac('sha256', this.key).update(kind + '\0' + id).digest('hex').slice(0, 16)}`; }
  sample(node: NodeRow, metrics: NodeMetrics, rates: { inBps: number; outBps: number }): void {
    const at = this.now();
    this.append({ at, kind: 'sample', source: this.anonymousId(node.id), data: anonymousSample(node, metrics, rates, at) });
  }
  connection(nodeId: string, online: boolean): void { this.append({ at: this.now(), kind: online ? 'online' : 'offline', source: this.anonymousId(nodeId), data: {} }); }
  request(nodeId: string | null, value: RequestTelemetry): void {
    this.append({ at: this.now(), kind: 'request', source: nodeId ? this.anonymousId(nodeId) : 'unassigned', data: {
      status: value.status, durationMs: value.durationMs, ...(value.firstByteMs === undefined ? {} : { firstByteMs: value.firstByteMs }), bytes: value.bytes,
      outcome: value.outcome, endpoint: value.endpoint, ...(value.deployment ? { deployment: this.anonymousId(value.deployment, 'deployment') } : {}),
    } });
  }
  private diskBytes(): number { return readdirSync(this.directory).reduce((total, name) => total + statSync(join(this.directory, name)).size, 0); }
  prune(reserve = 0): void {
    const cutoff = this.now() - this.maxAgeMs;
    while (this.segments.length && (this.segments[0]!.created <= cutoff || this.diskBytes() + reserve > this.maxBytes)) {
      const segment = this.segments.shift()!;
      if (this.active?.segment === segment) { this.active.db?.close(); this.active = null; }
      unlinkSync(segment.path);
      // A crashed SQLite transaction may have left a journal; it belongs to this exact shard.
      try { unlinkSync(segment.path + '-journal'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  }
  close(): void { this.active?.db?.close(); this.active = null; }
  private open(at: number): Database {
    if (this.active && (at - this.active.segment.created >= this.segmentMs || statSync(this.active.segment.path).size >= this.segmentBytes - 256 * 1024)) this.close();
    if (this.active) {
      if (!this.active.db) {
        this.active.db = new Database(this.active.segment.path);
        this.active.db.exec(`PRAGMA synchronous=FULL; PRAGMA max_page_count=${Math.floor(this.segmentBytes / 4096)};`);
      }
      return this.active.db;
    }
    const segment = { created: at, path: join(this.directory, `segment-${String(at).padStart(13, '0')}-${randomBytes(8).toString('hex')}.sqlite`) };
    const db = new Database(segment.path, { create: true });
    db.exec(`PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA max_page_count=${Math.floor(this.segmentBytes / 4096)};
      CREATE TABLE records (at INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL, ${FIELDS.map(f => `${f} REAL`).join(',')}, status INTEGER, durationMs REAL, firstByteMs REAL, bytes INTEGER, outcome TEXT);
      CREATE INDEX by_time ON records(kind,at); CREATE INDEX by_source ON records(source,kind,at);`);
    this.segments.push(segment); this.active = { segment, db }; return db;
  }
  private append(record: RecordData): void {
    try {
      const data = JSON.stringify(record.data);
      if (Buffer.byteLength(data) > 128 * 1024) throw new Error('telemetry sample exceeds limit');
      this.prune(this.segmentBytes * 2);
      if (this.diskBytes() + this.segmentBytes * 2 > this.maxBytes) throw new Error('telemetry storage budget unavailable');
      const db = this.open(record.at), sample = record.kind === 'sample' ? record.data as AnonymousSample : null;
      const request = record.kind === 'request' ? record.data as RequestTelemetry : null;
      const values = [record.at, record.kind, record.source, data, ...FIELDS.map(f => sample?.values[f] ?? null), request?.status ?? null, request?.durationMs ?? null, request?.firstByteMs ?? null, request?.bytes ?? null, request?.outcome ?? null];
      db.query(`INSERT INTO records VALUES (${values.map(() => '?').join(',')})`).run(...values);
      this.lastError = null;
    } catch { this.dropped++; this.lastError = 'Telemetry storage is unavailable; inference continues.'; this.close(); }
    finally { if (this.active?.db) { this.active.db.close(); this.active.db = null; } }
  }
  query(input: { rangeMs?: number; source?: string } = {}) {
    this.prune();
    const now = this.now(), rangeMs = input.rangeMs ?? 60 * 60 * 1000;
    if (!Number.isFinite(rangeMs) || rangeMs <= 0 || rangeMs > this.maxAgeMs || input.source && !/^node-[0-9a-f]{16}$/.test(input.source)) throw new Error('invalid telemetry range or node');
    const from = now - rangeMs, width = Math.max(1000, Math.ceil(rangeMs / 360 / 1000) * 1000);
    const buckets = new Map<number, Record<string, number>>(), sources = new Map<string, { source: string; at: number; samples: number; latest: AnonymousSample }>();
    const requests = { count: 0, errors: 0, cancelled: 0, durationMs: 0, firstByteMs: 0, firstByteCount: 0, bytes: 0, maxDurationMs: 0 };
    let records = 0, oldestAt: number | null = null, newestAt: number | null = null;
    const sourceClause = input.source ? ' AND source = ?' : '';
    const params: (number | string)[] = [from, now, ...(input.source ? [input.source] : [])];
    for (const segment of this.segments) {
      const db = new Database(segment.path, { readonly: true });
      try {
        const count = db.query('SELECT COUNT(*) AS n, MIN(at) AS oldest, MAX(at) AS newest FROM records').get() as { n: number; oldest: number | null; newest: number | null };
        records += count.n;
        if (count.oldest !== null) oldestAt = Math.min(oldestAt ?? count.oldest, count.oldest);
        if (count.newest !== null) newestAt = Math.max(newestAt ?? count.newest, count.newest);
        for (const row of db.query(`SELECT source, COUNT(*) AS n, MAX(at) AS at FROM records WHERE kind='sample' AND at>=? AND at<=?${sourceClause} GROUP BY source`).all(...params) as { source: string; n: number; at: number }[]) {
          const previous = sources.get(row.source), latest = !previous || row.at >= previous.at ? JSON.parse((db.query("SELECT data FROM records WHERE source=? AND kind='sample' AND at=? LIMIT 1").get(row.source, row.at) as { data: string }).data) : previous.latest;
          sources.set(row.source, { source: row.source, samples: (previous?.samples ?? 0) + row.n, at: Math.max(previous?.at ?? 0, row.at), latest });
        }
        const columns = FIELDS.map(f => `SUM(${f}) AS ${f}Sum, COUNT(${f}) AS ${f}Count, MAX(${f}) AS ${f}Max`).join(',');
        for (const row of db.query(`SELECT CAST((at-${from})/${width} AS INTEGER)*${width}+${from} AS bucket, COUNT(*) AS samples, ${columns} FROM records WHERE kind='sample' AND at>=? AND at<=?${sourceClause} GROUP BY bucket`).all(...params) as Record<string, number | null>[]) {
          const bucket = row.bucket!, b = buckets.get(bucket) ?? { at: bucket, samples: 0 };
          b.samples! += row.samples!;
          for (const f of FIELDS) { b[f+'Sum'] = (b[f+'Sum'] ?? 0) + (row[f+'Sum'] ?? 0); b[f+'Count'] = (b[f+'Count'] ?? 0) + row[f+'Count']!; if (row[f+'Max'] !== null) b[f+'Max'] = Math.max(b[f+'Max'] ?? -Infinity, row[f+'Max']!); }
          buckets.set(bucket, b);
        }
        const r = db.query(`SELECT COUNT(*) AS count, SUM(CASE WHEN status>=400 OR outcome='error' THEN 1 ELSE 0 END) AS errors, SUM(CASE WHEN outcome='cancelled' THEN 1 ELSE 0 END) AS cancelled, SUM(durationMs) AS durationMs, MAX(durationMs) AS maxDurationMs, SUM(firstByteMs) AS firstByteMs, COUNT(firstByteMs) AS firstByteCount, SUM(bytes) AS bytes FROM records WHERE kind='request' AND at>=? AND at<=?${sourceClause}`).get(...params) as typeof requests;
        for (const key of Object.keys(requests) as (keyof typeof requests)[]) requests[key] = key === 'maxDurationMs' ? Math.max(requests[key], r[key] ?? 0) : requests[key] + (r[key] ?? 0);
      } finally { db.close(); }
    }
    const recent: RecordData[] = [];
    for (const segment of [...this.segments].reverse()) {
      if (recent.length >= 20) break;
      const db = new Database(segment.path, { readonly: true });
      try { for (const r of db.query(`SELECT at,kind,source,data FROM records WHERE at>=? AND at<=?${sourceClause} ORDER BY at DESC LIMIT ?`).all(...params, 20 - recent.length) as (Omit<RecordData, 'data'> & { data: string })[]) recent.push({ ...r, data: JSON.parse(r.data) }); }
      finally { db.close(); }
    }
    return { from, to: now, bucketMs: width,
      retention: { maxAgeMs: this.maxAgeMs, maxBytes: this.maxBytes, bytes: this.diskBytes(), records, oldestAt, newestAt, shards: this.segments.length, dropped: this.dropped, error: this.lastError },
      sources: [...sources.values()].sort((a, b) => a.source.localeCompare(b.source)),
      series: [...buckets.values()].sort((a, b) => a.at! - b.at!).map((b): TelemetryPoint => ({ at: b.at!, samples: b.samples!, ...Object.fromEntries(FIELDS.flatMap(f => [[f, b[f+'Count'] ? b[f+'Sum']! / b[f+'Count']! : null], [f+'Max', b[f+'Max'] ?? null]])) })),
      requests: { ...requests, averageDurationMs: requests.count ? requests.durationMs / requests.count : null, averageFirstByteMs: requests.firstByteCount ? requests.firstByteMs / requests.firstByteCount : null }, recent,
    };
  }
}
