# Docker GPU simulation on Apple Silicon

## What works

Docker Desktop exposes the CDI device `docker.com/gpu=webgpu`. It injects a
Linux WebGPU client library and vsocket; a Metal-backed Dawn server executes
commands on macOS.

Live proof on this M5 Max (Docker Desktop 4.82): Docker's own 1024x1024 integer
matrix-multiply sample, run with `--device docker.com/gpu=webgpu`, returned the
correct result (`6144`) in **42.5 ms**. This is real host GPU forwarding, not
CPU emulation.

## Why pinned llama.cpp cannot use it directly yet

Docker Desktop's injected `libwebgpudd.so` is ABI-compatible with Dawn commit
`fb97d04c` (April 2024). The pinned llama.cpp commit `7584430` (August 2026)
contains a WebGPU backend, but it requires newer APIs including `StringView`,
`ShaderSourceWGSL`, modern async callbacks and subgroup-matrix feature types.
Compiling it against Docker's client fails at the API boundary. The generic
GPU bridge is valid; these two revisions are incompatible.

A direct implementation therefore needs one of:

1. Docker Desktop upgrades its WebGPU wire protocol/Dawn API;
2. port llama.cpp's WebGPU backend to Dawn-2024 and disable unavailable
   subgroup-matrix paths; or
3. use a WebGPU runtime already targeting Docker's 2024 API.

Do not describe the current llama.cpp containers as having direct GPU access.

## Working GPU-site simulation

`compose.gpu-sim.yaml` uses three dedicated native Metal `llama-server`
sidecars, one per European Docker node. Each sidecar has a separate process,
model mapping, KV cache, port and lifecycle:

- Vienna: host `:8081` -> Docker node n1
- Milan: host `:18082` -> Docker node n2
- Munich: host `:18083` -> Docker node n3

The Docker nodes retain independent code, Ed25519 keys, SQLite/event state and
private eval shards. All three logical GPU sites share this Mac's one physical
M5 GPU, so this is a **performance simulation**, not the zero-host-dependency
sovereignty proof. The CPU sovereign topology in `compose.sovereign.yaml`
remains the independence proof.

Run:

```bash
./scripts/start-gpu-sites.sh
docker compose -f compose.yaml -f compose.gpu-sim.yaml up -d gpu-n1 gpu-n2 gpu-n3
SIN_MESH_MODE=gpu-sim SIN_EXECUTE_TIMEOUT_MS=900000 \
  bun test test/e2e-docker.test.ts
```

The churn drill kills both Munich's Docker controller and its dedicated Metal
process, then requeues the in-flight instance. Full acceptance: 8/8 green.

Measured OLMoE Q4_K_M at ctx 2048 with 1681 prompt tokens + 341 output tokens:
median prefill **2502 tok/s**, decode **111.7 tok/s**.
