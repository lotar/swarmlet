# AI Mesh results grid

Measured and simulated values are intentionally separated. Disk-expert rows measure preparation, not full-model generation.

| Category | Variant | Kind | TPS | Latency | Δ vs Qwen target | Status | Source | Notes |
|---|---|---:|---:|---:|---:|---|---|---|
| Qwen full model | Target A1 | measured | 33.98 | 29.43 ms | +0.0% | pass | `sin-harness/proofs/dflash-pipeline/results/flashnext-native-mtp-20260829.json` | 8K, concurrency 1 |
| Qwen full model | Native MTP n=1 | measured | 35.98 | 27.79 ms | +5.9% | pass | `sin-harness/proofs/dflash-pipeline/results/flashnext-native-mtp-20260829.json` | mean output/verify 1.86 |
| Qwen full model | Native MTP n=3 | measured | 37.74 | 26.50 ms | +11.1% | best measured | `sin-harness/proofs/dflash-pipeline/results/flashnext-native-mtp-20260829.json` | +11.1%, mean output/verify 3.24 |
| Qwen full model | Native MTP n=7 | measured | 30.12 | 33.20 ms | -11.4% | regression | `sin-harness/proofs/dflash-pipeline/results/flashnext-native-mtp-20260829.json` | mean output/verify 4.30 |
| 8-stage pipeline | Rack limit | simulated | 50.13 | 95.75 ms | +47.5% | conditional | `sin-harness/proofs/dflash-pipeline/simulator.py` | A=4.8, stage=10.5ms, link=.25ms |
| 8-stage pipeline | EU 8ms | simulated | 36.92 | 130.00 ms | +8.7% | miss | `sin-harness/proofs/dflash-pipeline/simulator.py` | A=4.8 |
| 8-stage pipeline | 10x EU | simulated | 6.82 | 634.00 ms | -79.9% | miss | `sin-harness/proofs/dflash-pipeline/simulator.py` | A=4.8 |
| Expert FFN service | MLX binary LAN batch1 | measured | 32.92 | 30.40 ms | -3.1% | pass | `docs/KIMI_K3_DISTRIBUTED_MOE.md` | one FFN layer |
| Expert FFN service | MLX binary EU batch1 | measured | 19.41 | 51.50 ms | -42.9% | miss | `docs/KIMI_K3_DISTRIBUTED_MOE.md` | one FFN layer |
| Disk expert prep | 512MiB LRU repeated | measured | 0.16 | 6123.00 ms | -99.5% | thrash | `sin-harness/proofs/qwen-disk-experts/README.md` | 0/528 hits |
| Disk expert prep | 8GiB pinned stable | measured | 1.00 | 1002.00 ms | -97.1% | capacity proof | `sin-harness/proofs/qwen-disk-experts/README.md` | 436/528 hits; not full inference |
| Disk expert prep | 8GiB pinned churn | measured | 0.18 | 5485.00 ms | -99.5% | miss | `sin-harness/proofs/qwen-disk-experts/README.md` | 55/528 hits; not full inference |
| Kimi expert stream | Cold disk projection | projected | 0.01 | 90000.00 ms | -100.0% | miss | `docs/KIMI_K3_DISTRIBUTED_MOE.md` | capacity only; fused kernels absent |
| Qwen concurrency matrix | Target c1 | measured | 33.27 | 30.05 ms | -2.1% | pass | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 1; aggregate 31.62 tok/s |
| Qwen concurrency matrix | MTP Q8 n3 c1 | measured | 43.51 | 22.98 ms | +28.0% | pass | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 1; aggregate 39.24 tok/s |
| Qwen concurrency matrix | MTP Q4 n3 c1 | measured | 43.71 | 22.88 ms | +28.6% | pass | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 1; aggregate 40.16 tok/s |
| Qwen concurrency matrix | Target c4 | measured | 15.89 | 62.91 ms | -53.2% | pass | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 4; aggregate 60.16 tok/s |
| Qwen concurrency matrix | MTP Q8 n3 c4 | measured | 11.80 | 84.75 ms | -65.3% | regression | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 4; aggregate 38.74 tok/s |
| Qwen concurrency matrix | MTP Q4 n3 c4 | measured | 11.60 | 86.23 ms | -65.9% | regression | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 4; aggregate 38.56 tok/s |
| Qwen concurrency matrix | Target c8 | measured | 10.32 | 96.88 ms | -69.6% | pass | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 8; aggregate 76.94 tok/s |
| Qwen concurrency matrix | MTP Q8 n3 c8 | measured | 5.80 | 172.39 ms | -82.9% | regression | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 8; aggregate 40.45 tok/s |
| Qwen concurrency matrix | MTP Q4 n3 c8 | measured | 6.00 | 166.64 ms | -82.3% | regression | `sin-harness/proofs/dflash-pipeline/results/flashnext-mtp-concurrency-matrix-20260829.json` | concurrency 8; aggregate 41.82 tok/s |

## Best known points

- Best measured full Qwen: **43.71 tok/s** (native MTP Q4 n=3, concurrency 1 campaign).
- 50 tok/s remains a conditional rack-scale pipeline simulation, not an empirical result.
- Pan-European token-path variants remain below target.
- Kimi disk streaming fits memory but is not interactive.
