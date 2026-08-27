# llama.cpp integration patches

## `llama-qwen-external-ffn.patch`

Applies to the local Qwen4Exp-compatible llama.cpp tree at commit `dfa0c0f`.
It adds an opt-in layer FFN custom op that sends the complete Qwen FFN boundary
to the signed FP16 expert-cell service.

```bash
git apply /path/to/ai-mesh/sin-harness/patches/llama-qwen-external-ffn.patch
cmake -B build -DGGML_METAL=ON -DLLAMA_CURL=OFF
cmake --build build -j2 --target llama-server
```

Disabled by default. Runtime variables:

```bash
SIN_EXTERNAL_FFN_URL=http://127.0.0.1:9590
SIN_EXTERNAL_FFN_EPOCH=<64-char epoch from GET /manifest>
SIN_EXTERNAL_FFN_LAYER=0
SIN_EXTERNAL_FFN_PROFILE=lan   # or eu
```

The custom op transfers Metal activations to CPU, encodes FP16, calls
`/v1/ffn-bin`, decodes FP16 output and resumes the graph. Service errors abort
inference fail-closed rather than silently substituting local/wrong experts.

## `llama-qwen4exp-rs-rollback.patch`

Compile-checked enablement of recurrent-state snapshots for Qwen4Exp. DFlash2
or native MTP block verification must roll recurrent state back after partial
rejection. This patch only enables the existing generic snapshot machinery;
it is **not runtime-attested** because no Flash-Next-compatible DFlash2 drafter
exists. Before production, force rejection at every block position 1–7 and
compare tokens/logits/state byte-for-byte against target-only execution.

Validation status:

- patch applied in isolated worktree: yes
- `llama-server` compiled at `dfa0c0f`: yes
- service/binary protocol/MLX experts/replica simulation: yes
- live 104-GB Qwen graph/logit comparison: **not run** because it requires
  restarting the user's active `:8099` model. Schedule a maintenance window.
