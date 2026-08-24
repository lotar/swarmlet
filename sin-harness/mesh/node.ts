#!/usr/bin/env bun
// mesh/node.ts — one logical mesh node as its own OS process.
//
// Owns: a private SQLite event store, a private eval shard derived
// deterministically FROM ITS OWN EVENTS (contents never leave this process),
// its own Ed25519 identity, and an L0 endpoint binding (real llama-server or
// an in-process deterministic core/mock.ts server under --mock).
//
// Usage:
//   bun mesh/node.ts --id n1 --port 9201 --db data/events-n1.sqlite \
//     [--endpoint http://127.0.0.1:8081] [--mock] [--shard-cap 50]

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { loadConfig, resolveFromRoot } from "../core/config.ts";
import { fnv1a, startMockServer, type MockServerHandle } from "../core/mock.ts";
import { HttpL0Client } from "../core/l0.ts";
import { canonicalize, ensureKeys, signObject, type KeyMaterial } from "../core/sign.ts";
import type { EventRecord, EvalInstance, EvalResult } from "../core/types.ts";
import { evaluateInstance, runSuite } from "../evals/score.ts";
import { getTemplate, listTemplates } from "../evals/templates.ts";
import type {
  AuditionRequest,
  AuditionResponse,
  ExecuteRequest,
  ExecuteResponse,
  NodeEventInput,
  NodeHealth,
  PubkeyResponse,
  ShardSummary,
} from "./protocol.ts";
import { comparableOf } from "./protocol.ts";

interface NodeArgs {
  id: string;
  port: number;
  db: string;
  endpoint: string; // "" => config.json llama-server
  mock: boolean;
  shardCap: number;
}

function parseArgs(argv: readonly string[]): NodeArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const id = get("--id");
  const port = Number(get("--port"));
  const db = get("--db");
  if (!id || !Number.isInteger(port) || port <= 0 || !db) {
    console.error(
      "usage: bun mesh/node.ts --id <id> --port <n> --db <path> [--endpoint url] [--mock] [--shard-cap n]",
    );
    process.exit(2);
  }
  return {
    id,
    port,
    db,
    endpoint: get("--endpoint") ?? "",
    mock: argv.includes("--mock"),
    shardCap: Number(get("--shard-cap") ?? 50),
  };
}

// ---------- event store (private) ----------

class EventStore {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    this.db = new Database(path);
    this.db.run(
      `CREATE TABLE IF NOT EXISTS events (
         id TEXT PRIMARY KEY,
         ts TEXT NOT NULL,
         session TEXT NOT NULL,
         kind TEXT NOT NULL,
         payload TEXT NOT NULL,
         pii_flagged INTEGER NOT NULL DEFAULT 0,
         processed INTEGER NOT NULL DEFAULT 0
       )`,
    );
  }

  insertMany(events: readonly NodeEventInput[]): number {
    const stmt = this.db.query(
      `INSERT OR IGNORE INTO events (id, ts, session, kind, payload, pii_flagged, processed)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let added = 0;
    for (const e of events) {
      if (!e.id || !e.kind || typeof e.payload !== "string" || !e.session) continue;
      const rec: EventRecord = {
        id: e.id,
        ts: e.ts ?? new Date().toISOString(),
        session: e.session,
        kind: e.kind,
        payload: e.payload,
        piiFlagged: e.piiFlagged ?? false,
        processed: e.processed ?? false,
      };
      // PII-bearing events ARE captured (owner's own machine, GDPR-clean by
      // construction) but flagged so they NEVER reach the shard or any prose
      // artifact — same contract as loop/events.ts.
      const changes = stmt
        .run([
          rec.id,
          rec.ts,
          rec.session,
          rec.kind,
          rec.payload,
          rec.piiFlagged ? 1 : 0,
          rec.processed ? 1 : 0,
        ])
        .changes;
      if (changes > 0) added++;
    }
    return added;
  }

  /** Non-PII events, stable order — the shard's raw material ("own real data"). */
  usable(): EventRecord[] {
    const rows = this.db
      .query(`SELECT * FROM events WHERE pii_flagged = 0 ORDER BY id ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      ts: String(r.ts),
      session: String(r.session),
      kind: r.kind as EventRecord["kind"],
      payload: String(r.payload),
      piiFlagged: false,
      processed: Number(r.processed) === 1,
    }));
  }
}

// ---------- private shard (derived, never exported) ----------

/**
 * The shard is a pure function of (nodeId, own event ids): template choice and
 * seed are hashes of `nodeId:eventId`. Two nodes with different histories hold
 * different shards — which is exactly what makes local audition meaningful.
 */
export function buildShard(
  nodeId: string,
  events: readonly EventRecord[],
  cap: number,
): EvalInstance[] {
  const templateIds = listTemplates().map((t) => t.id);
  if (templateIds.length === 0 || events.length === 0) return [];
  const out: EvalInstance[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (out.length >= cap) break;
    const h = fnv1a(`${nodeId}:${ev.id}`);
    const seed = h % 2_147_483_647;
    const tplId = templateIds[h % templateIds.length];
    if (!tplId) continue;
    let inst = getTemplate(tplId).makeInstance(seed);
    while (seen.has(inst.id)) inst = { ...inst, id: `${inst.id}+${ev.id}` };
    seen.add(inst.id);
    out.push(inst);
  }
  return out;
}

