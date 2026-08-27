# Tiny true-expert MoE proof

A dependency-free, memory-bounded proof of the data-plane semantics required by
frontier expert parallelism. Unlike `EXPERT_SPLIT=1` in the llama.cpp harness
(which places complete fused expert banks by layer), this proof assigns
individual expert IDs to sovereign owners and routes top-k activations.

Run:

```bash
bun test test/tiny-moe-distributed.test.ts
# or
bun run test:tiny-moe
```

It starts three loopback-only Bun processes, never Docker or a model. Fixtures
are 3.6 KB total. Hard assertions cover disjoint ownership, NOT_OWNER behavior,
exact top-2/reference parity, deterministic reduction, batching, 92 serial
barriers, fail-closed churn, restart parity, and <1 GiB incremental RSS.

Passing this proves protocol semantics only. It does not prove Kimi K3 quality,
GPU kernels, quantization parity, or frontier-scale throughput. See
`../../../docs/KIMI_K3_DISTRIBUTED_MOE.md` for the scale model and kill criteria.
