# Qwen3.8 Flash Next real-weight expert service

A reusable layer-0 FFN service built from the already-present local GGUF. It
never loads a second full model: only the layer-0 router, shared expert, and the
router-selected expert slices are touched.

Local metadata:

- architecture `qwen4exp` / Qwen3.8 Flash Next
- 48 layers, 512 routed experts/layer, top-10
- hidden width 2560, expert FFN width 640
- `UD-Q4_K_XL`, 104 GB checkpoint already on this machine

## Run

```bash
cd sin-harness
bun run test:qwen-experts
```

Standalone service:

```bash
PYTHONPATH=/Users/lotar/projects/local-llm/llama.cpp-rpc/gguf-py \
python3 proofs/qwen-flash-experts/server.py \
  --shard /Users/lotar/projects/local-llm/models/qwen3.8-flash-next/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00005.gguf
```

Endpoints (loopback only):

- `GET /health`
- `GET /manifest` — model/layer/top-k, selected IDs, ownership, epoch, profiles
- `POST /v1/ffn` — `{placementEpoch, activations:[[2560 floats]], profile:"lan"|"eu"}`
- `POST /admin/stop-owner` / `/admin/start-owner` — `{placementEpoch,nodeId}` churn drill
- `POST /shutdown`

## Implementation

1. Real layer-0 router selects actual top-10 IDs.
2. A content-bound placement epoch (router/shared/selected expert raw digests)
   partitions IDs 4/3/3 and is enforced at service and worker boundaries.
   The PoC epoch is intentionally unsigned; production manifests require Ed25519.
   Fetch the required value from `GET /manifest` before every FFN/admin request.
3. Three worker processes dequantize only owned gate/up/down slices.
4. Coordinator dispatches 2560-wide activations to owners in parallel.
5. Results reduce in ascending expert-ID order.
6. The actual local Qwen shared expert and sigmoid gate are added.
7. Routes outside the resident placement epoch fail with 409.
8. Owner loss fails with 503; exact restart restores parity.

## Measured result

Selected IDs: `194,255,140,417,298,119,374,259,21,284`.

| Profile | Batch | API median | Internal FFN | Aggregate throughput |
|---|---:|---:|---:|---:|
| LAN | 1 | 19.3 ms | 14.4 ms | 51.7 tok/s |
| LAN | 4 | 65.2 ms | 51.9 ms | 61.4 tok/s |
| LAN | 16 | 239.6 ms | 189.6 ms | 66.8 tok/s |
| EU 12/16/22ms | 1 | 39.2 ms | 35.0 ms | 25.5 tok/s |
| EU 12/16/22ms | 4 | 82.7 ms | 68.9 ms | 48.4 tok/s |
| EU 12/16/22ms | 16 | 256.5 ms | 205.9 ms | 62.4 tok/s |

- complete layer-0 FFN parity (routed + shared), batch 1 and rank-varied batch 4: max error `0`
- projected 48-layer EU barrier floor: 1.88 s/token, **0.53 tok/s**
- expert weights resident: ~187.5 MiB
- continuously sampled peak aggregate RSS delta: 696.0 MiB (<900 MiB cap)
- final aggregate RSS delta: 661.5 MiB; swap growth: 0 MiB
- no Docker/model server started

The projection excludes attention/SSM, residual, KV and sampling, so complete
model decode would be slower. The FFN formula is cross-checked against pinned
`qwen3next.cpp`, but an independent llama.cpp graph-callback fixture remains the
next integration gate. JSON is intentionally observable instrumentation;
production needs packed FP16/FP8 binary frames and persistent connections.
