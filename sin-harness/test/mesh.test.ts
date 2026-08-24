// test/mesh.test.ts — local distributed-compute simulation tests (P0a).
// The coordinator runs IN-PROCESS but spawns every node as a REAL OS process
// (bun mesh/node.ts), each with its own SQLite store, Ed25519 identity, and
// in-process deterministic mock L0 endpoint (--mock). No real model needed.
//
// Covered:
//  1. Certification passes across 3 nodes, work spread over all of them.
//  2. Redundant-execution cross-check: every REDUNDANT_EVERY-th instance ran
//     on 3 DISTINCT nodes and agreed byte-for-byte (determinism contract).
//  3. Churn drill: SIGKILL one node mid-run -> coordinator discovers the death
//     via failed fetch, retries on survivors, run still certifies.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  runCertification,
  type CertificationResult,
} from "../mesh/coordinator.ts";
import { verifyObject } from "../core/sign.ts";
import { ensureKeys } from "../core/sign.ts";

const TIMEOUT = 120_000;

async function keys(): Promise<CryptoKey> {
  const k = await ensureKeys("data/keys/coordinator");
  return k.pub;
}

describe("mesh simulation (mock endpoints)", () => {
  test(
    "certification passes across 3 nodes with signed certificate",
    async () => {
      const r: CertificationResult = await runCertification({
        ports: [9321, 9322, 9323],
        count: 40,
        version: "test-t1",
        suiteSeed: 1234,
        mock: true,
      });
      expect(r.accepted).toBe(true);
      expect(r.failedInstances).toBe(0);
      expect(r.disagreements).toHaveLength(0);
      expect(r.killedNodes).toHaveLength(0);
      // all three nodes actually participated
      for (const id of ["n1", "n2", "n3"]) {
        expect(r.perNode[id]?.executed ?? 0).toBeGreaterThan(0);
      }
      // total executions = 40 primaries + cross-check extra copies (2 instances x 2)
      const totalExecuted = Object.values(r.perNode).reduce(
        (a, s) => a + s.executed,
        0,
      );
      expect(totalExecuted).toBe(40 + 2 * 2);
      // certificate file written and signature present
      expect(existsSync(r.certPath)).toBe(true);
      const cert = await Bun.file(r.certPath).json();
      expect(typeof cert.signature).toBe("string");
      expect(await verifyObject(cert, await keys())).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "cross-check agreement: 3 distinct nodes produce byte-identical results",
    async () => {
      const r = await runCertification({
        ports: [9331, 9332, 9333],
        count: 41, // indices 0,20,40 are redundant -> 3 checked instances
        version: "test-t2",
        suiteSeed: 777,
        mock: true,
      });
      expect(r.accepted).toBe(true);
      expect(r.crossChecked).toBe(3);
      // determinism contract: min distinct-node copies == full 3, zero degraded
      expect(r.crossCheckCopiesMin).toBe(3);
      expect(r.degradedCrossChecks).toBe(0);
      expect(r.disagreements).toHaveLength(0);
    },
    TIMEOUT,
  );

  test(
    "churn drill: kill a node mid-run; certification still completes via retry",
    async () => {
      const r = await runCertification({
        ports: [9341, 9342, 9343],
        count: 60,
        version: "test-t3",
        suiteSeed: 424242,
        mock: true,
        chaos: 2, // SIGKILL n3 right after the first successful dispatch
      });
      // The external-crash semantics mean the coordinator only learns of the
      // death through failed dispatches — so requeues MUST have happened.
      expect(r.killedNodes).toContain("n3");
      expect(r.requeues).toBeGreaterThanOrEqual(1);
      // ...and the run was not lost:
      expect(r.accepted).toBe(true);
      expect(r.failedInstances).toBe(0);
      expect(r.disagreements).toHaveLength(0);
    },
    TIMEOUT,
  );
});
