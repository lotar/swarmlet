#!/usr/bin/env bun
// mesh/coordinator.ts — distributed eval certification across local node
// processes (the P0a simulation of PRD L4 mesh mechanics).
//
// Guarantees exercised here:
//  1. Determinism: identical instances executed on different nodes must yield
//     byte-identical comparable results; divergence fails certification.
//  2. Redundancy: every REDUNDANT_EVERY-th instance runs on up to
//     REDUNDANT_COPIES distinct nodes and is cross-checked (degrades
//     gracefully under churn).
//  3. Churn tolerance: a dead node's work is retried on survivors — killing
//     any one node mid-run never loses the run (only total loss does).
//  4. Signed results: responses are Ed25519-verified before being counted.
//
// Usage:
//   bun run mesh/coordinator.ts [--count 40] [--version v1] [--seed n]
//        [--ports 9201,9202,9203] [--mock]
// Churn drill:
//   bun run mesh/coordinator.ts --mock --chaos 2   # SIGKILLs n3 mid-run

import { mkdirSync } from "node:fs";
import { loadConfig, PROJECT_ROOT, resolveFromRoot } from "../core/config.ts";
import { fnv1a } from "../core/mock.ts";
import { canonicalize, ensureKeys, signObject } from "../core/sign.ts";
import type { EvalInstance, EvalResult } from "../core/types.ts";
import { generateSuite } from "../evals/generate.ts";
import {
  comparableOf,
  meshGet,
  meshPost,
  REDUNDANT_COPIES,
  REDUNDANT_EVERY,
  sameResult,
  verifyExecuteResponse,
  type ComparableResult,
  type ExecuteResponse,
} from "./protocol.ts";

interface CoordArgs {
  ports: number[];
  count: number;
  version: string;
  suiteSeed?: number;
  mock: boolean;
  /** SIGKILL the node at this index right after its first successful dispatch. */
  chaos?: number;
  /** Kill at dispatch-start instead of after first success — deterministic
   * mid-run death for remote/containerized victims where graceful stop races
   * the (short) dispatch queue. Death is still discovered via failed fetch. */
  chaosAtStart?: boolean;
  /** Attach mode: nodes are externally managed (e.g. docker compose); the
   * coordinator only connects, never spawns local processes. */
  attach?: boolean;
  /** Attach-mode chaos hook: fired instead of a local SIGKILL when the chaos
   * victim has no coordinator-owned process. The death must still manifest as
   * failed fetches — same discovery path as production churn. */
  onExternalChaos?: (nodeId: string) => void;
}

function parseArgs(argv: readonly string[]): CoordArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const portsRaw = get("--ports");
  return {
    ports: portsRaw
      ? portsRaw.split(",").map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0)
      : [], // empty => take from config.json in runCertification()
    count: Number(get("--count") ?? 40),
    version: get("--version") ?? "v1",
    suiteSeed: get("--seed") !== undefined ? Number(get("--seed")) : undefined,
    mock: argv.includes("--mock"),
    chaos: get("--chaos") !== undefined ? Number(get("--chaos")) : undefined,
  };
}

// ---------- node handles ----------

interface NodeHandle {
  nodeId: string;
  port: number;
  baseUrl: string;
  proc: Bun.Subprocess | null;
  alive: boolean;
  pub: CryptoKey | null;
}

async function ensurePubkey(n: NodeHandle): Promise<CryptoKey> {
  if (n.pub) return n.pub;
  const pk = await meshGet<{ jwk: JsonWebKey }>(`${n.baseUrl}/pubkey`);
  n.pub = await crypto.subtle.importKey("jwk", pk.jwk, { name: "Ed25519" }, false, [
    "verify",
  ]);
  return n.pub;
}

export interface CrossCheckDisagreement {
  instanceId: string;
  variants: Array<{ nodeId: string; result: ComparableResult }>;
}

