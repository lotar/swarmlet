# Swarmlet

Swarmlet is a source-available research harness for sovereign, distributed Mixture-of-Experts inference. It proves individual expert ownership, deterministic routing and reduction, signed placements, failure semantics, low-memory planning, and speculative-decoding evidence without pretending that a two-laptop experiment is a frontier-model deployment.

> **Release status:** `v1.0.0-alpha.1`. Protocol and research tooling may change. This is source available under the [Swarmlet Community License 1.0](LICENSE), not OSI Open Source.

## What is proven

- True per-expert routing across isolated operating-system processes.
- Exact tiny-MoE reference parity and fail-closed owner loss.
- A plan-pinned two-physical-owner protocol designed for SSH forwarding.
- Real Qwen3.8 Flash Next layer-0 routed and shared FFN parity on measured hardware.
- Native MTP extraction and measured single-stream improvement.
- Signed benchmark manifests with signer pinning and tamper rejection.
- Low-RAM rollback, feature-cache, scheduler, and partition-planning fixtures.

## What is not proven

- Full Qwen inference distributed across physical nodes.
- Kimi K3 execution, model quality, or interactive throughput.
- Eight physical 16 GB nodes or 50 tokens/s per stream.
- Production authentication, multi-tenant isolation, or internet-facing worker APIs.
- CUDA execution of the portable expert bundles.

See [docs/RESULTS_GRID.md](docs/RESULTS_GRID.md) for the measured/simulated distinction and [docs/KIMI_K3_DISTRIBUTED_MOE.md](docs/KIMI_K3_DISTRIBUTED_MOE.md) for architecture kill criteria.

## Quick start

Requirements:

- Bun `1.3.14`
- Python `3.12+`
- OpenSSL with Ed25519 support
- Node.js `22+` only for the static-site preview

```bash
git clone https://github.com/lotar/swarmlet.git ai-mesh
cd ai-mesh/sin-harness
bun install --frozen-lockfile
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --requirement requirements-proofs.txt
bun run test
```

The default command is hermetic and starts no model or Docker workload. It runs strict TypeScript checking, deterministic unit/process tests, and portable low-RAM proof checks.

Expected core result:

```text
60+ pass
0 fail
```

Exact counts may rise as tests are added; any failure blocks release.

## Test tiers

| Command | Requirements | Purpose |
|---|---|---|
| `bun run test` | Bun, Python, NumPy, OpenSSL | Required portable release gate |
| `bun run test:unit` | Bun | Deterministic TypeScript/process suites |
| `bun run test:proofs-portable` | Python, NumPy, OpenSSL | No-model proof formats and safety checks |
| `bun run test:integration` | local llama-server + OLMoE GGUF | Real-model P0a acceptance |
| `bun run test:docker` | Docker + pinned llama.cpp + GGUF | RPC topology acceptance |
| `bun run test:qwen-experts` | Qwen shard + llama.cpp gguf-py | Actual Qwen layer-0 FFN proof |
| `bun run test:no-ram-goal` | production Mac setup + actual GGUF | Host-specific full no-RAM attestation |
| `bun run test:hardware` | two key-authenticated Ubuntu hosts | Physical two-owner proof |

Models are never committed. Put optional models under `models/` or supply the documented environment variables.

## Two Ubuntu owners

The physical proof keeps every owner bound to `127.0.0.1`; SSH authenticates and encrypts transport. Start with [How to run the two-node proof](docs/HOW_TO_TWO_NODE_PROOF.md).

The physical runner is designed to prove this deliberately narrow claim:

> Two physical Ubuntu hosts executed disjoint deterministic experts through authenticated SSH forwards, matched the monolithic reference exactly, failed closed when a remote owner crashed, and restored parity after a plan-identical restart.

That claim remains **pending** until `test:hardware` produces a signed two-host result. The local supervisor/transport semantics pass in the portable suite; they are not a substitute for physical evidence.

## Real Qwen selected-expert bundles

The full GGUF stays with the coordinator. Export only the selected layer-0 experts:

```bash
export LLAMA_CPP=/path/to/pinned/llama.cpp
python proofs/qwen-flash-experts/export_bundles.py \
  --shard /path/to/Qwen3.8-Flash-Next-shard.gguf \
  --out data/qwen-layer0-bundles
```

Each bundle contains FP16 selected experts, raw tensor provenance digests, a content digest, node ownership, and the content-bound placement epoch. Linux workers need NumPy but not the complete model. See [Qwen expert proof reference](sin-harness/proofs/qwen-flash-experts/README.md).

## Repository map

```text
sin-harness/                 deterministic harness and proof programs
  core/                      L0 contract, mock server, signing
  evals/                     deterministic evaluation templates
  loop/                      capture, curate, refine, gate, graduate
  mesh/                      local mesh simulation
  proofs/tiny-moe/           true per-expert protocol and physical runner
  proofs/qwen-flash-experts/ actual Qwen layer-0 FFN proof
  proofs/no-ram-goal/        rollback/cache/scheduler/planner/evidence tools
  test/                      portable and explicit integration test tiers
docs/                        architecture, evidence, results, runbooks
site/                        dependency-free swarmlet.ai static site
tools/site/                  optional Chrome QA utilities
```

## Documentation

- [Documentation index](docs/README.md) — tutorial, how-to, reference, and explanation map
- [Getting started](README.md#quick-start) — tutorial
- [How to run the two-node proof](docs/HOW_TO_TWO_NODE_PROOF.md) — operational guide
- [Protocol reference](docs/TWO_NODE_PROTOCOL.md) — API and evidence contract
- [Why regional stages beat WAN experts](docs/KIMI_K3_DISTRIBUTED_MOE.md) — architecture explanation
- [No-RAM toolchain](docs/NO_RAM_GOAL.md) — proof-tool reference
- [Full test matrix](docs/FULL_TEST_MATRIX.md) — measured Qwen results
- [Results grid](docs/RESULTS_GRID.md) — measured, simulated, and projected rows
- [Release process](docs/RELEASE.md) — gates, evidence policy, archive and tag
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Third-party terms](THIRD_PARTY.md)

## Security

Worker HTTP endpoints are not authenticated data-plane services. Keep them on loopback and use SSH local forwarding. Never bind proof workers to `0.0.0.0` or expose admin endpoints to a LAN or the internet. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

## License

Personal and noncommercial use is free. Commercial use is free while the user's entire corporate group has no more than EUR 1,000,000 in worldwide gross annual revenue. A group already above that threshold needs a separate license before Commercial Use. A previously eligible group that later loses eligibility receives only Section 4's 90-day transition.

That revenue restriction makes this **source available**, not Open Source. Read the complete [Swarmlet Community License 1.0](LICENSE); the summary above is not a substitute. Have qualified counsel review the custom license before public publication.
