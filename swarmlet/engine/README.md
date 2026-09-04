# Swarmlet engine

The inference engine is upstream `llama.cpp` at the ref in `patches/UPSTREAM_REF` plus one patch,
`patches/llama-mesh-engine-<short>.patch`, which carries everything the mesh measured with in
`docs/FLASHNEXT_RING_LEVERS_20260904.md`:

- RPC protocol 8.1: pipelined writer/reader dispatcher (`GGML_RPC_PIPELINE=1`), per-device graph cache
  and graph-uid race fix, push forwarding between servers (`--peer`, `--peer-port`, `GGML_RPC_FORWARD=1`),
  batched boundary GETs (`GGML_RPC_GET_PIPELINE=1`), wire modes (`GGML_RPC_WIRE=off|f16|q8`), server-side
  trace (`GGML_RPC_SERVER_TRACE=1`).
- `ggml-rpc-server --mem-cap-mib N`: the node owner's per-device ceiling on client allocations and on the
  memory reported to clients (env `GGML_RPC_MEM_CAP_MIB` for the backend).
- `qwen4exp` MTP head-only GGUF loading (Flash-Next speculative decoding on a split model).
- `tools/ring-bench` (`llama-ring-bench`): N synchronized greedy streams, per-stream ms/token, aggregate tok/s.

## Build

```bash
swarmlet/engine/build.sh darwin            # M5: Metal + Apple BLAS, static binaries -> dist/darwin/
swarmlet/engine/build.sh linux             # Legion: CUDA arch 75 (GTX 1650/1650 Ti) -> dist/linux/
CUDA=0 swarmlet/engine/build.sh linux      # CPU-only Linux build
```

Each `dist/<target>/` holds `ggml-rpc-server`, `llama-server`, `llama-ring-bench`, `sha256.txt` and
`engine.json` (upstream ref, patch digest, build host and time). The node agent and the Tauri shell ship
these as sidecars; nothing is downloaded at runtime.

## Re-capturing the patch

After changing a patched working tree (`/tmp/llama-full-lab` on the M5):

```bash
swarmlet/engine/capture-patch.sh /tmp/llama-full-lab
```

## Acceptance (M0)

```bash
dist/darwin/ggml-rpc-server -d CPU -p 50999 --mem-cap-mib 64 &
python3 swarmlet/engine/test/memcap_probe.py 50999 64      # every line PASS, exit 0
```