function shardDigest(nodeId: string, shard: readonly EvalInstance[]): string {
  return String(
    fnv1a(`${nodeId}:${canonicalize(shard.map((i) => [i.id, i.seed, i.templateId]))}`),
  );
}

// ---------- server ----------

const args = parseArgs(process.argv.slice(2));
const store = new EventStore(resolveFromRoot(args.db));

let shardCache: EvalInstance[] | null = null;
function shard(): EvalInstance[] {
  if (!shardCache) shardCache = buildShard(args.id, store.usable(), args.shardCap);
  return shardCache;
}

const keys: KeyMaterial = await ensureKeys(resolveFromRoot(`data/keys/${args.id}`));
// Public identity served at GET /pubkey. Read from the persisted JWK rather
// than exportKey(): core/sign.ts imports the stored public key as
// NON-extractable, so re-exporting throws on every process restart.
const pubJwkPath = resolveFromRoot(`data/keys/${args.id}/public.jwk.json`);
const pubJwk = (await Bun.file(pubJwkPath).json()) as JsonWebKey;

let mockHandle: MockServerHandle | null = null;
let endpoint = args.endpoint;
if (args.mock) {
  mockHandle = startMockServer(); // deterministic; identical requests -> identical bytes
  endpoint = mockHandle.url;
}
const cfg = await loadConfig();
const l0 = new HttpL0Client(cfg, endpoint);

async function handleExecute(body: unknown): Promise<Response> {
  const req = body as ExecuteRequest;
  if (
    !req ||
    typeof req.requestId !== "string" ||
    !Array.isArray(req.instances) ||
    req.instances.length === 0
  ) {
    return Response.json({ error: "invalid ExecuteRequest" }, { status: 400 });
  }
  const results: EvalResult[] = [];
  for (const inst of req.instances.slice(0, 64)) {
    const r = await evaluateInstance(l0, inst); // never throws (score.ts contract)
    r.nodeId = args.id;
    results.push(r);
  }
  const signed = await signObject(
    { nodeId: args.id, requestId: req.requestId, results: results.map(comparableOf) },
    keys.priv,
  );
  const resp: ExecuteResponse = {
    nodeId: args.id,
    requestId: req.requestId,
    results,
    signature: signed.signature,
  };
  return Response.json(resp);
}

async function handleAudition(body: unknown): Promise<Response> {
  const req = body as AuditionRequest;
  if (!req || typeof req.artifactName !== "string" || typeof req.systemPrompt !== "string") {
    return Response.json({ error: "invalid AuditionRequest" }, { status: 400 });
  }
  const sample = shard().slice(0, 24);
  if (sample.length === 0) {
    return Response.json({ error: "empty shard: capture events first" }, { status: 409 });
  }
  const baseline = await runSuite(l0, sample, {});
  const candidate = await runSuite(l0, sample, { systemPrompt: req.systemPrompt });
  // PRD L2 §2: activate only if it beats the incumbent ON YOUR DATA.
  const resp: Omit<AuditionResponse, "signature"> = {
    nodeId: args.id,
    artifactName: req.artifactName,
    candidatePassRate: candidate.passRate,
    baselinePassRate: baseline.passRate,
    evaluated: sample.length,
    accepted: candidate.passRate > baseline.passRate,
  };
  const signed = await signObject(resp, keys.priv);
  const out: AuditionResponse = { ...resp, signature: signed.signature };
  return Response.json(out);
}

void keys.pub; // signing-only use; public identity flows via pubJwk above

const server = Bun.serve({
  port: args.port,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        const health: NodeHealth = { status: "ok", nodeId: args.id, mock: mockHandle !== null };
        return Response.json(health);
      }
      if (req.method === "GET" && url.pathname === "/pubkey") {
        const out: PubkeyResponse = { nodeId: args.id, jwk: pubJwk };
        return Response.json(out);
      }
      if (req.method === "GET" && url.pathname === "/shard") {
        const s = shard();
        const summary: ShardSummary = {
          nodeId: args.id,
          count: s.length,
          digest: shardDigest(args.id, s),
        };
        return Response.json(summary); // contents never leave (PRD L2 §2)
      }
      if (req.method === "POST" && url.pathname === "/events") {
        const body = (await req.json()) as { events?: NodeEventInput[] };
        const added = store.insertMany(body?.events ?? []);
        shardCache = null; // new data -> next /shard or audition rebuilds
        return Response.json({ nodeId: args.id, added });
      }
      if (req.method === "POST" && url.pathname === "/execute") {
        return await handleExecute(await req.json());
      }
      if (req.method === "POST" && url.pathname === "/audition") {
        return await handleAudition(await req.json());
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },
});

console.log(
  `[node ${args.id}] serving on :${args.port} db=${args.db} mock=${mockHandle !== null}`,
);

export { server as nodeServer }; // testability; CLI keeps running below

if (import.meta.main) {
  // Node runs until killed — lifecycle is owned by the coordinator / operator.
  process.on("SIGTERM", () => {
    server.stop(true);
    mockHandle?.stop();
    process.exit(0);
  });
}
