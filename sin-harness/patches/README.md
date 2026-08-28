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

## `apply-dflash2-pr27342.sh`

Fetches a SHA-256-pinned upstream DFlash2 implementation patch, verifies it,
and applies it only after `git apply --check`. It applied cleanly to the local
`dfa0c0f` Qwen4Exp tree (alongside the external FFN hook), and `llama-server`
compiled successfully with two build jobs. This ports runtime logic only; it
does not create target-specific DFlash2 weights.

## `llama-qwen4exp-mtp-lowram-converter.patch`

Avoids Torch's BF16→F32→BF16 promotion for >100-MiB tensors by writing a
zero-copy uint16 BF16 view to GGUF, and accepts Qwen4Exp's `full_attention`
metadata as non-recurrent. Required to convert the 7.224-GiB MTP source under
an 8-GiB process cap. Measured conversion peak: 5.8 GiB.

## `llama-spec-force-reject-test.patch`

Test-only sampler hook `SIN_FORCE_REJECT_POS`. It may force an *earlier*
rejection only; natural mismatches still win, so it never accepts an invalid
draft-conditioned prefix. Compiles with the local DFlash2/rollback worktree.
Runtime positions 1–7 remain unvalidated because the full-target rollback test
exceeded the host memory gate.

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
