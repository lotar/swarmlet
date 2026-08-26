# SIN topology benchmarks

## Apples-to-apples campaign (OLMoE Q4_K_M)

Date: 2026-08-26. Host: Apple M5 Max. Docker Desktop VM: 28 GB / 6 CPUs.
Every row uses the exact same model, context, prompt and output:

- model: `OLMoE-1B-7B-0125-Instruct-Q4_K_M.gguf`
- context: 2048
- prompt: deterministic 1681-token fill
- output: 341 tokens (`floor(2048/6)`), EOS ignored
- temperature: 0; prompt cache disabled
- statistic: median of 3 runs
- reproduction: `sin-harness/scripts/bench-ctx2k.sh`

| Topology | Added network | Prefill tok/s | Decode tok/s | ms/output token |
|---|---:|---:|---:|---:|
| Local Metal / one GPU sidecar | none | 8445.6 | 306.6 | 3.3 |
| Sovereign CPU site (2-core cap) | local only | 84.5 | 24.2 | 41.3 |
| RPC layer split | Docker LAN | 57.6 | 28.0 | 35.7 |
| RPC expert split | Docker LAN | 78.2 | 33.1 | 30.3 |
| RPC layer split | pan-EU fiber (6/11/8 ms) | 45.0 | 12.0 | 83.2 |
| RPC expert split | pan-EU fiber (6/11/8 ms) | 37.5 | 4.6 | 216.5 |

### Interpretation

- On LAN, expert split wins for Q4 because Metal keeps attention/router/KV and
  the remote CPUs execute only expert FFNs. This is the inverse of the older Q8
  result and is why mixed-quant tables must not be used for design decisions.
- Across Europe, layer split wins decode by 2.6x because it has far fewer
  sequential network crossings per token. Expert split's host-to-shard
  round-trips dominate despite better local compute placement.
- Sovereign CPU is host-independent and slightly slower than LAN RPC expert
  split, but much faster than expert split over WAN because all token-level
  computation stays inside the site.
- The GPU-site result measures the native Metal model process directly. Docker
  controllers add RTT to mesh operations, not to the model's internal token
  loop. All three logical sites share one physical M5 GPU.

## Acceptance status

| Topology | E2E acceptance | Certification duration |
|---|---:|---:|
| RPC layer/expert | 8/8 | topology-dependent |
| Sovereign CPU sites | 8/8 | 16.6 s |
| GPU-site simulation | 8/8 | 2.8 s |

GPU-site churn kills both Munich's Docker controller and its dedicated model/KV
process; the in-flight instance is requeued and `failed=0`.
