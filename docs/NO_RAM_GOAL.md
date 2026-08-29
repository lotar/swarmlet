# No-RAM goal completion

One command validates all eight deliverables without materializing/executing
model weights, starting Docker containers, or restarting production. The
partition planner memory-maps GGUF files read-only to inspect tensor metadata;
it does not access tensor payloads:

```bash
cd sin-harness
bun run test:no-ram-goal
```

## Deliverables

| # | Deliverable | Result |
|---:|---|---:|
| 1 | Deterministic hybrid rollback fixture | 56 byte-exact checks, positions 0–6, 8 sequences |
| 2 | DFlash2 training schemas | Valid candidate; unknown training hyperparameters explicit/null |
| 3 | Hidden-feature cache | Append-only FP16, SHA-256, JSONL index, truncation recovery |
| 4 | Eight-stage scheduler | Discrete event, p50/p95/p99 queue/inter-block/utilization |
| 5 | Layer partition planner | Actual GGUF bytes, 8 contiguous six-layer stages under 12 GiB |
| 6 | Signed run manifests | Ed25519 sign/verify; tampering rejected |
| 7 | Comparator/report generator | 13-row measured/simulated grid |
| 8 | LaunchAgent runbook | check-only/status/stop/start, exact service ownership |

## E2E safety

- production PID unchanged;
- `/health` remained OK;
- no model/Docker workload started;
- E2E process RSS delta: 71.7 MiB.

## Partition result

| Stage | Layers | Weights |
|---:|---:|---:|
| 0 | 0–5 | 10.62 GiB |
| 1 | 6–11 | 9.26 GiB |
| 2 | 12–17 | 9.27 GiB |
| 3 | 18–23 | 9.26 GiB |
| 4 | 24–29 | 9.27 GiB |
| 5 | 30–35 | 9.51 GiB |
| 6 | 36–41 | 9.27 GiB |
| 7 | 42–47 | 10.38 GiB |

PLE: 26.82 GiB in system RAM. GPU target weights: 76.86 GiB total.
This leaves 1.38–2.74 GiB of the 12-GiB weight budget per stage for placement
adjustments; the separate 4-GiB runtime reserve remains outside that budget.

## Scheduler simulation

| Scenario | Per-stream median | Aggregate | P99 inter-block | Queue p50 / p99 |
|---|---:|---:|---:|---:|
| Rack, 7ms stage/.25ms link | 69.7 tok/s | 555.2 | 72.7 ms | 0.00 / 1.83 ms |
| Rack limit, 9ms/.25ms | 56.2 tok/s | 447.6 | 91.0 ms | 0.00 / 2.53 ms |
| Metro, 7ms/1ms | 65.1 tok/s | 518.2 | 77.6 ms | 0.00 / 1.64 ms |
| EU, 7ms/8ms | 39.3 tok/s | 312.9 | 126.2 ms | 0.00 / 1.27 ms |
| 10x EU | 7.68 tok/s | 61.3 | 630.2 ms | 0.00 / 1.25 ms |

These are conditional simulations with acceptance 4.8 and draft 10 ms, not
empirical stage timings.

## Exact next measurements

1. **One-stage hardware timing:** load layers 0–5 on one 16-GB card; width-8,
   concurrency 1/8; report p50/p95/p99 compute, VRAM and transfer. Required p99
   ≤8.8–10.5 ms.
2. **Native MTP concurrency:** clean host, Q8 n=3, concurrency 1/4/8, target A/B/A;
   report each stream plus aggregate. Current only concurrency 1 is attested.
3. **Deterministic backend rollback:** run the compiled forced-rejection hook on
   a tiny Qwen4Exp GGUF/CPU fixture and compare actual llama recurrent+KV bytes;
   current integer fixture is an algorithm oracle, not backend attestation.
4. **PLE service:** benchmark cold/warm row lookup, page faults and p99 under
   eight streams; require <1 ms p99 contribution.
5. **DFlash2 training pilot:** fill candidate config unknowns only from measured
   target-feature cache/training runs; compare all tap grids and block 4/5/8.
6. **Eight-node E2E:** only after stages pass; require per-stream median ≥50,
   p95 ≥45, aggregate ≥400, no stage >10% slower than median.

See `docs/RESULTS_GRID.md` for all measured/simulated values to date.
