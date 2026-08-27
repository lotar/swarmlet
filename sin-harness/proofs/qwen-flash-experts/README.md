# Qwen3.8 Flash Next distributed expert-cell service

Production-shaped, memory-bounded service using actual Qwen layer-0 GGUF
weights already present on this machine. No second full model is loaded.

## Architecture

```text
client/llama skeleton
  -> signed /manifest (content-bound placement epoch)
  -> /v1/ffn-bin (FP16 activation frame)
      -> router: real 512-way Qwen router, top-10
      -> n1: 4 actual experts (MLX/Metal)
      -> n2: 3 actual experts (MLX/Metal)
      -> n3: 3 actual experts (MLX/Metal)
      -> n4: exact cold replica of n2
      -> FP16 node partials, deterministic reduction
      -> local actual shared expert + sigmoid gate
  <- complete layer-0 FFN output
```

Metadata: 48 layers, 512 experts/layer, top-10, hidden 2560, expert FFN
640, `UD-Q4_K_XL` (104 GB checkpoint).

## Run

```bash
cd sin-harness
QWEN_EXPERT_BACKEND=mlx bun run test:qwen-experts
```

Standalone server:

```bash
PYTHONPATH=/Users/lotar/projects/local-llm/llama.cpp-rpc/gguf-py \
python3 proofs/qwen-flash-experts/server.py --backend mlx \
  --shard /Users/lotar/projects/local-llm/models/qwen3.8-flash-next/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00002-of-00005.gguf
```

## API

- `GET /health`
- `GET /manifest` — Ed25519 signature/public key, tensor bytes/type/shape
  digests, primary/replica map and epoch
- `POST /v1/ffn-bin` — bounded FP16 binary frame (production-shaped path)
- `POST /v1/ffn` — bounded JSON instrumentation path
- `POST /admin/stop-owner|start-owner` — `{placementEpoch,nodeId}`

The epoch is enforced client→service→workers. Production should provision the
public key out-of-band rather than trusting the key returned beside a manifest.

## Hardened MLX/binary result

Selected IDs: `194,255,140,417,298,119,374,259,21,284`.

| Profile | Batch | Binary API median | Aggregate throughput |
|---|---:|---:|---:|
| LAN | 1 | 30.4 ms | 32.9 tok/s |
| LAN | 4 | 29.1 ms | 137.7 tok/s |
| LAN | 16 | 29.0 ms | 552.0 tok/s |
| EU 12/16/22ms | 1 | 51.5 ms | 19.4 tok/s |
| EU 12/16/22ms | 4 | 60.5 ms | 66.1 tok/s |
| EU 12/16/22ms | 16 | 58.2 ms | 274.7 tok/s |

JSON batch-1: 72.4 ms LAN / 99.6 ms EU. Binary removes most serialization
cost and makes batch compute nearly flat on the shared M5 GPU simulation.

Validation:

- NumPy reference vs MLX JSON full FFN: max abs `1.04e-7`
- rank-varied batch-4 max abs: `4.18e-4`
- FP16 binary max abs: `1.21e-4`
- signed manifest verified
- stale epoch and nonresident routes rejected
- n2 primary loss: exact n4 replica succeeded (cold failover 334.8 ms)
- n2+n4 loss: failed closed
- restart parity restored
- projected 48-layer EU floor: 2.47 s/token, **0.40 tok/s**
- final RSS delta 727.7 MiB; sampled peak 814.6 MiB (<900 cap)
- swap growth 0; all workers cleaned up

The cold replica is intentional for this loaded-host test: it verifies hashes at
startup but dequantizes only after primary loss, preserving the fixed memory
cap. A physical multi-node deployment can keep replicas warm on separate cards.

## Scope

This is the complete layer-0 FFN branch (routed + shared expert/gate). It still
excludes attention/SSM, residual, KV and sampling. The formula is cross-checked
against pinned `qwen4exp.cpp`; a live llama.cpp graph/logit comparison requires
restarting the 104-GB model with the external-FFN graph hook.
