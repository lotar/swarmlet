# Disk-streamed Qwen experts under 16 GB

Actual Qwen3.8 Flash Next GGUF expert slices are read with `pread` and macOS
`F_NOCACHE`, dequantized on demand, and retained in a bounded pinned/LRU cache.
The service processes layers sequentially, so only selected experts for the
current/hot layers are active.

```bash
# Conservative smoke
python3 proofs/qwen-disk-experts/stream_experts.py \
  --cache-mib 512 --layers 48 --passes 2

# Largest live-host tested cache
python3 proofs/qwen-disk-experts/stream_experts.py \
  --cache-mib 8192 --rss-limit-mib 15360 \
  --layers 48 --passes 2 --policy pinned
```

Safety enforcement:

- continuous RSS sampling every 50 ms;
- hard process delta cap 15 GiB;
- host free-memory abort below 8%;
- swap-growth abort above 1 GiB;
- pre-eviction before dequant allocation;
- transient misses do not pollute a frozen hot cache.

## Actual Qwen results

Each layer selects top-10 actual experts plus the actual shared expert.
Dequantized working set per layer is ~206 MiB. Across 48 repeated routes the
working set is ~9.9 GiB.

| Cache | Policy | Second-pass hits | Second-pass prep time | Peak RSS delta |
|---:|---|---:|---:|---:|
| 512 MiB | LRU | 0 / 528 | 6.12 s | 1.23 GiB |
| 4 GiB | pinned | 218 / 528 | 3.46 s | 4.86 GiB |
| 6 GiB | pinned | 327 / 528 | 2.16 s | 5.24 GiB |
| 8 GiB | pinned, stable routes | 436 / 528 | **1.00 s** | 6.69 GiB |
| 8 GiB | pinned, changed routes | 55 / 528 | 5.49 s | **8.12 GiB** |

Layer-0 actual FFN:

- cold stream/dequant/compute: ~130–150 ms;
- immediate warm compute: ~1.7–9.9 ms;
- cold/warm output norm identical: 2.4539425.

These full-pass timings measure expert preparation only for most layers; only
the configured first layers execute NumPy FFNs. They are not full-model token
throughput.

## Interpretation

Naive LRU cyclically thrashes when cache < working set. Freezing a profiled
hotset preserves useful entries and streams misses transiently. Route churn is
the decisive variable: stable routes achieved 82.6% hits at 8 GiB, while a
new synthetic route profile achieved only 10.4%.

`pread` itself consumed ~0.1 s of a 5–6 s cold pass; Python Q4/Q8 dequantization
and allocation dominate. A production design should:

1. keep compressed expert tensors in the cache;
2. execute them with fused quantized GPU kernels (no F32 expansion);
3. double-buffer/prefetch next-layer experts;
4. profile routing frequency and pin `(layer,expert)` hotsets;
5. stream cold misses from local NVMe;
6. keep active weights + KV/workspace below 16 GB.

## Kimi projection

Kimi top-16 selected MXFP4 experts require ~267 MiB compressed per MoE layer,
or ~25.8 GB of cold expert reads across 92 layers/token. Sequential layer
streaming fits 16 GB easily (active weights hundreds of MiB), but the complete
selected working set does not. At the measured Qwen compressed-to-ready rate,
a naive cold Kimi projection is only ~0.01 tok/s. Fused MXFP4 kernels, hotset
reuse and asynchronous prefetch are mandatory; disk streaming solves capacity,
not interactive throughput by itself.
