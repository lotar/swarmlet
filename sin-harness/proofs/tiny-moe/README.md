# Tiny true-expert MoE proof

A dependency-free, memory-bounded proof of the data-plane semantics required by
frontier expert parallelism. Unlike `EXPERT_SPLIT=1` in the llama.cpp harness
(which places complete fused expert banks by layer), this proof assigns
individual expert IDs to sovereign owners and routes top-k activations.

Run the local regression:

```bash
bun run test:tiny-moe
bun test test/tiny-moe-physical.test.ts
```

Run two physical Ubuntu owners through SSH forwarding:

```bash
NODE_A=user@host-a NODE_B=user@host-b bun run test:hardware
```

See `../../../docs/HOW_TO_TWO_NODE_PROOF.md` and `../../../docs/TWO_NODE_PROTOCOL.md`.

The regression starts loopback-only Bun processes, never Docker or a model.
Protocol v2 binds exact fixture hashes and ownership into a placement epoch.
Hard assertions cover bounded requests, disjoint ownership, NOT_OWNER and stale
epoch behavior, exact top-2/reference parity, coordinator-owned gate weights,
deterministic reduction, batching, 92 serial barriers, fail-closed churn,
supervised restart parity, and <1 GiB incremental RSS.

Passing this proves protocol semantics only. It does not prove Kimi K3 quality,
GPU kernels, quantization parity, or frontier-scale throughput. See
`../../../docs/KIMI_K3_DISTRIBUTED_MOE.md` for the scale model and kill criteria.
