# Swarmlet documentation

## Tutorial

- [Quick start](../README.md#quick-start): install the portable dependencies and run the release gate.

## How-to guides

- [Run the two-node proof](HOW_TO_TWO_NODE_PROOF.md): execute disjoint owners over SSH, inject failure, clean up, and sign evidence.
- [Release the source](RELEASE.md): validate, package, checksum, review, tag, and publish.
- [Preview and QA the site](../site/README.md): run the dependency-free server and optional Chrome probes.

## Reference

- [Two-node protocol](TWO_NODE_PROTOCOL.md): placement schema, HTTP API, bounds, status codes, and evidence contract.
- [No-RAM toolchain](NO_RAM_GOAL.md): rollback, cache, schema, scheduler, partition, signing, and comparison tools.
- [Results grid](RESULTS_GRID.md): provenance-backed measured, simulated, and projected results.
- [Benchmark campaign](BENCHMARKS.md): topology methodology and results.
- [Full Qwen test matrix](FULL_TEST_MATRIX.md): target/MTP Q8/Q4 concurrency results.

## Explanation and architecture

- [Product requirements](PRD.md): problem, product layers, sequencing, and business boundaries.
- [Implementation architecture](IMPLEMENTATION.md): modules, phases, and technical contracts.
- [Kimi distributed MoE study](KIMI_K3_DISTRIBUTED_MOE.md): why regional contiguous stages beat per-layer WAN routing.
- [DFlash2 on eight 16 GB nodes](DFLASH2_8X16GB.md): speculative pipeline assumptions and gates.
- [WebGPU findings](WEBGPU.md): bridge evidence and ABI limitation.
- [P0a proof specification](PoC.md): historical acceptance contract.

Every performance document must label rows as measured, simulated, or projected. Historical signed artifacts remain immutable even when they contain machine-local provenance paths.
