// Registry: everything the control plane knows, in one SQLite file (bun:sqlite, WAL).
// Plain functions over a Database handle; JSON columns hold the protocol types verbatim.

import { Database } from "bun:sqlite";
import type {
  Assignment, AssignmentState, Capabilities, Deployment, DeploymentSpec, DeploymentState, ModelFile,
  NodeMetrics, Offer, Plan,
} from "../protocol/types.ts";

export interface NodeRow {
  id: string;
  pubJwk: JsonWebKey;
  certFp: string;
  hostname: string;
  os: string;
  arch: string;
  enrolledAt: string;
  lastSeen: string | null;
  online: boolean;
  agentVersion: string | null;
  caps: Capabilities | null;
  offer: Offer | null;
  models: ModelFile[];
  metrics: NodeMetrics | null;
}

export interface AssignmentRow {
  id: string;
  deploymentId: string;
  nodeId: string;
  body: Assignment;
  state: AssignmentState | "sent";
  detail: string | null;
  updatedAt: string;
  retired: boolean;
}

export interface EventRow { id: number; ts: string; kind: string; nodeId: string | null; deploymentId: string | null; message: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY, pub_jwk TEXT NOT NULL, cert_fp TEXT NOT NULL, hostname TEXT NOT NULL,
  os TEXT NOT NULL, arch TEXT NOT NULL, enrolled_at TEXT NOT NULL, last_seen TEXT, online INTEGER NOT NULL DEFAULT 0,
  agent_version TEXT, caps TEXT, offer TEXT, models TEXT, metrics TEXT);
