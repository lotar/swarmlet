# Qwen3.8 Flash Next real-weight expert-sharding PoC

Uses the already-present local GGUF without loading a second model. It reads
metadata plus explicitly selected expert slices from layer 0.

Local GGUF metadata:

- architecture: `qwen4exp` (Qwen3.8 Flash Next preview of Qwen4)
- 48 layers
- 512 routed experts/layer
- top-10 routing
- hidden width 2560
- expert FFN width 640
- model file set: `UD-Q4_K_XL`, 104 GB on disk

Run:

```bash
cd sin-harness
python3 proofs/qwen-flash-experts/poc.py
# or
bun run test:qwen-experts
```

The PoC:

1. memory-maps GGUF shard 2 read-only;
2. evaluates the real layer-0 512x2560 router on a deterministic activation;
3. takes its actual top-10 experts;
4. partitions those expert IDs 4/3/3 among three Python processes;
5. each worker dequantizes only its own gate/up/down slices;
6. dispatches real 2560-wide activations and reduces weighted outputs;
7. checks exact parity against a streamed monolithic layer-0 reference;
8. benchmarks batch 1/4/16 with 0/10ms request delay;
9. kills one selected expert owner, requires fail-closed behavior, restarts the
   exact owner, and verifies parity again;
10. asserts proof RSS <900 MiB and swap growth <512 MiB.

Measured result on this machine:

- selected IDs: `194,255,140,417,298,119,374,259,21,284`
- resident dequantized expert bytes: 196,608,000 (~187.5 MiB)
- parity max absolute / relative error: 0 / 0
- peak proof RSS: 501.25 MiB; swap growth: 0 MiB
- actual one-layer top-10 service, batch 1: 9.4 ms LAN, 22.7 ms at +10ms
- projected 48-layer +10ms barrier floor: ~1.09 s/token (~0.92 tok/s)

This proves actual Qwen expert slicing, ownership, execution and reduction. It
is intentionally only the routed MoE component of layer 0: no attention/SSM,
shared expert, residual, KV, sampling, or full-model logits. Full-model parity
requires runtime integration at the graph boundary, not this standalone PoC.
