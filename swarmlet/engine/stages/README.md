# Resident Qwen35 stage and state-transfer proof

This directory implements a native resident `llama_context` per contiguous Qwen35 shard,
plus complete recurrent and attention sequence-state migration between full-model contexts.
It is separate from the existing RPC worker: intermediate stages own their context and
consume raw activations, without a coordinator constructing their GGML graphs.

**Qualification passed on 2026-09-09** at `ctx=1024`, with eight decode
continuation steps, unchanged `atol=1e-3` / `rtol=1e-4`, and exact greedy tokens:

| Execution | Largest absolute difference |
| --- | ---: |
| Local Metal 3/21 and 3/3/18 stages, plus full-state migration | 0 |
| Legion 1 layers 0–3 → Mac layers 3–24 | 0.000010014 |
| Legion 1 layers 0–3 → Legion 2 layers 3–6 → Mac layers 6–24 | 0.000009537 |
| Full state Mac → CUDA, receiver prefill zero | 0.000007629 |
| Full state CUDA → Mac, receiver prefill zero | 0.000005722 |

The qualified precision profile uses F32 KV cache, one-token native microbatches,
disabled flash attention, F32 attention accumulation, and tiled CUDA Q8_0 matmuls
with pedantic cuBLAS math. It retains the original quantized model weights.
Earlier failures showed additional CUDA activation quantization, half-precision
attention arithmetic, and F16 cache rounding could exceed the fixed tolerance.
Those diagnostics are retained; the gates were never widened.

Private evidence: `stage-proof-20260909-05/result.json` SHA256
`23c9d834f9c8c164701c98ac09742a60e4792328dbed4d1ea5cf60976f2fe2b6`, and
`stage-cross-proof-20260909-02/result.json` SHA256
`5bddb3bec4a3bd437af76f8dd3b045e5e73fbbc9365bb725e6780d34d5ea3d79`.
The guarded suite retired every owned worker and restored the managed baseline
at `2026-09-09T13:38:43.783600Z`.

Engine ABI: `fefcec450d5b009e1f6fd2853c892e7d4be45d6a765ce9f7207d94e9589f9a3c`.
Metal binary SHA256: `0121c1cbb375040fa78a16f19f71b6b40bd95804831b1f3638b71dc73f30d430`.
CUDA binary SHA256: `35b5bcf5c7740390465193df9efb837d5a5cb77ec089fdd43bb6d70d25ed2b64`.
The parent GGUF is 2,012,012,800 bytes, SHA256
`1b04acba824817554f4ce23639bc8495ff70453b8fcb047900c731521021f2c1`.
Maximum measured process RSS was 2,258,532 KiB; maximum sampled CUDA memory was
2,072 MiB. CUDA weight-dequantization workspace is tiled to at most 32 MiB for
this model. Per-process measurements and native buffer logs are retained with
`stage-final-resources-20260909.json` in the private evidence directory.

This first proof targets the pinned Qwen3.5-2B model; other models remain unqualified. One active session per resident worker is deliberate: conflicting
sessions reject until the owner explicitly resets its session. Workers accept up to 64 tokens
per evaluation, context lengths 64–32768, and state payloads up to 512 MiB.

## Build and prepare

`build.sh` builds exact `../patches/UPSTREAM_REF` plus `qwen35-stage.patch` in an ignored
checkout. It does not modify the installed engine or its canonical RPC patch. Darwin uses
Metal; `CUDA=ON build.sh` enables CUDA on Linux (architecture 75 by default). Builds use two jobs.

```sh
swarmlet/engine/stages/build.sh
python3 swarmlet/engine/stages/extract.py MODEL.gguf OUTPUT_DIR \
  --cuts 0,3,6,24 --engine swarmlet/engine/.build/llama.cpp-stages
python3 -m unittest discover -s swarmlet/engine/stages -p 'test_*.py' -v
```

The extractor preserves quantized tensor bytes, renumbers the selected blocks, writes an
explicit recurrent-layer array, and includes embedding/head weights only where needed.
Manifests pin the parent GGUF SHA256 and each shard's SHA256. Intermediate output is the raw
last block activation, before final normalization and vocabulary projection.

## Native endpoint

```text
mesh-stage-worker MODEL SHA256 PRIVATE_STATE_DIR PORT GPU_LAYERS CTX
GET /health
POST /command
```

The server binds loopback. The mesh's authenticated transport must carry remote traffic.
Every command is serialized against the resident context. JSON request bodies are capped
at 4 MiB. Nonlocal Host, cross-origin Origin and non-JSON POST requests reject at the HTTP boundary. The endpoint supports:

- `status`: process ID, build/source and binary identity, session, position, evaluated tokens.
- `tokenize` with `text`: model token IDs.
- `chat_tokens` with `messages`: apply the model chat template and tokenize.
- `state_read`, `state_write`, `state_delete`: bounded HTTP capsule transport, with
  session ownership and exact append offsets. Chunk limits are 256 KiB.
- `eval` with `session`, `position`, and `tokens` or flattened F32 `activations`:
  evaluate a contiguous batch; return boundary activations or final logits/greedy token.
  `capture_layer` optionally captures a raw boundary for qualification.
- `export` with `session` and a simple `file` basename: save `FLAGS_NONE` native state
  and an envelope containing last logits, next position and identity.
- `import` with `session` and `file`: require an empty context, validate envelope/state
  digests and identity, load complete state, and verify native sequence position.
- `reset` with the owning `session`: clear sequence state while retaining loaded weights.

Transfer both the state file and its `.json` envelope into the receiver's private state
directory before import. Envelopes pin model bytes, source/state ABI, cache layout and
context capacity. Binary hashes and build configurations are recorded separately because
Metal and CUDA binaries differ. SHA checks detect corruption; transport authentication
remains the mesh's responsibility.

## Real qualification

The rig owner must run `verify.py` or `verify_remote.py` through
`swarmlet/e2e/idle-window.py --allow-stopped`, then `window.py --out WINDOW_DIR --`
to acquire the rig lock and stop/restore the managed baseline.
The verifier refuses a missing guard marker and cleans up only its own processes, including
on TERM/INT. It never stops the standing deployment. Supply 2-stage and 3-stage manifest
directories, the full model and digest, a new private output directory, and the worker binary.

The proof compares raw intermediate activations and final logits against uninterrupted
full-model execution at fixed `atol=1e-3`, `rtol=1e-4`, requires identical greedy token IDs,
checks persistent PIDs/session isolation, and tests full-state P/D continuation without
receiver prefill. Corrupted state, model identity, logits, positions and invalid sessions
must reject. Cross-node portability requires the separate Mac/CUDA proof; a local pass
alone does not establish it. `verify_suite.py` runs both proofs sequentially in one
guarded window and stops on the first failure.

`prepare_remote.py` transfers hash-checked source/shards and builds CUDA using two CPU
jobs without loading a model. `verify_remote.py` exercises L1/Mac and L1/L2/Mac
chains through actual SSH HTTP forwards, then Mac-to-CUDA and CUDA-to-Mac state
migration. Each remote worker has an owned process group; closing its SSH stdin or
sending TERM retires that group and records cleanup before baseline restoration.