CREATE TABLE IF NOT EXISTS join_codes (code TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_by TEXT);
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL, plan TEXT, endpoint TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, node_id TEXT NOT NULL, body TEXT NOT NULL,
  state TEXT NOT NULL, detail TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deployment_intent (
  deployment_id TEXT PRIMARY KEY, running INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, kind TEXT NOT NULL,
  node_id TEXT, deployment_id TEXT, message TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (key TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS assignments_dep ON assignments(deployment_id);
`;

const now = () => new Date().toISOString();
const j = (v: unknown) => JSON.stringify(v);
const p = <T>(s: unknown): T | null => (typeof s === "string" && s ? (JSON.parse(s) as T) : null);

export class Registry {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(assignments)").all().some((c) => c.name === "retired")) {
      this.db.run("ALTER TABLE assignments ADD COLUMN retired INTEGER NOT NULL DEFAULT 0");
    }
    // Upgrade only deployments that were active. Old failed/planned rows never silently start.
    this.db.run(`INSERT OR IGNORE INTO deployment_intent (deployment_id, running)
      SELECT id, CASE WHEN state IN ('placing', 'loading', 'ready') THEN 1 ELSE 0 END FROM deployments`);
    // nothing is online right after a restart
    this.db.run("UPDATE nodes SET online = 0");
  }

  close(): void { this.db.close(); }

  // ---------- join codes ----------

  createJoinCode(ttlMs = 10 * 60 * 1000): { code: string; expiresAt: string } {
    const b = new Uint8Array(6); crypto.getRandomValues(b);
    const code = [...b].map((x) => (x % 36).toString(36)).join("").toUpperCase();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    this.db.run("INSERT INTO join_codes (code, created_at, expires_at) VALUES (?, ?, ?)", [code, now(), expiresAt]);
    return { code, expiresAt };
  }

  /** Consume a code for nodeId. Returns a reason string when refused. */
  consumeJoinCode(code: string, nodeId: string): string | null {
    const row = this.db.query<{ expires_at: string; used_by: string | null }, [string]>("SELECT expires_at, used_by FROM join_codes WHERE code = ?").get(code.toUpperCase());
    if (!row) return "unknown join code";
    if (row.used_by && row.used_by !== nodeId) return "join code already used";
    if (Date.parse(row.expires_at) < Date.now()) return "join code expired";
    this.db.run("UPDATE join_codes SET used_by = ? WHERE code = ?", [nodeId, code.toUpperCase()]);
    return null;
  }

  // ---------- nodes ----------

  upsertNode(n: { id: string; pubJwk: JsonWebKey; certFp: string; hostname: string; os: string; arch: string; caps?: Capabilities }): void {
    this.db.run(
      `INSERT INTO nodes (id, pub_jwk, cert_fp, hostname, os, arch, enrolled_at, caps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pub_jwk = excluded.pub_jwk, cert_fp = excluded.cert_fp, hostname = excluded.hostname,
         os = excluded.os, arch = excluded.arch, caps = COALESCE(excluded.caps, nodes.caps)`,
      [n.id, j(n.pubJwk), n.certFp, n.hostname, n.os, n.arch, now(), n.caps ? j(n.caps) : null],
    );
  }

  getNode(id: string): NodeRow | null {
    const r = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM nodes WHERE id = ?").get(id);
    return r ? rowToNode(r) : null;
  }

  listNodes(): NodeRow[] {
    return this.db.query<Record<string, unknown>, []>("SELECT * FROM nodes ORDER BY hostname").all().map(rowToNode);
  }

  setOnline(id: string, online: boolean, agentVersion?: string): void {
    this.db.run("UPDATE nodes SET online = ?, last_seen = ?, agent_version = COALESCE(?, agent_version) WHERE id = ?", [online ? 1 : 0, now(), agentVersion ?? null, id]);
  }

  setCaps(id: string, caps: Capabilities): void { this.db.run("UPDATE nodes SET caps = ?, last_seen = ? WHERE id = ?", [j(caps), now(), id]); }
  setOffer(id: string, offer: Offer): void { this.db.run("UPDATE nodes SET offer = ? WHERE id = ?", [j(offer), id]); }
  setModels(id: string, models: ModelFile[]): void { this.db.run("UPDATE nodes SET models = ? WHERE id = ?", [j(models), id]); }
  setMetrics(id: string, metrics: NodeMetrics, caps?: Partial<Capabilities>): void {
    if (caps) {
      const cur = this.getNode(id)?.caps;
      if (cur) this.db.run("UPDATE nodes SET caps = ? WHERE id = ?", [j({ ...cur, ...caps }), id]);
    }
    this.db.run("UPDATE nodes SET metrics = ?, last_seen = ?, online = 1 WHERE id = ?", [j(metrics), now(), id]);
  }

  // ---------- deployments ----------

  createDeployment(id: string, spec: DeploymentSpec): Deployment {
    const ts = now();
    this.db.run("INSERT INTO deployments (id, spec, state, created_at, updated_at) VALUES (?, ?, 'planned', ?, ?)", [id, j(spec), ts, ts]);
    this.db.run("INSERT INTO deployment_intent (deployment_id) VALUES (?)", [id]);
    return this.getDeployment(id)!;
  }

  getDeployment(id: string): Deployment | null {
    const r = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM deployments WHERE id = ?").get(id);
    return r ? rowToDeployment(r) : null;
  }

  listDeployments(): Deployment[] {
    return this.db.query<Record<string, unknown>, []>("SELECT * FROM deployments ORDER BY created_at DESC").all().map(rowToDeployment);
  }

  updateDeployment(id: string, patch: { state?: DeploymentState; plan?: Plan | null; endpoint?: Deployment["endpoint"] | null; error?: string | null }): void {
    const sets: string[] = ["updated_at = ?"]; const vals: unknown[] = [now()];
    if (patch.state !== undefined) { sets.push("state = ?"); vals.push(patch.state); }
    if (patch.plan !== undefined) { sets.push("plan = ?"); vals.push(patch.plan ? j(patch.plan) : null); }
    if (patch.endpoint !== undefined) { sets.push("endpoint = ?"); vals.push(patch.endpoint ? j(patch.endpoint) : null); }
    if (patch.error !== undefined) { sets.push("error = ?"); vals.push(patch.error); }
    vals.push(id);
    this.db.run(`UPDATE deployments SET ${sets.join(", ")} WHERE id = ?`, vals as never[]);
  }

  deleteDeployment(id: string): void {
    this.db.run("DELETE FROM deployment_intent WHERE deployment_id = ?", [id]);
    this.db.run("DELETE FROM assignments WHERE deployment_id = ?", [id]);
    this.db.run("DELETE FROM deployments WHERE id = ?", [id]);
  }

  deploymentIntent(id: string): { running: boolean; attempts: number; retryAt: number } {
    const row = this.db.query<{ running: number; attempts: number; retry_at: number }, [string]>("SELECT running, attempts, retry_at FROM deployment_intent WHERE deployment_id = ?").get(id);
    return { running: !!row?.running, attempts: row?.attempts ?? 0, retryAt: row?.retry_at ?? 0 };
  }

  setDeploymentIntent(id: string, patch: { running?: boolean; attempts?: number; retryAt?: number }): void {
    const cur = this.deploymentIntent(id);
    this.db.run(`INSERT INTO deployment_intent (deployment_id, running, attempts, retry_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(deployment_id) DO UPDATE SET running = excluded.running, attempts = excluded.attempts, retry_at = excluded.retry_at`,
    [id, (patch.running ?? cur.running) ? 1 : 0, patch.attempts ?? cur.attempts, patch.retryAt ?? cur.retryAt]);
  }

  // ---------- assignments ----------

  putAssignment(a: Assignment, nodeId: string, state: AssignmentRow["state"] = "sent"): void {
    this.db.run(
      `INSERT INTO assignments (id, deployment_id, node_id, body, state, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, state = excluded.state, node_id = excluded.node_id, updated_at = excluded.updated_at, retired = 0`,
      [a.id, a.deploymentId, nodeId, j(a), state, now()],
    );
  }

  setAssignmentState(id: string, state: AssignmentState, detail?: string): AssignmentRow | null {
    this.db.run("UPDATE assignments SET state = ?, detail = COALESCE(?, detail), updated_at = ? WHERE id = ?", [state, detail ?? null, now(), id]);
    return this.getAssignment(id);
  }

  retireAssignment(id: string): void { this.db.run("UPDATE assignments SET retired = 1 WHERE id = ?", [id]); }

  getAssignment(id: string): AssignmentRow | null {
    const r = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM assignments WHERE id = ?").get(id);
    return r ? rowToAssignment(r) : null;
  }

  listAssignments(deploymentId?: string): AssignmentRow[] {
    const rows = deploymentId
      ? this.db.query<Record<string, unknown>, [string]>("SELECT * FROM assignments WHERE deployment_id = ? ORDER BY updated_at").all(deploymentId)
      : this.db.query<Record<string, unknown>, []>("SELECT * FROM assignments ORDER BY updated_at").all();
    return rows.map(rowToAssignment);
  }

  // ---------- events + api keys ----------

  event(kind: string, message: string, ids: { nodeId?: string; deploymentId?: string } = {}): void {
    this.db.run("INSERT INTO events (ts, kind, node_id, deployment_id, message) VALUES (?, ?, ?, ?, ?)", [now(), kind, ids.nodeId ?? null, ids.deploymentId ?? null, message]);
  }

  listEvents(limit = 200): EventRow[] {
    return this.db.query<Record<string, unknown>, [number]>("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit).map((r) => ({
      id: r.id as number, ts: r.ts as string, kind: r.kind as string, nodeId: (r.node_id as string | null), deploymentId: (r.deployment_id as string | null), message: r.message as string,
    }));
  }

  createApiKey(name: string): string {
    const b = new Uint8Array(24); crypto.getRandomValues(b);
    const key = "sw-" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    this.db.run("INSERT INTO api_keys (key, name, created_at) VALUES (?, ?, ?)", [key, name, now()]);
    return key;
  }

  hasApiKey(key: string): boolean {
    return !!this.db.query<{ key: string }, [string]>("SELECT key FROM api_keys WHERE key = ?").get(key);
  }

  /** Stable participant credential, delivered only over that node's signed agent session. */
  nodeApiKey(nodeId: string): string {
    if (!this.getNode(nodeId)) throw new Error("unknown node");
    const name = `node:${nodeId}`;
    return this.db.query<{ key: string }, [string]>("SELECT key FROM api_keys WHERE name = ? ORDER BY created_at LIMIT 1").get(name)?.key ?? this.createApiKey(name);
  }

  listApiKeys(): Array<{ name: string; createdAt: string; keyPrefix: string }> {
    return this.db.query<{ key: string; name: string; created_at: string }, []>("SELECT key, name, created_at FROM api_keys ORDER BY created_at").all()
      .map((r) => ({ name: r.name, createdAt: r.created_at, keyPrefix: r.key.slice(0, 8) }));
  }
}

function rowToNode(r: Record<string, unknown>): NodeRow {
  return {
    id: r.id as string, pubJwk: p<JsonWebKey>(r.pub_jwk)!, certFp: r.cert_fp as string, hostname: r.hostname as string,
    os: r.os as string, arch: r.arch as string, enrolledAt: r.enrolled_at as string, lastSeen: (r.last_seen as string | null) ?? null,
    online: r.online === 1, agentVersion: (r.agent_version as string | null) ?? null,
    caps: p<Capabilities>(r.caps), offer: p<Offer>(r.offer), models: p<ModelFile[]>(r.models) ?? [], metrics: p<NodeMetrics>(r.metrics),
  };
}

function rowToDeployment(r: Record<string, unknown>): Deployment {
  return {
    id: r.id as string, spec: p<DeploymentSpec>(r.spec)!, state: r.state as DeploymentState, plan: p<Plan>(r.plan) ?? undefined,
    endpoint: p<Deployment["endpoint"]>(r.endpoint) ?? undefined, error: (r.error as string | null) ?? undefined,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

function rowToAssignment(r: Record<string, unknown>): AssignmentRow {
  return {
    id: r.id as string, deploymentId: r.deployment_id as string, nodeId: r.node_id as string, body: p<Assignment>(r.body)!,
    state: r.state as AssignmentRow["state"], detail: (r.detail as string | null) ?? null, updatedAt: r.updated_at as string, retired: r.retired === 1,
  };
}
