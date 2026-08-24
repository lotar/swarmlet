# Mesh layer — local distributed-compute simulation (P0a)

Implements PRD L4 mechanics on one machine: N logical nodes as **separate OS
processes**, a coordinator that certifies eval suites across them, redundant-
execution cross-checks, and churn tolerance (kill a node mid-run — the run
completes via retry). Per PRD gate rule: P4 changes topology, not logic.

## Run

```bash
# 3 nodes + coordinator against the REAL llama-server (:8081):
bun run mesh/coordinator.ts --count 40

# Fully offline (each node self-hosts a deterministic core/mock.ts endpoint):
bun run mesh/coordinator.ts --mock --count 40

# Churn drill: SIGKILL node #3 (index 2) after the first successful dispatch:
bun run mesh/coordinator.ts --mock --count 60 --chaos 2

# Unit-level simulation tests (mock, ephemeral-ish ports):
bun test test/mesh.test.ts
```

## Design notes

- **Determinism is the contract.** Identical `(instance, endpoint)` pairs must
  yield byte-identical outputs (`temperature=0`, pinned seed). That is what
  makes the triple-run cross-check a *proof*, not a heuristic: any divergence
  between two nodes executing the same instance fails certification.
- **Private shards stay private.** A node's shard is derived deterministically
  from *its own* captured events (template choice + seed are hashes of
  `nodeId:eventId`). `/shard` exposes only `count` and a digest — contents
  never leave the machine (GDPR-clean by construction, PRD L2 §2).
- **Signed results.** Every `/execute` and `/audition` response carries an
  Ed25519 signature over the canonical comparable payload; the coordinator
  verifies before counting. Keys: `data/keys/<nodeId>/`, coordinator in
  `data/keys/coordinator/`.
- **Redundancy:** every `REDUNDANT_EVERY`-th instance (5%) is executed on 3
  distinct nodes and compared. Under churn it degrades to however many nodes
  survive (≥1) — a run is lost only if *all* nodes die.
- **Chaos hook:** `--chaos <index>` SIGKILLs that node after the first
  successful dispatch. This is equivalent to an external kill and keeps the
  drill deterministic instead of sleep-raced.
- Certificates land in `data/certs/<certId>.json`.