export interface CertificationResult {
  certId: string;
  certPath: string;
  accepted: boolean;
  suiteSeed: number;
  version: string;
  instanceCount: number;
  redundantEvery: number;
  /** Instances that received >=2 executions on distinct nodes. */
  crossChecked: number;
  /** Minimum distinct-node copies actually obtained for any checked instance. */
  crossCheckCopiesMin: number;
  /** Checked instances that got <REDUNDANT_COPIES distinct copies (churn). */
  degradedCrossChecks: number;
  /** Instances certified by strict-majority vote after re-execution (kernel
   *  tie-flip tolerance; see docs/PoC.md "TMR reconciliation"). */
  reconciled: number;
  disagreements: CrossCheckDisagreement[];
  requeues: number;
  failedInstances: number;
  killedNodes: string[];
  perNode: Record<string, { executed: number; passed: number; passRate: number }>;
  durationMs: number;
}

export interface CertificationOpts extends Partial<CoordArgs> {}

export async function runCertification(
  opts: CertificationOpts,
): Promise<CertificationResult> {
  const t0 = performance.now();
  const cfg = await loadConfig();
  const args: CoordArgs = {
    ports: opts.ports?.length ? opts.ports : cfg.mesh.nodePorts,
    count: opts.count ?? 40,
    version: opts.version ?? "v1",
    suiteSeed: opts.suiteSeed ?? cfg.suiteSeed,
    mock: opts.mock ?? false,
    chaos: opts.chaos,
    attach: opts.attach ?? false,
    chaosAtStart: opts.chaosAtStart ?? false,
    onExternalChaos: opts.onExternalChaos,
  };
  if (!Number.isInteger(args.count) || args.count <= 0) {
    throw new Error(`--count must be a positive integer, got ${args.count}`);
  }
  if (args.ports.length === 0) {
    throw new Error("no node ports configured (config.json mesh.nodePorts or --ports)");
  }

  // --- spawn nodes as real OS processes ------------------------------------
  const nodes: NodeHandle[] = [];
  for (const [i, port] of args.ports.entries()) {
    const nodeId = `n${i + 1}`;
    let proc: Bun.Subprocess | null = null;
    if (!args.attach) {
      const argv = [
        process.execPath,
        `${PROJECT_ROOT}/mesh/node.ts`,
        "--id",
        nodeId,
        "--port",
        String(port),
        "--db",
        `data/events-${nodeId}.sqlite`,
      ];
      if (args.mock) argv.push("--mock");
      proc = Bun.spawn(argv, {
        cwd: PROJECT_ROOT,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      });
    }
    nodes.push({
      nodeId,
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      proc,
      alive: true,
      pub: null,
    });
  }

  const killedNodes: string[] = [];
  let chaosFired = false;

  // Declared BEFORE the try block: chaosAtStart fires it right after health
  // checks, which precedes its old (post-dispatch) definition site — a const
  // referenced that early would be a TDZ ReferenceError.
  const killChaosTarget = (): void => {
    if (chaosFired || args.chaos === undefined) return;
    const victim = nodes[args.chaos];
    if (!victim || !victim.alive) return;
    chaosFired = true;
    if (!killedNodes.includes(victim.nodeId)) killedNodes.push(victim.nodeId);
    if (victim.proc) {
      // External-crash semantics: SIGKILL WITHOUT touching `alive`. The
      // coordinator must discover the death through a failed fetch, exactly
      // as it would in production — that is what exercises the retry path.
      victim.proc.kill(9);
      console.log(`[coordinator] chaos: SIGKILLed ${victim.nodeId} mid-run`);
    } else {
      // Attach mode: no owned process; delegate the kill to the operator
      // hook (e.g. `docker compose stop node-n3`). Same discovery contract:
      // the coordinator learns of the death via failed fetches.
      args.onExternalChaos?.(victim.nodeId);
      console.log(`[coordinator] chaos: external kill signaled for ${victim.nodeId}`);
    }
  };

  try {
    // --- wait for health (fail fast on nodes that never come up) ------------
    for (const n of nodes) {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try {
          await meshGet<{ status: string }>(`${n.baseUrl}/health`, 1000);
          up = true;
        } catch {
          await Bun.sleep(50);
        }
      }
      if (!up) throw new Error(`node ${n.nodeId} did not become healthy`);
    }
    await Promise.all(nodes.map(ensurePubkey));
    if (args.chaosAtStart && args.chaos !== undefined) killChaosTarget();

    // --- deterministic suite --------------------------------------------------
    const instances = generateSuite(args.suiteSeed ?? 0, args.version, args.count);
    const redundantIds = new Set(
      instances.filter((_, i) => i % REDUNDANT_EVERY === 0).map((x) => x.id),
    );

    interface WorkItem {
      inst: EvalInstance;
      /** Extra copy for cross-checking (primary copies carry no marker). */
      extraCopy: boolean;
      attempts: number;
    }
    const queue: WorkItem[] = [];
    for (const [i, inst] of instances.entries()) {
      queue.push({ inst, extraCopy: false, attempts: 0 });
      if (i % REDUNDANT_EVERY === 0) {
        for (let c = 1; c < REDUNDANT_COPIES; c++) {
          queue.push({ inst, extraCopy: true, attempts: 0 });
        }
      }
    }

    const singleResults = new Map<string, ComparableResult>();
    /** All executions per redundant instance (multiset — duplicates allowed for voting). */
    const multiResults = new Map<string, Array<{ nodeId: string; result: ComparableResult }>>();
    const perNode: Record<string, { executed: number; passed: number }> = {};
    for (const n of nodes) perNode[n.nodeId] = { executed: 0, passed: 0 };
    let requeues = 0;
    let failedInstances = 0;

    const aliveNodes = (): NodeHandle[] => nodes.filter((n) => n.alive);
    let rr = 0;
    const pickNode = (exclude: readonly string[]): NodeHandle | null => {
      const pool = aliveNodes();
      if (pool.length === 0) return null;
      const preferred = exclude.length > 0
        ? pool.filter((n) => !exclude.includes(n.nodeId))
        : pool;
      const list = preferred.length > 0 ? preferred : pool; // degrade rather than stall
      const picked = list[rr % list.length];
      rr++;
      return picked ?? null;
    };

    function record(n: NodeHandle, item: WorkItem, r: EvalResult): void {
      const stats = perNode[n.nodeId];
      if (!stats) return;
      stats.executed++;
      if (r.passed) stats.passed++;
      const comp = comparableOf(r);
      if (redundantIds.has(item.inst.id)) {
        let m = multiResults.get(item.inst.id);
        if (!m) multiResults.set(item.inst.id, (m = []));
        m.push({ nodeId: n.nodeId, result: comp });
      } else {
        singleResults.set(item.inst.id, comp);
      }
    }

    async function executeOn(
      n: NodeHandle,
      item: WorkItem,
    ): Promise<"ok" | "dead" | "bad"> {
      try {
        const resp = await meshPost<ExecuteResponse>(
          `${n.baseUrl}/execute`,
          {
            requestId: `req-${item.inst.id}-${item.attempts}-${attemptsSalt++}`,
            instances: [item.inst],
          },
          // Distributed/slow backends: an instance may run minutes. Override
          // with SIN_EXECUTE_TIMEOUT_MS.
          Number(process.env.SIN_EXECUTE_TIMEOUT_MS ?? 300_000),
        );
        if (resp.nodeId !== n.nodeId || resp.results.length === 0) return "bad";
        const pub = await ensurePubkey(n);
        if (!(await verifyExecuteResponse(resp, pub))) return "bad"; // unsigned/tampered
        record(n, item, resp.results[0] as EvalResult);
        return "ok";
      } catch (e) {
        // A TIMEOUT means the node is alive but slow — do NOT eject it from
        // the pool (that would cascade every queued item to failure on any
        // slow backend). Only network-level refusal/reset means "dead".
        const msg = e instanceof Error ? e.message : String(e);
        if (/timed out|timeout|abort/i.test(msg)) {
          console.error(`[coordinator] dispatch to ${n.nodeId} timed out (node kept)`);
          return "bad";
        }
        console.error(`[coordinator] dispatch to ${n.nodeId} failed: ${msg}`);
        return "dead";
      }
    }
    let attemptsSalt = 0;

    // --- worker pool with churn-tolerant retry ---------------------------------
    const CONCURRENCY = 4;
    let next = 0;
    const MAX_ATTEMPTS = 6 * Math.max(1, nodes.length);
    const worker = async (): Promise<void> => {
      while (true) {
        const i = next++;
        const item = queue[i];
        if (!item) return;
        // Extra copies should prefer nodes that don't hold a copy yet.
        const exclude = item.extraCopy
          ? (multiResults.get(item.inst.id) ?? []).map((x) => x.nodeId)
          : [];
        const n = pickNode(exclude);
        if (!n) {
          item.attempts++;
          if (item.attempts > MAX_ATTEMPTS) failedInstances++;
          else queue.push(item);
          continue;
        }
        const outcome = await executeOn(n, item);
        if (outcome === "ok") {
          if (!args.chaosAtStart) killChaosTarget(); // fire once, after the first successful response
          continue;
        }
        if (outcome === "dead" && n.alive) {
          n.alive = false;
          n.proc?.kill(9);
          if (!killedNodes.includes(n.nodeId)) killedNodes.push(n.nodeId);
        }
        requeues++;
        item.attempts++;
        if (item.attempts > MAX_ATTEMPTS) failedInstances++;
        else queue.push(item);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // --- cross-check (TMR reconciliation) --------------------------------------
    // Empirical P0a finding: even with temperature 0, pinned seeds and cold
    // prompt cache, near-tie greedy tokens can flip between physically separate
    // executions (Metal kernel reduction order). Unanimity across nodes is
    // therefore not achievable at ~100% for every instance. Redundant execution
    // here follows triple-modular-redundancy semantics:
    //   unanimous            -> certified
    //   strict majority      -> certified, counted as `reconciled`
    //   no majority          -> up to 2 extra rounds of REDUNDANT_COPIES runs;
    //                          still no majority -> certification disagreement.
    const tally = (
      arr: ReadonlyArray<{ result: ComparableResult }>,
    ): Map<string, number> => {
      const m = new Map<string, number>();
      for (const v of arr) {
        const k = canonicalize(v.result);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };

    // First-round coverage snapshot (before reconciliation adds copies).
    let copiesMin = multiResults.size === 0 ? 0 : Infinity;
    let degradedCrossChecks = 0;
    for (const [, arr] of multiResults) {
      const distinct = new Set(arr.map((v) => v.nodeId)).size;
      copiesMin = Math.min(copiesMin, distinct);
      if (distinct < REDUNDANT_COPIES) degradedCrossChecks++;
    }

    let reconciled = 0;
    const disagreements: CrossCheckDisagreement[] = [];
    for (const [instanceId, arr] of multiResults) {
      const inst = instances.find((i) => i.id === instanceId);
      if (!inst) continue; // unreachable: multiResults keys come from instances
      let t = tally(arr);
      for (let round = 0; round < 2; round++) {
        const max = Math.max(0, ...t.values());
        if (max === arr.length || max * 2 > arr.length) break; // unanimous or majority
        // No verdict yet: one more copy per node, then re-tally.
        for (let c = 0; c < REDUNDANT_COPIES; c++) {
          const exclude = arr.slice(-REDUNDANT_COPIES).map((v) => v.nodeId);
          const n = pickNode(exclude);
          if (!n) break;
          await executeOn(n, { inst, extraCopy: true, attempts: 0 });
        }
        t = tally(arr);
      }
      const max = Math.max(0, ...t.values());
      if (max * 2 <= arr.length) {
        disagreements.push({
          instanceId,
          variants: arr.map(({ nodeId, result }) => ({ nodeId, result })),
        });
      } else if (max < arr.length) {
        reconciled++; // majority verdict after kernel tie-flip(s)
      }
    }

    const covered = singleResults.size + multiResults.size;
    const accepted =
      failedInstances === 0 &&
      disagreements.length === 0 &&
      covered === args.count &&
      aliveNodes().length > 0;

    // --- signed certificate -------------------------------------------------------
    const perNodeOut: Record<
      string,
      { executed: number; passed: number; passRate: number }
    > = {};
    for (const [id, s] of Object.entries(perNode)) {
      perNodeOut[id] = {
        executed: s.executed,
        passed: s.passed,
        passRate: s.executed === 0 ? 0 : s.passed / s.executed,
      };
    }
    const durationMs = Math.round(performance.now() - t0);
    const certId = `mesh-cert-${fnv1a(`${args.suiteSeed}:${args.version}:${args.count}`)}-${Date.now()}`;
    const keys = await ensureKeys(resolveFromRoot("data/keys/coordinator"));
    const cert = await signObject(
      {
        certId,
        date: new Date().toISOString(),
        kind: "mesh-certification",
        suiteSeed: args.suiteSeed ?? 0,
        version: args.version,
        instanceCount: args.count,
        redundantEvery: REDUNDANT_EVERY,
        crossChecked: multiResults.size,
        crossCheckCopiesMin: Number.isFinite(copiesMin) ? copiesMin : 0,
        degradedCrossChecks,
        reconciled,
        disagreementCount: disagreements.length,
        requeues,
        failedInstances,
        killedNodes,
        accepted,
        durationMs,
        perNode: perNodeOut,
      },
      keys.priv,
    );
    const certDir = resolveFromRoot("data/certs");
    mkdirSync(certDir, { recursive: true });
    const certPath = `${certDir}/${certId}.json`;
    await Bun.write(certPath, JSON.stringify(cert, null, 2));

    printSummary({
      accepted,
      nodes: nodes.map((n) => ({ id: n.nodeId, port: n.port })),
      count: args.count,
      crossChecked: multiResults.size,
      copiesMin: Number.isFinite(copiesMin) ? copiesMin : 0,
      degradedCrossChecks,
      reconciled,
      disagreements,
      requeues,
      failedInstances,
      killedNodes,
      perNode: perNodeOut,
      durationMs,
      certPath,
    });

    return {
      certId,
      certPath,
      accepted,
      suiteSeed: args.suiteSeed ?? 0,
      version: args.version,
      instanceCount: args.count,
      redundantEvery: REDUNDANT_EVERY,
      crossChecked: multiResults.size,
      crossCheckCopiesMin: Number.isFinite(copiesMin) ? copiesMin : 0,
      degradedCrossChecks,
      reconciled,
      disagreements,
      requeues,
      failedInstances,
      killedNodes,
      perNode: perNodeOut,
      durationMs,
    };
  } finally {
    // The coordinator always reaps its children — no orphans between runs.
    for (const n of nodes) {
      if (n.proc && n.alive) {
        n.proc.kill(9);
        n.alive = false;
      }
    }
  }
}

function printSummary(s: {
  accepted: boolean;
  nodes: Array<{ id: string; port: number }>;
  count: number;
  crossChecked: number;
  copiesMin: number;
  degradedCrossChecks: number;
  reconciled: number;
  disagreements: CrossCheckDisagreement[];
  requeues: number;
  failedInstances: number;
  killedNodes: string[];
  perNode: Record<string, { executed: number; passed: number; passRate: number }>;
  durationMs: number;
  certPath: string;
}): void {
  console.log("\n== Mesh Certification Summary ==");
  console.log(`nodes: ${s.nodes.map((n) => `${n.id}(:${n.port})`).join("  ")}`);
  console.log(
    `killed mid-run: ${s.killedNodes.length ? s.killedNodes.join(",") : "(none)"}`,
  );
  console.log(
    `instances: ${s.count}   cross-checked(every ${REDUNDANT_EVERY}th): ${s.crossChecked} (min copies ${s.copiesMin})   degraded: ${s.degradedCrossChecks}   reconciled(TMR): ${s.reconciled}`,
  );
  console.log(
    `disagreements: ${s.disagreements.length}   requeues: ${s.requeues}   failed: ${s.failedInstances}`,
  );
  for (const [id, st] of Object.entries(s.perNode)) {
    console.log(
      `  ${id.padEnd(4)} executed=${String(st.executed).padStart(3)}  passed=${String(st.passed).padStart(3)}  passRate=${st.passRate.toFixed(3)}`,
    );
  }
  console.log(
    `decision: ${s.accepted ? "ACCEPT" : "REJECT"}   duration: ${(s.durationMs / 1000).toFixed(2)}s`,
  );
  console.log(`cert: ${s.certPath}\n`);
}

// ---------- CLI ----------

if (import.meta.main) {
  runCertification(parseArgs(process.argv.slice(2)))
    .then((r) => process.exit(r.accepted ? 0 : 1))
    .catch((e) => {
      console.error("[coordinator] fatal:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
