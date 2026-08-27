# DFlash2 + Qwen3.8 Flash Next on 8 × 16-GB nodes

Status: five-lane primary-source/source-code review complete; feasibility
simulator green; Qwen4Exp rollback patch compile-checked. No model was loaded or
live server interrupted.

## Critical compatibility result

The available local/public DFlash2 checkpoint is for **Qwen3.8-27B**, not Flash
Next:

| Field | Existing DFlash2 target | Flash Next |
|---|---:|---:|
| Hidden width | 5120 | 2560 |
| Target layers | 64 | 48 |
| Feature taps | 6/20/34/48/62 (GGUF) | no trained taps |
| Architecture | dense Qwen3.8-27B | `qwen4exp` hybrid recurrent/MoE |

It cannot be attached. DFlash is target-feature-conditioned and shares target
embedding/LM-head semantics; a Flash-Next-specific drafter must be trained.

The live `:8099` server has no speculative flags and its DFlash counters are
zero. Current cumulative throughput (~8.29 tok/s) is not a controlled baseline.

The official Flash Next safetensors index does contain a one-layer native MTP
head, omitted from the local GGUF. Remote safetensors headers (range reads only)
show **4.856 GiB BF16** across 31 MTP tensors, dominated by 3.2-GiB gate/up and
1.6-GiB down expert banks. It is architecture-matched and useful as a native
MTP baseline/teacher, but it is not DFlash2: DFlash2 needs a separately trained
five-layer block-diffusion drafter plus selector/convolution weights.

## DFlash2 evidence

Official Qwen3.8-27B model card/blog:

- five-layer block-diffusion draft;
- block size 8, seven proposed tokens;
- top-16/rank-256 adjacent-candidate path selector;
- two-tap dynamic convolutions;
- mean accepted output per verification: 4.80;
- H200 single-stream speedup 2.67–3.43×;
- local/consumer llama evidence closer to ~1.8×.

DFlash2 amortizes one target verification across ~4–5 accepted output tokens.
It does not remove target-layer dependencies.

## Architecture that can reach 50 tok/s conditionally

```text
8 concurrent streams + matching DFlash2 engines
                  |
         7-token proposal block
                  v
 GPU1 L0-5 -> GPU2 L6-11 -> ... -> GPU8 L42-47
 complete local layers/experts per stage; no remote expert fan-out
                  |
         verify 8 positions in one sweep
                  |
          accept mean ~4.8 tokens
```

All eight cards form **one shared model**. “All eight at 50” means eight
simultaneous streams at ≥50 tok/s each (~400 aggregate), not eight independent
model replicas. Eight independent replicas would require roughly 64 cards.

### Memory

Local header inventory:

| Item | Size |
|---|---:|
| Target tensors | 103.688 GiB |
| PLE n-gram table | 26.85 GiB (system RAM service) |
| Remaining target / 8 GPUs | 9.60 GiB/stage |
| Estimated rollback+KV at 8 streams/8K | 1.06 GiB/stage |
| Remaining 16-GiB headroom | 5.34 GiB/stage |

Layer-aware packing is mandatory; equal layer counts are only the first cut.
Draft engines should use system RAM/iGPU or uneven target placement rather than
consume the remaining target VRAM blindly.

## Throughput condition

For acceptance `A`, draft latency `D`, stage compute `S`, adjacent one-way
latency `L`, eight stages/streams:

```text
block latency        = D + 8S + 7L
stage interval       = S + L
latency-limited tps  = A / block_latency
capacity/stream      = (A / stage_interval) / 8
per-stream tps       = min(the two)
```

At mean `A=4.8`, `D=10ms`, `L=0.25ms`, 50 tok/s requires:

```text
S <= 10.53 ms/stage (six real layers, width-8 block)
```

At MT-Bench-like `A=4.1`: `S <= 8.78 ms`.

## Executed simulator

```text
rack-best      block= 75.75ms stream=63.37 tok/s aggregate=581.8
rack-limit     block= 95.75ms stream=50.13 tok/s aggregate=446.5
metro-1ms      block= 81.00ms stream=59.26 tok/s aggregate=533.3
eu-8ms         block=130.00ms stream=36.92 tok/s aggregate=300.0
eu-10x-80ms    block=634.00ms stream= 6.82 tok/s aggregate=54.5
```

Therefore a way exists only if the 8 cards are one regional low-latency cell
and actual six-layer stage p99 is ≤9–10.5 ms. Pan-European stages cannot meet
the target; Europe routes whole requests among complete cells.

## Required runtime work

1. Train Flash-Next-specific DFlash2: hidden 2560, 48 target layers, target
   feature taps selected by experiment, block 8, selector/conv tensors. The
   upstream 4.856-GiB native MTP can provide a matched baseline/teacher but
   cannot be relabeled as DFlash2.
2. **Runtime port compiled:** SHA-pinned PR #27342 applies cleanly to local
   `dfa0c0f` and `llama-server` builds. Script:
   `sin-harness/patches/apply-dflash2-pr27342.sh`. No compatible weights yet.
3. Enable and validate Qwen4Exp recurrent rollback. Compile-checked patch:
   `sin-harness/patches/llama-qwen4exp-rs-rollback.patch`.
4. Build 8 contiguous compute-balanced stage manifests, complete expert banks
   local to each stage.
5. Use persistent FP16/FP8 stage frames; 8-position FP16 boundary payload is
   only ~40 KiB/stream, so latency—not bandwidth—is the gate.
6. Schedule at least 8 streams continuously; measure per-stream and aggregate
   separately.

## Iteration gates

1. **Compatibility:** reject any draft whose target architecture/hidden/layers/
   tokenizer/taps mismatch.
2. **Acceptance:** mean ≥4.8, p10 workload class ≥4.1.
3. **Draft:** p99 ≤10 ms for 8 streams.
4. **Stage:** p99 ≤8.8–10.5 ms depending on workload acceptance.
5. **Network:** adjacent one-way p99 ≤1 ms, preferably ≤0.25 ms.
6. **Memory:** ≤15 GiB steady/card, <16 GiB peak, no swap/page thrash.
7. **Correctness:** greedy target-only/spec output byte-identical; sampled mode
   passes distributional regression; forced rejection at positions 1–7 restores
   recurrent and attention state exactly.
8. **Service:** eight streams each median ≥50, p95 ≥45; aggregate ≥400.

If any gate fails, iterate block size 4/5/8, compute-balanced layer placement,
Q3 target quantization after quality certification, FP8 activations, fused
width-8 kernels, and draft placement. Do not solve a stage-time miss by moving
stages across WAN.
