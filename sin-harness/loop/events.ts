// loop/events.ts — SQLite event store (capture API).
// Append-only capture stream per node; WAL mode so cron jobs and serving
// never block each other. Capture is idempotent: identical (session, kind,
// payload, ts) yields the same event id and is ignored on duplicate insert.
// PII flagging is deterministic (regex classes) and happens AT CAPTURE TIME —
// flagged events are still stored verbatim (the node owns its data), but they
// are never allowed to leak verbatim into knowledge prose downstream
// (loop/refine.ts and loop/curate.ts enforce that).

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fnv1a } from "../core/mock.ts";
import type { EventKind, EventRecord } from "../core/types.ts";

export interface CaptureInput {
  session: string;
  kind: EventKind;
  payload: string;
  nodeId?: string;
  /** ISO-8601; defaults to now. Exposed for deterministic tests/replays. */
  ts?: string;
}

// ---------- deterministic PII detection ----------

const PII_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  // international/long phone numbers (+385…, or 7+ digit groups with separators)
  ["phone", /(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){7,11}\d/g],
  // Croatian OIB / generic national id: 11 digits
  ["national-id", /\b\d{11}\b/g],
  // IBAN-like
  ["iban", /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g],
  // card-shaped numbers
  ["card", /\b(?:\d[ -]?){13,19}\b/g],
];

/** True if the payload contains anything PII-shaped. Pure + deterministic. */
export function detectPii(payload: string): boolean {
  return PII_PATTERNS.some(([, re]) => re.test(payload));
}

/**
 * Redact PII-shaped spans from free text. Any prose that leaves the event
 * store and enters the knowledge repo MUST pass through this (or come from
 * an already-flag-clean source) — enforced in curate.ts / refine.ts.
 */
export function redactPii(payload: string): string {
  let out = payload;
  for (const [label, re] of PII_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), `[redacted:${label}]`);
  }
  return out;
}

// ---------- store ----------

export class EventStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (dir && dir !== "." && dir !== "/") mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        node_id TEXT,
        session TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        pii_flagged INTEGER NOT NULL DEFAULT 0,
        processed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_events_processed ON events(processed);
    `);
  }

  /** Deterministic event id: pure function of content — duplicate-safe. */
  static eventId(input: CaptureInput): string {
    const key = `${input.session}|${input.kind}|${input.payload}|${input.ts ?? ""}`;
    return `evt-${fnv1a(key).toString(36)}`;
  }

  capture(input: CaptureInput): EventRecord {
    const rec: EventRecord = {
      id: EventStore.eventId(input),
      ts: input.ts ?? new Date().toISOString(),
      nodeId: input.nodeId,
      session: input.session,
      kind: input.kind,
      payload: input.payload,
      piiFlagged: detectPii(input.payload),
      processed: false,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
           (id, ts, node_id, session, kind, payload, pii_flagged, processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        rec.id,
        rec.ts,
        rec.nodeId ?? null,
        rec.session,
        rec.kind,
        rec.payload,
        rec.piiFlagged ? 1 : 0,
      );
    return this.get(rec.id) ?? rec;
  }

  captureMany(inputs: readonly CaptureInput[]): EventRecord[] {
    return inputs.map((i) => this.capture(i));
  }

  get(id: string): EventRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  unprocessed(limit = 500): EventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE processed = 0 ORDER BY ts, id LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(fromRow);
  }

  all(): EventRecord[] {
    const rows = this.db.prepare(`SELECT * FROM events ORDER BY ts, id`).all() as Row[];
    return rows.map(fromRow);
  }

  markProcessed(ids: readonly string[]): void {
    const tx = this.db.transaction((ids: readonly string[]) => {
      const stmt = this.db.prepare(`UPDATE events SET processed = 1 WHERE id = ?`);
      for (const id of ids) stmt.run(id);
    });
    tx(ids);
  }

  counts(): { total: number; unprocessed: number } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as Row).n as number;
    const unprocessed = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE processed = 0`).get() as Row
    ).n as number;
    return { total, unprocessed };
  }

  close(): void {
    this.db.close();
  }
}

interface Row {
  id: string;
  ts: string;
  node_id: string | null;
  session: string;
  kind: string;
  payload: string;
  pii_flagged: number;
  processed: number;
  [k: string]: unknown; // bun:sqlite row index signature
}

function fromRow(r: Row): EventRecord {
  return {
    id: r.id,
    ts: r.ts,
    nodeId: r.node_id ?? undefined,
    session: r.session,
    kind: r.kind as EventKind,
    payload: r.payload,
    piiFlagged: r.pii_flagged === 1,
    processed: r.processed === 1,
  };
}
