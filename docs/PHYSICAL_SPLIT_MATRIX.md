# Qwen3.8 Flash physical split matrix

Date: 2026-09-01

## Decision

The real Qwen layer-0 expert service is functionally valid across the Mac and
both Legions. A two-Legion split won batch 1 in the final run, but the winner
flipped between two clean campaigns and the merged advantage was only 1.4%,
inside the observed 10% to 12% run-to-run variation. At batch 4 and 16, Legion 2
alone won both campaigns and the merged best splits were 27.1% and 28.9% slower.

This kills static portable-CPU expert splitting as a performance route. It does
not kill the orchestration architecture or GPU-native expert placement. The
next expert experiment needs measured per-expert costs, GPU-resident workers,
and a scheduler that minimizes the slowest parallel branch rather than merely
balancing expert counts.

## Accepted physical expert matrix

Every arm uses the same content-addressed FP16 bundles for the same ten routed
Qwen experts. Nodes n1, n2, and n3 own 4, 3, and 3 experts and execute in
parallel. Node n4 is the cold replica of n2 and is not on the normal hot path.
Values below are aggregate layer-0 FFN calls per second, not full-model tokens
per second.

| Physical placement | Batch 1 | Batch 4 | Batch 16 |
|---|---:|---:|---:|
| Mac local control | **67.52** | **256.37** | **1030.04** |
| Legion 1 only | 12.03 | 39.21 | 105.82 |
| Legion 2 only | 12.49 | **43.47** | **123.22** |
| Legion 1: 7, Legion 2: 3 | 11.77 | 24.80 | **88.82** |
| Legion 1: 4, Legion 2: 6 | 11.63 | 25.98 | 78.70 |
| Legion 1: 3, Legion 2: 7 | 12.93 | **27.26** | 88.30 |
| Legion 1: 6, Legion 2: 4 | **14.03** | 26.17 | 82.00 |

Bold remote values identify the best single-Legion and two-Legion values for
each batch. Each cell is the median of five samples. All arms selected identical
experts and produced binary FP16 max absolute error `9.52e-05` against the
independent streamed GGUF reference.

A preceding independently clean campaign provides a repeatability check. When
the ten samples per topology are merged, Legion 2 alone measures `13.14 / 44.07
/ 130.17` calls/s at batch 1/4/16. The best split measures `13.33 / 32.12 /
92.56`. Batch 1 is therefore inconclusive; batch 4 and 16 are decisive losses.

## Full evidence matrix by scope

These rows are intentionally separated by scope. Layer-0 calls per second,
full-model decode tokens per second, and speculative goodput are not directly
interchangeable.

| Scope | Placement or mode | Concurrency | Measured rate | Status |
|---|---|---:|---:|---|
| Full model, local | Target only | 1 | 33.27 tok/s per stream | Baseline |
| Full model, local | MTP Q4, n=3 | 1 | **43.71 tok/s per stream** | Best measured interactive decode |
| Full model, local | Target only | 4 | 60.16 tok/s aggregate | Beats local MTP aggregate |
| Full model, local | MTP Q4, n=3 | 4 | 38.56 tok/s aggregate | No-go at c4 |
| Full model, local | Target only | 8 | 76.94 tok/s aggregate | Beats local MTP aggregate |
| Full model, local | MTP Q4, n=3 | 8 | 41.82 tok/s aggregate | No-go at c8 |
| Full generation, layer-0 bank remote | Legion 1 CPU | 1 | 21.19 tok/s | Functional, no speedup |
| Full generation, layer-0 bank remote | Legion 1 CUDA | 1 | 21.21 tok/s | Functional, no material speedup |
| Full generation, layer-0 bank remote | Legion 1 CUDA+CPU | 1 | 14.00 tok/s | Killed |
| Full generation, layer-0 bank remote | Legion 2 CPU | 1 | **21.30 tok/s** | Best single-Legion full-generation arm |
| Full generation, layer-0 bank remote | Legion 2 CUDA | 1 | 20.50 tok/s | Functional, CPU slightly faster |
| Full generation, layer-0 bank remote | Legion 2 CUDA+CPU | 1 | 14.91 tok/s | Killed |
| Full generation, sequential tensor groups | Both Legions CUDA | 1 | 1.89 tok/s | Hard no-go |
| Remote speculative screen | Legion 2 MTP Q4 over stock RPC | 4 | 12.08 good tok/s aggregate | Hard no-go for capacity |
| Layer-0 routed expert service | Legion 2 CPU only | 1/4/16 batch | 12.49 / 43.47 / 123.22 calls/s | Best single-Legion placement |
| Layer-0 routed expert service | Best two-Legion split | 1/4/16 batch | 14.03 / 27.26 / 88.82 calls/s | Batch 1 win did not repeat; slower at batch 4/16 |

The stock remote-MTP screen produced 9.41 draft proposals per arm-second and
3.20 verification blocks per arm-second. The capacity gate requires at least
32 draft tokens per second and 10.88 blocks per second per Legion, a 3.4x gap.
The separate direct-MTP worker lane is still implementation-only and has no
accepted physical throughput number yet.

## Why the split loses

The coordinator already fans n1, n2, and n3 out concurrently, so this is not a
serial-RPC artifact. Each layer call still waits for the slowest owner. Adding a
second physical host adds another network path and exposes the slower Legion 1
branch, while the static 4/3/3 assignment balances expert counts rather than
actual expert compute time. At larger batches, the single Legion 2 placement
remains well ahead.

## Evidence and safety

- Accepted campaign: `sin-harness/data/physical-expert-matrix-final-20260901T171441Z/result.json`
- State record: `sin-harness/data/physical-expert-matrix-final-20260901T171441Z/state.json`
- Repeatability campaign: `sin-harness/data/physical-expert-matrix-clean-20260901T170907Z/result.json`
- Exact PID cleanup smoke for the final code: `sin-harness/data/physical-expert-matrix-exact-pid-smoke-20260901T172402Z/result.json`
- Model shard SHA-256: `4fe5f475ebee7d9dee7a3594ba1ad1103d9abe2a0ce805eb8e0f951d8fece437`
- Placement epoch: `dbfb348f69825230e6d5dd300349a1bd120bf4a25c23df6edf24ea0f5a2b0ef3`
- Production Qwen stayed healthy on PID `66350` before and after.
- Independent post-run checks found no benchmark listener, worker, or staging
  directory on either Legion.
- The final result hashes the worker, protocol, bundle loader, cell, exporter,
  external proof, and physical-matrix orchestrator sources.
- The earlier `physical-expert-matrix-20260901T170027Z` campaign and two cleanup
  smokes are explicitly rejected by their `independent-postcheck.json` files and
  are not used for any number in this report.

## Reproduce

```bash
python3 sin-harness/proofs/qwen-flash-experts/physical_matrix.py \
  --shard /path/to/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00005.gguf \
  --gguf-py /path/to/llama.cpp/gguf-py \
  --out sin-harness/data/physical-expert-matrix-$(date -u +%Y%m%dT%H%M%SZ) \
  --samples 5
```
