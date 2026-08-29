# Flash Next full test matrix — 2026-08-29

Readiness/maintenance contract:

- local Swarmlet web: `127.0.0.1:8123`, PID 74163, unchanged before/after;
- production LaunchAgent booted out during tests and restored afterward;
- restored service: `com.lotar.llm-flashnext`, health OK;
- target: Qwen3.8 Flash Next UD-Q4_K_XL;
- drafts: native MTP Q8_0 / Q4_K_M, `n=3`;
- context 8192; 128 tokens/stream; four server slots for c1/c4 and eight for c8.

## Results

| Concurrency | Variant | Per-stream median | P95 floor | Aggregate | Mean output/verify | Acceptance | Parity |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Target | 33.27 | 33.27 | 31.62 | 1.00 | — | baseline |
| 1 | MTP Q8 n=3 | 43.51 | 43.51 | 39.24 | 3.70 | 89.9% | 1/1 IDs+content |
| 1 | **MTP Q4 n=3** | **43.71** | **43.71** | **40.16** | 3.64 | 87.9% | 1/1 IDs+content |
| 4 | Target | 15.89 | 15.89 | **60.16** | 1.00 | — | baseline |
| 4 | MTP Q8 n=3 | 11.80 | 10.37 | 38.74 | 3.26 | 75.3% | 2/4 IDs+content |
| 4 | MTP Q4 n=3 | 11.60 | 10.28 | 38.56 | 3.15 | 72.2% | 1/4 IDs+content |
| 8 | Target | 10.32 | 10.22 | **76.94** | 1.00 | — | baseline |
| 8 | MTP Q8 n=3 | 5.80 | 5.33 | 40.45 | 3.06 | 69.2% | 2/8 IDs+content |
| 8 | MTP Q4 n=3 | 6.00 | 5.49 | 41.82 | 3.09 | 70.2% | 1/8 IDs+content |

## Interpretation

- Native MTP helps concurrency 1 substantially: Q4 reaches 43.71 tok/s,
  +31.4% over this campaign target control.
- Q4 is slightly faster than Q8 at c1 and c8 while using less memory.
- At concurrency 4/8, the single CPU draft engine and speculative scheduling
  become bottlenecks; target-only has much higher aggregate and per-stream TPS.
- Content/token differences under concurrency are expected to include known
  Metal batch-composition nondeterminism; only c1 provides exact parity here.
- The requested 50 tok/s per stream is not achieved empirically. It remains a
  conditional eight-node pipeline target requiring a trained DFlash2 and
  measured stage p99 ≤8.8–10.5 ms.

## Signed evidence

- `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json`
- `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.signed.json`
- signer fingerprint: `90c6b530967b3280febf2ba4c9184559be265ce807fb1917b2b1367d14d24954`
