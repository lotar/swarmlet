# Handoff: Swarmlet low-RAM release, physical two-Legion Qwen work, and parallel-execution speed goal

**Snapshot time:** 2026-09-02T07:44:05Z  
**Primary repository:** `/Users/lotar/projects/ai-mesh`  
**Primary repository HEAD:** `0abad8025772f8e3de43e7177bc8dc68b3bf3016`  
**llama.cpp source baseline:** `dfa0c0fee2b704fd2ac228d365d40502c3006c40`  
**Performance mission:** `252fa2f4-0d67-41ae-a3f1-940355a57b1b` — closed **failed**  
**Current verdict:** **NO-GO. No correctness-qualified Legion configuration beats the matched c4 M5-only control.**

This document is intended to be sufficient for a new agent with zero conversation context. It distinguishes measured hardware results from simulations and upper bounds, records every important dead end and operational trap, and gives copy-paste resume commands.

---

# STATE

## 1. Goal and pass/fail contract

The primary workload is four concurrent streams (`c4`). The matched local target-only control is:

```text
M5 target-only c4 aggregate goodput: 60.16240707139376 tok/s
required Legion result (+10%):       >66.17864777853314 tok/s
operational shorthand floor:         >66.18 tok/s
correctness:                          exact corresponding token IDs and content
per-stream p95 regression:            <=20%
persistent state changes:             none
```

The control comes from:

```text
/Users/lotar/projects/local-llm/models/qwen3.8-flash-next/mtp/
  full-matrix-20260829T085058Z/result.json
```

Verification command:

```bash
python3 - <<'PY'
import json
p='/Users/lotar/projects/local-llm/models/qwen3.8-flash-next/mtp/full-matrix-20260829T085058Z/result.json'
x=json.load(open(p))['target-c4']
print(x['aggregateTps'], x['perStreamMedianTps'], x['perStreamP95FloorTps'])
PY
```

Expected values:

```text
60.16240707139376 15.894614952564794 15.893822259010232
```

No tested Legion path satisfies the contract. The best remote-MTP integration screen that passed forced semantic checkpoint calibration reached `40.813359 tok/s`, 32.2% below the control; it was not compared against a matched target-only output arm and therefore is not strict A/B correctness qualification. The final staggered parallel-stage probe fails its predeclared p95 gate at `78.093 ms` versus `<58.7 ms`.

## 2. Production state

Production Qwen is owned by the LaunchAgent:

```text
label: com.lotar.llm-flashnext
port:  127.0.0.1:8099
health: ok
snapshot PID: 29571
```

The PID is dynamic and must never be assumed from this document. Re-check ownership with:

```bash
cd /Users/lotar/projects/ai-mesh
curl -sf --max-time 5 http://127.0.0.1:8099/health
sin-harness/scripts/flashnext-maintenance.sh check-only
```

At the snapshot, the output was:

```text
{"status":"ok"}
CHECK_OK
label=com.lotar.llm-flashnext loaded=yes launchPid=29571 listenerPids=29571 health=ok
```

Test ports were clean:

```text
50061 clean
52061 clean
52062 clean
```

Verification:

```bash
set -Eeuo pipefail
for p in 50061 52061 52062; do
  ! lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null
  echo "port $p clean"
done
```

Production lifecycle rules:

1. Use only `sin-harness/scripts/flashnext-maintenance.sh check-only|stop|start`.
2. Never use generic `pkill`, guessed PIDs, or an ad-hoc production restart.
3. Every heavy wrapper must install an EXIT/INT/TERM/HUP restoration trap before stopping production.
4. Exact workload PID, process start identity, port ownership, and tunnel ownership must be recorded.
5. Restoration is not complete until `check-only` and `/health` both pass.

## 3. Hardware state

### Legion 1

```text
SSH:       lotar@192.168.1.243
hostname:  lotar-legion
kernel:    7.0.0-30-generic
GPU:       NVIDIA GeForce GTX 1650 Ti
VRAM:      4096 MiB nominal; 3693 MiB reported free when idle
GPU driver: 580.173.02
RAM:       16275600 KiB
root disk: 501809635328 bytes total; 122472583168 used; 353771249664 available; 26%
ai-mesh:   clean at 0abad8025772f8e3de43e7177bc8dc68b3bf3016
```

Snapshot idle GPU state:

```text
14 MiB used, 3693 MiB free, 42–43 C
```

### Legion 2

```text
SSH:       lotar@192.168.1.220
hostname:  lotar-legion-2
kernel:    6.17.0-35-generic
GPU:       NVIDIA GeForce GTX 1650
VRAM:      4096 MiB nominal; 3709 MiB reported free when idle
GPU driver: 580.173.02
RAM:       15716060 KiB
root disk: 501809635328 bytes total; 242041401344 used; 254641651712 available; 49%
ai-mesh:   clean at 0abad8025772f8e3de43e7177bc8dc68b3bf3016
```

Snapshot idle GPU state:

```text
6 MiB used, 3709 MiB free, 40–41 C
```

The final physical probe recorded Legion 2 at `434796 KiB` swap used in `sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/safety.log`. It remained below the physical-run abort limit of `524288 KiB`.

### Remote security and lifecycle

- SSH is key-only.
- Password and root SSH login remain disabled.
- All custom workers bind `127.0.0.1` only.
- Access is through authenticated SSH local-forward tunnels.
- Do not expose the custom remote-MTP protocol directly on the LAN.
- The current protocol is bounded and attested but is not designed as a plaintext hostile-network protocol.

Current remote test-worker state was verified clean with:

```bash
set -Eeuo pipefail
for h in 192.168.1.243 192.168.1.220; do
  ssh -o BatchMode=yes -o ConnectTimeout=5 lotar@$h '
    set -Eeuo pipefail
    test -z "$(ps -eo comm= | grep "^llama-mtp-work" || true)"
    ! ss -ltn | grep -q ":50061 "
    nvidia-smi --query-gpu=memory.used,memory.free,temperature.gpu \
      --format=csv,noheader,nounits
  '
done
```

## 4. Model identity

### Target model

```text
name: Qwen3.8-Flash-Next-UD-Q4_K_XL
architecture: qwen4exp
parameters reported by verifier: 176943899520
loaded tensor bytes: 111323630080
trunk layers: 48
hidden input dimension: 2560
hidden output / MTP feature width: 10240
```

Entry shard:

```text
/Users/lotar/projects/local-llm/models/qwen3.8-flash-next/
  UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00005.gguf
```

Signed five-shard manifest SHA-256:

```text
cd920e8e8ffd3b297b0e287bcdb392ed2cc2833743ed5029862811b40a111a84
```

Manifest:

```text
sin-harness/data/two-legion-campaign-20260901T103204Z/
  trusted-model-identity/model-shards.sha256
```

Qwen evidence signer fingerprint:

```text
3963014966db113ff2060808bf1b0da0345835e3b62c68a8501e8993b590c969
```

### Native MTP Q4

Local path:

```text
/Users/lotar/projects/local-llm/models/qwen3.8-flash-next/mtp/
  Qwen3.8-Flash-Next-MTP-Q4_K_M.gguf
```

Remote path on both Legions:

```text
/home/lotar/models/qwen3.8-flash-next/mtp/
  Qwen3.8-Flash-Next-MTP-Q4_K_M.gguf
```

SHA-256 on all three machines:

```text
650b7bb3b9b53e662da85f0a529a3e89452f7bcac2e7133ba5c9c32b8b328d2a
```

Reported model properties:

```text
primary size:   2794430016 bytes
loaded tensors: 2783483392 bytes
parameters:     3878549248
nextn layers:   1
hidden width:   10240
```

## 5. Repository state and ownership warning

Main repository:

```text
/Users/lotar/projects/ai-mesh
HEAD 0abad8025772f8e3de43e7177bc8dc68b3bf3016
branch main
```

There are intentional, uncommitted changes from multiple concurrent efforts. At snapshot time:

```text
 M sin-harness/package.json
 M sin-harness/proofs/dflash-pipeline/README.md
 M sin-harness/proofs/qwen-flash-experts/README.md
 M sin-harness/proofs/qwen-flash-experts/external_poc.py
 M site/README.md
 M site/_headers
 M site/app.js
 M site/favicon.svg
 M site/index.html
 M site/og.png
 M site/og.svg
 M site/server.mjs
 M tools/site/shots.sh
?? api/
?? compose.site.prod.yml
?? deploy/
?? docs/HANDOFF_LEGION_PARALLEL_EXECUTION_20260902.md
?? docs/HANDOFF_LEGION_PARALLEL_EXECUTION_20260902.sha256
?? docs/PHYSICAL_SPLIT_MATRIX.md
?? sin-harness/proofs/dflash-pipeline/strict_ab_harness.py
?? sin-harness/proofs/dflash-pipeline/test_strict_ab_harness.py
?? sin-harness/proofs/qwen-flash-experts/physical_matrix.py
?? sin-harness/proofs/qwen-flash-experts/test_physical_matrix.py
?? tools/site/e2e.cjs
```

Do **not** reset, clean, stash, commit, or rewrite these paths as a group. Coordinate through the fleet bus before editing any existing dirty path:

```bash
/Users/lotar/projects/ai-fleet/bin/bus check \
  --harness pi \
  --session "$PI_SESSION_ID" \
  --cwd /Users/lotar/projects/ai-mesh \
  /absolute/path/to/file
```

This handoff document and its checksum sidecar are new:

```text
docs/HANDOFF_LEGION_PARALLEL_EXECUTION_20260902.md
docs/HANDOFF_LEGION_PARALLEL_EXECUTION_20260902.sha256
```

The sidecar authenticates the final document bytes and must be regenerated after any intentional edit.

## 6. Isolated worktrees

All performance implementation is uncommitted unless explicitly stated otherwise.

### ai-mesh strict harness

```text
/tmp/ai-mesh-legion-goal
HEAD 0abad8025772f8e3de43e7177bc8dc68b3bf3016
```

Dirty paths:

```text
M  sin-harness/package.json
M  sin-harness/proofs/dflash-pipeline/README.md
?? sin-harness/proofs/dflash-pipeline/strict_ab_harness.py
?? sin-harness/proofs/dflash-pipeline/test_strict_ab_harness.py
```

Those four changes were copied into the main repository and remain uncommitted there.

### Direct MTP worker microbenchmark

```text
/tmp/llama-mtp-worker-goal
HEAD dfa0c0fee2b704fd2ac228d365d40502c3006c40
```

Dirty paths:

```text
M  examples/CMakeLists.txt
?? examples/mtp-worker-bench/
?? examples/target-verify-bench/
```

### Original target rollback verifier

```text
/tmp/llama-target-verify-run
HEAD dfa0c0fee2b704fd2ac228d365d40502c3006c40
```

Dirty paths:

```text
M  examples/CMakeLists.txt
M  src/llama-arch.cpp
?? examples/target-verify-bench/
```

### n=3 accept-all capacity verifier

```text
/tmp/llama-target-capacity-run
HEAD dfa0c0fee2b704fd2ac228d365d40502c3006c40
```

Dirty paths are the target benchmark registration, Qwen4Exp architecture rollback declaration, and untracked benchmark source.

### n=1 accept-all capacity verifier and synchronized barrier

```text
/tmp/llama-target-n1-run
HEAD dfa0c0fee2b704fd2ac228d365d40502c3006c40
```

Dirty paths:

```text
M  examples/CMakeLists.txt
M  src/llama-arch.cpp
?? examples/target-verify-bench/
```

Important live source locations:

```text
/tmp/llama-target-n1-run/examples/target-verify-bench/target-verify-bench.cpp
  path_entry_exists():          line 573
  wait_for_measurement_barrier: line 625
  emitted p50/p95:              line 774
  emitted throughput:           line 783
  n_rs_seq setup:               line 845
  barrier immediately before measured loop: line 898
```

Current binary:

```text
/tmp/llama-target-n1-run/build/bin/llama-target-verify-bench
SHA-256 4f3c256272288166f0789e41bbb3061e1b603c29a5601c53dddcded91f4b1307
```

### Full direct-worker E2E integration and RTT stage probe

```text
/tmp/llama-remote-mtp-integration
HEAD dfa0c0fee2b704fd2ac228d365d40502c3006c40
```

Dirty paths:

```text
M  examples/CMakeLists.txt
M  src/llama-arch.cpp
M  src/llama-memory-hybrid.cpp
?? examples/remote-mtp/
```

Important source locations:

```text
examples/remote-mtp/remote-mtp-protocol.h
  MAX_SEQS / MAX_ROWS:           lines 43-44
  required F16 feature/digest:   lines 48-50
  F16 request encode/decode:     lines 301 and 319

examples/remote-mtp/llama-mtp-worker-server.cpp
  bounded persistent worker implementation

examples/remote-mtp/llama-remote-mtp-e2e-bench.cpp
  save_checkpoint():             line 405
  unsafe calibration skip:       lines 51, 134, 468
  semantic checkpoint compare:   line 519
  asynchronous worker launch:    line 588
  still-global serial cycle:      line 614
  partial rollback call:          line 707
  result mode declaration:        line 790

examples/remote-mtp/llama-mtp-rtt-client.cpp
  barrier publication/wait:       line 246
  stage benchmark:                line 316
  phase p50/p95 output:           line 367

src/llama-memory-hybrid.cpp
  seq_rm():                       line 196
  LID rollback result check:      line 202
  PLE rollback result check:      line 206
```

Current local build hashes:

```text
llama-mtp-rtt-client:
  ad36f13f78e541b8e99274bd65f3b13c586fe8e647856245ef1c26656664ec54
llama-mtp-worker-server (local macOS build):
  c9a915a3a0b9e4536419cb08f2f92c20b1c19c4ba7bb5ad8b761c5adef649180
llama-remote-mtp-e2e-bench:
  54aeeea64db208a991f60af74b0bd592e384222ab2669ca4980443c04ea8b679
```

The E2E binary dynamically loads libraries. Hashing only the executable is insufficient. Current relevant dylib hashes are:

```text
libllama.0.2.0.dylib:
  f3d43916feaa40a4d911e77ac4cd180b8b900f49f7d4e122dcd7aedd9f08b848
libllama-common.0.2.0.dylib:
  a61e4b65e493a79e40521990b43ec8094e9c19fb15dc4d739c37a2dca3d7f20f
libggml.0.21.0.dylib:
  a699e95a842676b8fb9a6864ef1a28e543d42f976fb1599b9708df52aad633a6
libggml-base.0.21.0.dylib:
  8f654493b42f9cf0d2584ad71b93efdc0202e2e93fc8797d64106e9dcc91fae0
libggml-cpu.0.21.0.dylib:
  6286bbf4a197d808cc25a67a39f095c491eef45829b098a50a5f67703a215321
libggml-blas.0.21.0.dylib:
  fdab05ffa47887724fb5918b0d4aa8fce4a71e04239efc6c3915aa8869217985
libggml-metal.0.21.0.dylib:
  b31fb9aa94eb7eea0c7b130d557e194eed7f8ac33d58dc44d27e37439d1433bd
```

Remote source trees on both Legions are based on `dfa0c0f` and intentionally dirty:

```text
M  examples/CMakeLists.txt
M  src/llama-arch.cpp
?? examples/remote-mtp/
```

Remote worker binary hashes differ because the two hosts were built separately:

```text
Legion 1: 7507585b837a9cbab307ddb00093d19caee276bba62d8960fd0c6d81f5eecabc
Legion 2: 6a55b2260783841e94806a7c673f3fc4ba27bd316211396cc52c0bfc3a9b17a1
```

Do not run `git clean`, `git reset --hard`, or remove these trees unless the experiment is explicitly abandoned and all evidence has been archived.

---

# DONE

## 7. Low-RAM/no-model toolchain

Commit:

```text
6527d28 Complete no-RAM toolchain: rollback oracle, cache, schemas, scheduler, planner, signed evidence
```

Delivered and verified:

1. Rollback oracle with byte-exact positions 0–6.
2. DFlash2 candidate/training schemas.
3. Crash-recoverable F16 feature cache.
4. Deterministic scheduler simulator.
5. GGUF partition planner.
6. Ed25519 artifact manifests and signer pinning.
7. Provenance/results grid.
8. LaunchAgent-safe operational runbook.
9. Unified `bun run test:no-ram-goal`.

Portable proof results included:

```text
rollback positions:       7
sequences:                8
checks:                   56
byteExact:                true
feature-cache format:     f16, version 1
signed manifest:          tamper/key-replacement/malformed rejection passed
model/docker start scope: none
```

These are algorithm and tooling proofs, not evidence that a 104-GB target model was distributed successfully.

## 8. Source-available release package

Release commit:

```text
0abad802 Prepare Swarmlet v1.0.0-alpha.1 source-available release
```

Artifacts:

```text
dist/swarmlet-1.0.0-alpha.1.tar.gz
  SHA-256 95aa3f7103b0f21de5c3aac799196991e116206db4383ed56113d5dd489a6cac

dist/swarmlet-1.0.0-alpha.1.sbom.json
  SHA-256 f55dde5cc0fe0bedca84a33151a03262b61697aa5278d5c4d7b4ed76f23bd617

dist/swarmlet-1.0.0-alpha.1.sha256
  SHA-256 7dff24e14908c87850af5013324245c0cfb955be1fe700b2f0b15ace308a70d2
```

Clean release gate was previously run locally and on both Legions:

```text
61 pass
0 fail
RELEASE_CHECK_OK version=1.0.0-alpha.1 portable=true model=false docker=false hardware=false
```

The logs were copied from `/tmp` into durable handoff evidence:

```text
sin-harness/data/release-v1.0.0-alpha.1/local-release-check.log
  SHA-256 7f6a33b4ff769ab63451b025089865e29d635d5f419d6f7a9336fc6c111fbbc7
sin-harness/data/release-v1.0.0-alpha.1/legion1-release-check.log
  SHA-256 48c46ca45416f560694815926f2832bd60e5e004ec4d1164f1747e47c224e545
sin-harness/data/release-v1.0.0-alpha.1/legion2-release-check.log
  SHA-256 3b894975df66def556f1bbf441571f60aaf75efd06290a91c46fbaa4263751af
sin-harness/data/release-v1.0.0-alpha.1/logs.sha256
```

License status:

- The project is source available under the Swarmlet Community License 1.0.
- It is not OSI Open Source.
- Personal/noncommercial use is free.
- Commercial use is free only while the entire Corporate Group has no more than EUR 1,000,000 worldwide gross annual revenue.
- Qualified software-licensing counsel has **not** approved the custom license.
- The public repository `github.com/lotar/swarmlet` does not exist; `git ls-remote https://github.com/lotar/swarmlet.git HEAD` returned `Repository not found`.
- There is no published/tagged public release.

## 9. Strict split A1/B/A2 harness

Added to the main working tree, but not committed:

```text
sin-harness/proofs/dflash-pipeline/strict_ab_harness.py
sin-harness/proofs/dflash-pipeline/test_strict_ab_harness.py
sin-harness/proofs/dflash-pipeline/README.md
sin-harness/package.json
```

Capabilities:

- fixed corpus and deterministic seeds;
- barrier-released concurrent requests;
- exact requested/generated token-count enforcement;
- no retries;
- raw malformed/HTTP-error evidence;
- immutable per-arm `arm.json` artifacts;
- payload SHA-256 and configuration fingerprints;
- separately acquired A1, B, A2 arms;
- offline-only comparison;
- exact corresponding token-ID and content parity;
- B/A1, B/A2, and B/arithmetic-mean-A ratios;
- A2/A1 drift gate;
- short-screen/final labels that do not alter the checks.

Fresh test at handoff creation:

```bash
cd /Users/lotar/projects/ai-mesh/sin-harness
bun run test:strict-ab-harness
```

Output:

```text
................
Ran 16 tests in 11.104s
OK
```

The apparent `RESULT_JSON` fail cases printed during the suite are intentional negative fixtures. The unittest suite itself passed.

**Known qualification gap:** the harness records `perStreamClientWall.p95Seconds`, but `_build_summary()` does not enforce the goal's `<=20%` per-stream p95 regression contract, and the compare CLI has no p95-regression option. It currently gates exact responses/parity, aggregate B ratio, A drift, and configuration fingerprint only. Add and test a p95 gate before using the harness for a qualifying physical claim; for example, require B per-stream p95 latency to be no more than `1.20 * arithmetic-mean(A1 p95, A2 p95)` under identical configuration.

A physical A1/B/A2 campaign was never acquired because every B candidate failed a predeclared cheap kill gate.

## 10. Tiny-MoE two-physical-host proof

The signed two-host tiny-MoE proof completed with exact parity, forced failure, supervised restart, cleanup, and clean-checkout signature.

```text
placement epoch:
  3824869874033c60c84bc95409f79507771501d92b1f752566c073f4f20cc75f
token hash:
  ff192265965a951708f0d18209f613fa81ace1bce02b9950a35df3f21828fa73
signer:
  566ef33b0bc2be8851a5f8ffe2b4772834d6f603d2cfc88425dfe135a5efb8b6
```

Evidence:

```text
sin-harness/data/two-legion-campaign-20260901T103204Z/tiny-moe/
```

This demonstrates protocol ownership/failure semantics for a tiny model. It is not evidence of frontier-model throughput.

## 11. One-Legion Qwen expert-bank generation

This scope places the complete layer-0 fused expert bank remotely. It is not a full remote target and not true per-expert distribution.

### Legion 1

Evidence:

```text
sin-harness/data/qwen-legion-e2e-20260901T074924Z/
sin-harness/data/qwen-legion-cuda-matrix-20260901T083747Z/
```

Physical results, 64 generated tokens, exact content hash:

```text
CPU RPC:                  21.19422386752197 tok/s
CUDA RPC:                 21.209807414948674 tok/s
CUDA gate/up + CPU down:  13.998077597343297 tok/s
content SHA-256:           881cb9ffe99af10d4380835a53a65a4bcd8c7ef34343774a9d409cc06d3203db
```

CUDA and hybrid token output matched the CPU baseline. GPU-only was effectively equal to CPU; the dependent CUDA+CPU split was 33.95% slower.

### Legion 2

Evidence:

```text
sin-harness/data/two-legion-campaign-20260901T103204Z/qwen-legion2-matrix/
```

Physical results:

```text
CPU RPC:                  21.300730817931157 tok/s
CUDA RPC:                 20.496256667790163 tok/s
CUDA gate/up + CPU down:  14.907520134025704 tok/s
content SHA-256:           881cb9ffe99af10d4380835a53a65a4bcd8c7ef34343774a9d409cc06d3203db
```

All three arms matched the sampled 64-token output. This is token/content parity, not complete logit parity.

## 12. Two-Legion dependent tensor-group placement

Physical placement:

```text
Legion 1 CUDA: gate and up projection, about 1025 MiB
Legion 2 CUDA: down projection, about 735 MiB
```

Result:

```text
throughput:       1.8888154482797659 tok/s
content SHA-256:  881cb9ffe99af10d4380835a53a65a4bcd8c7ef34343774a9d409cc06d3203db
```

Evidence:

```text
sin-harness/data/two-legion-campaign-20260901T103204Z/qwen-two-legion/
```

This is a correctness/capacity result and a severe performance regression. The two stages are dependent and execute serially; their rates cannot be added.

## 13. Root cause of cross-endpoint tensor-split regression

Short physical/source probes established:

```text
one Legion CUDA endpoint:       48.79 ms/token
same endpoint CUDA+CPU hybrid:  67.08 ms/token
two physical RPC endpoints:    529.43 ms/token
added two-endpoint latency:     462.35 ms/token
```

Source findings:

- scheduler splits execute serially in `ggml/src/ggml-backend.cpp`;
- direct `COPY_TENSOR` is available only when RPC devices share one socket;
- different endpoints fall back through Mac `GET_TENSOR` → host buffer → `SET_TENSOR`;
- RPC exposes no asynchronous copy hook;
- RTT amplification and host-staged synchronization dominate; raw bandwidth is not the main cause.

Read-only analyses:

```text
/tmp/two-legion-miniprobes/
/tmp/legion-goal-recon/
```

Network telemetry correction:

```text
sin-harness/data/two-legion-campaign-20260901T103204Z/
  NETWORK_TELEMETRY_CORRECTION.md
```

Fields named `networkRxDeltaBytes` and `networkTxDeltaBytes` in the signed campaign are actually packet-count deltas because the `/proc/net/dev` awk indexes were off by one. Do not interpret them as bytes. Throughput, token hashes, placement, GPU memory, and cleanup evidence are unaffected.

## 14. Local M5 target/MTP matrix

Evidence:

```text
/Users/lotar/projects/local-llm/models/qwen3.8-flash-next/mtp/
  full-matrix-20260829T085058Z/result.json
  full-matrix-20260829T090416Z/result.json
```

Measured values:

| Arm | True concurrency | Aggregate wall tok/s | Per-stream median tok/s | Exact-content parity count |
|---|---:|---:|---:|---:|
| target-only c1 rerun | 1 | 31.6194 | 33.2735 | n/a |
| Q8 n=3 c1 rerun | 1 | 39.2404 | 43.5103 | 1/1 |
| Q4 n=3 c1 rerun | 1 | 40.1646 | 43.7124 | 1/1 |
| target-only c4 | 4 | 60.1624 | 15.8946 | n/a |
| Q8 n=3 c4 | 4 | 38.7419 | 11.7998 | 2/4 |
| Q4 n=3 c4 | 4 | 38.5624 | 11.5964 | 1/4 |
| target-only c8 | 8 | 76.9400 | 10.3218 | n/a |
| Q8 n=3 c8 | 8 | 40.4497 | 5.8009 | 2/8 |
| Q4 n=3 c8 | 8 | 41.8238 | 6.0009 | 1/8 |

Do not call `43.7124` aggregate throughput. It is the one-stream response-reported median; measured wall aggregate was `40.1646` in that rerun.

The production workload remains c4, where target-only is much faster than local native MTP n=3.

## 15. Full CUDA residency of the Q4 MTP model

Physical Legion 2 fit canary:

```text
offloaded layers:      50/50
model buffer:          2651.41 MiB
compute buffer:         140.52 MiB
GPU allocation delta:  2808 MiB
GPU free after load:     846 MiB
GPU temperature:          46 C
```

Evidence:

```text
sin-harness/data/legion-goal/mtp-fit-l2-fullcuda-20260901T160945Z/
```

This is a load/reservation result only, not throughput.

## 16. Stock GGML RPC remote drafting

A stock remote-draft c4 short screen on Legion 2 produced:

```text
aggregate goodput:          12.076110583551362 tok/s
acceptance:                 69.377990430622%
draft proposals/s:           9.414610516520813
verification blocks/s:       3.1982648166171184
mean output/verification:    3.0422535211267605
```

Evidence:

```text
sin-harness/data/legion-goal/mtp-screen-b-l2-c4-20260901T162633Z/
```

This path is killed. GGML RPC turns a fast direct CUDA primitive into an approximately 9.4-proposal/s remote service.

## 17. Direct CUDA MTP capacity

Standalone direct-CUDA benchmark on Legion 2:

```text
n=3, two sequences:
  275.76 proposal tokens/s
   91.92 blocks/s
  measured round p50 21.714 ms
  measured round p95 22.040 ms
  exact/tolerance rollback replay passed

n=1:
  approximately 278 blocks/s
  p95 approximately 7.77 ms
```

Canonical n=3 evidence:

```text
sin-harness/data/legion-goal/mtp-direct-q4-20260901T173014Z/result.json
```

This proves the Legion CUDA compute primitive is fast. It does not include network, target verification, checkpointing, or generation acceptance.

Current direct-worker benchmark binary:

```text
/tmp/llama-mtp-worker-goal/build/bin/llama-mtp-worker-bench
SHA-256 07c59b36349175648d762cc6f472e47705b6be5340f54ea3878717a02f4be252
```

## 18. M5 target verifier capacity

### n=3 accept-all upper bound

```text
four streams
p50 batch:              213.829 ms
p95 batch:              217.003 ms
blocks/s:                18.65
verified tokens/s:       74.61
correctness:             false; accept-all capacity only
rollback:                not exercised
```

Evidence:

```text
sin-harness/data/legion-goal/target-accept-all-20260901T183745Z/result.json
```

This is insufficient for n=3 distributed drafting after realistic acceptance and overhead.

### n=1 accept-all upper bound

```text
four streams
p50 batch:               90.579 ms
p95 batch:               96.946 ms
blocks/s:                43.87
verified tokens/s:       87.74
correctness:             false; accept-all capacity only
rollback:                not exercised
```

Evidence:

```text
sin-harness/data/legion-goal/target-accept-all-n1-20260901T184154Z/result.json
```

This made n=1 the only plausible distributed-MTP shape.

## 19. Recurrent rollback failures

Low-level Qwen4Exp partial rollback did not preserve continuation semantics.

Observed failures included:

```text
failed to remove verification suffix for sequence 0
context did not allocate one recurrent-state snapshot per proposal
rollback determinism selected logit differs at index 0:
  first=-0.241289
  replay=-0.744321
  abs_diff=0.503032
```

Evidence:

```text
sin-harness/data/legion-goal/target-verify-final-20260901T182025Z/stderr.log
sin-harness/data/legion-goal/target-verify-diff-20260901T182214Z/stderr.log
```

`src/llama-memory-hybrid.cpp` originally checked the main recurrent-memory `seq_rm()` result but ignored failures from Lightning-Indexer and PLE recurrent memories. The isolated integration now checks and logs all sub-memory return values. All returned success in the final diagnostic, yet semantic continuation still differed, so the bug is deeper than ignored return codes.

Raw serialized checkpoint equality is not the semantic oracle. State size/position may match while raw encoding digests differ. Continuation token, selected logit, and returned hidden row are authoritative.

## 20. Direct two-Legion remote-MTP E2E

The isolated integration implemented:

- bounded little-endian protocol;
- exact handshake attestation;
- sequence affinity;
- message ordering and duplicate cache;
- `TCP_NODELAY` and socket timeouts;
- loopback-only listeners;
- worker catch-up rows;
- parallel requests to both workers;
- mixed one/two-row scheduling;
- forced reject patterns;
- per-sequence full checkpoints;
- continuation token/logit/hidden semantic probes.

Best semantic-calibration-passing remote-MTP E2E screen:

```text
benchmark:              remote-mtp-e2e-n1
good tokens:           32
goodput:                40.813359 tok/s
acceptance:             16/17 = 94.1176%
elapsed:                784057 us
semantic probes:        24
semantic size stable:   24/24
raw digest stable:      16/24 (not required for semantic validity)
checkpoint save:        33767 us total
target verify:         393152 us total
restore/replay:         37807 us total
cycles:                     5
worker 0 RTT total:    308423 us
worker 1 RTT total:    315641 us
```

Evidence:

```text
sin-harness/data/legion-goal/remote-mtp-e2e-semantic2-20260901T205037Z/
```

This is the best remote-MTP integration screen that passed its forced semantic checkpoint probes. It is **not** strict matched-output A/B qualification because no corresponding target-only arm used the same request/output corpus. It is below both the `60.16 tok/s` control and `66.18 tok/s` pass floor.

## 21. F16 wire plus n_rs_seq=1 partial rollback

Final attempted optimization:

- hidden rows encoded as little-endian IEEE binary16;
- proposal responses remain F32;
- target `n_rs_seq=1` partial rejection rollback;
- timed full checkpoint serialization removed;
- transport and partial-rollback metrics added.

Correctness failed before a valid performance result:

```text
rejected-lane partial rollback semantic checkpoint mismatch
sequence:        0
expected token:  15704
actual token:    1787
expected size:   118316944
actual size:     118316944
expected digest: de071e80f51539d8
actual digest:   a047b44cc1a096b4
```

Evidence:

```text
sin-harness/data/legion-goal/remote-mtp-e2e-f16-partial-20260901T210815Z/coordinator.log
sin-harness/data/legion-goal/remote-mtp-e2e-rollback-diagnose-20260901T211530Z/coordinator.log
```

An explicitly unsafe timing-only run skipped calibration and therefore cannot qualify:

```text
goodput:     25.572116 tok/s
acceptance:  50%
target verify total: 627186 us over 7 cycles
partial rollback total: 57 us
correctnessCalibration: skipped-unsafe
```

Evidence:

```text
sin-harness/data/legion-goal/remote-mtp-e2e-unsafe-speed-20260901T212346Z/
```

F16 halved the hidden-row payload but collapsed acceptance from 94.1% to 50%, erasing the transport advantage.

## 22. Synchronized staggered parallel-stage probe

### Hypothesis

Split c4 into two independent stream groups. In steady state, have the M5 verify one two-stream group while the two Legions draft the other group. The ideal phase time is:

```text
max(target verify-two time, concurrent Legion draft-two time) + correct commit cost
```

At 94.1176% n=1 acceptance, two proposal blocks yield approximately:

```text
2 * (1 + 0.941176) = 3.882352 useful tokens per phase
```

To exceed `66.18 tok/s`, the predeclared performance-stage gate was:

```text
phase p95 <58.7 ms
```

### Probe implementation

New experimental tools:

```text
/tmp/llama-remote-mtp-integration/examples/remote-mtp/llama-mtp-rtt-client.cpp
/tmp/llama-target-n1-run/examples/target-verify-bench/target-verify-bench.cpp
/tmp/run-staggered-phase-probe.sh
```

The target and RTT client each:

1. complete untimed warmups;
2. atomically publish separate ready files;
3. wait on one shared start file;
4. execute 100 measured rounds.

The remote RTT probe sent two F16 rows per worker:

```text
2 rows * 10240 elements * 2 bytes = 40960 hidden payload bytes
reported request bytes including framing: 41009 per worker per phase
```

This is deliberately labeled:

```text
two-f16-rows-payload-proxy-for-one-f32-row; not-f32
```

It is a conservative payload-size proxy for one F32 row. It does not prove F32 numerical equivalence. It also computes two rows rather than one; the measured compute p95 was only about 7 ms, while the failing tail was network RTT.

### Failed setup attempts before the valid run

#### Attempt 1: target barrier treated expected ENOENT as fatal

Evidence:

```text
sin-harness/data/legion-goal/staggered-phase-20260902T065326Z/
```

Error:

```text
cannot inspect target.ready: No such file or directory
```

Cause: `std::filesystem::symlink_status(path, ec)` returned `file_type::not_found` with `ec=ENOENT`; the target helper threw instead of returning false. The output directory was writable and the runtime binary hash matched, excluding permission and stale-binary hypotheses.

Fix in the isolated target benchmark:

```cpp
if (ec == std::errc::no_such_file_or_directory) return false;
```

That exact behavior was re-exercised by the later physical run.

Attempt 1 also exposed a bad Docker oracle: hashing complete `docker ps --format '{{json .}}'` output changes as uptime/status presentation changes. The final wrapper hashes stable container identity/image/name/running status and volume-name state instead.

#### Attempt 2: worker idle timeout while waiting for target load

Evidence:

```text
sin-harness/data/legion-goal/staggered-phase-20260902T070241Z/
```

Observed:

```text
worker ready: 2026-09-02 09:06:18 CEST
target ready: 2026-09-02 09:06:32 CEST
idle gap:     13.57 seconds
worker socket receive timeout: 10 seconds
client error: peer closed connection
```

The target still produced an unqualified stage result:

```text
target two-stream p95: 59.000 ms
blocks/s:               34.95
```

Fix: load the target to its ready barrier first, then connect and warm the remote client, then release both with the shared start file. No protocol timeout was weakened.

### Final valid physical stage result

Evidence directory:

```text
sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/
```

Authoritative result:

```text
status:                       fail-performance-stage
gate:                         <58.7 ms p95
target verify-two p50:         56.830 ms
target verify-two p95:         58.224 ms
target blocks/s:               35.08
target verified tokens/s:      70.16
concurrent worker phase p50:   22.187 ms
concurrent worker phase p95:   78.093 ms
overlapped lower-bound p95:    78.093 ms
```

Per-worker result:

```text
Legion 1 request RTT:
  p50 20.834 ms
  p95 77.947 ms
  compute p95 6.753 ms
  queue p95 0.406 ms

Legion 2 request RTT:
  p50 20.130 ms
  p95 25.044 ms
  compute p95 7.352 ms
  queue p95 0.286 ms
```

Failure margin:

```text
78.093 - 58.700 = 19.393 ms
33.04% above the phase p95 budget
```

The target itself has only:

```text
58.700 - 58.224 = 0.476 ms
```

of p95 budget left for an exact branch/commit operation.

At the previously observed 94.1176% acceptance, the target's mean-capacity projection is only:

```text
35.08 blocks/s * (1 + 0.941176) = approximately 68.10 good tok/s
```

That is only about 2.9% above the `66.18 tok/s` floor before correct commit/reject overhead. This projection is not a result and must not be presented as one.

Independent review verdict:

```text
performance-stage falsified; do not attempt branch/commit parity as qualification work
```

Reviewer session:

```text
/Users/lotar/.pi/agent/sessions/--Users-lotar-projects-ai-mesh--/
  2026-08-26T06-39-44-489Z_01a03ccb-cd69-7293-ae9b-aaae2d67ce01/
  f3ebaed5/run-0/session.jsonl
```

Final evidence SHA-256:

```text
result.json:
  15c9a9321fd94fdb78e63d2f0599b77bd85dbda14f0e899aa7532d9a56db20fe
target.json:
  695a45c0f2098134fa80b433462fb65c036b31dc9fd97ad25a5f4d517dda135c
worker-rtt.json:
  e16094c5d252d1e4e15d9b9935733d427ee3fa87067e303889042ec730d1812b
operator.sh:
  3b8c8f22e27d41d6dddcfc3fcf3c97d4b2af8540abc5b8b57628d2251ad74a03
```

Cleanup evidence:

```text
finalRc=2 localCleanup=0 workerCleanup=0 restored=true
```

`finalRc=2` is the expected performance-gate failure. It is not a cleanup failure.

Stable Docker and volume hashes matched before/after:

```text
Docker state:
  7ca587e69b92a55907ce188b59d70a466968289efbcbf8fbd65be3bbf8050bde
  before == after
Volume names:
  a1d100fae2c8dac2547c7cc12b0d678c295face750b0ca7f1e815113db715399
  before == after
```

Use the exact files rather than the abbreviated Docker hash above:

```bash
cmp \
  sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/docker-before.sha256 \
  sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/docker-after.sha256
cmp \
  sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/volumes-before.sha256 \
  sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/volumes-after.sha256
```

## 23. Legion 2 storage recovery

Historical cleanup, not part of the final staggered probe:

```text
initial filesystem: 409 GiB used / 35 GiB available / 93%
after log/cache cleanup: 216 GiB used / 248 GiB available / 47%
containerd before targeted cleanup: 130533265408 bytes
containerd after targeted cleanup:  107051708416 bytes
reduction:                       23481556992 bytes / 21.87 GiB
```

Actions completed:

- preserved diagnostic hashes before truncation;
- removed stale 84.24-GB `auth.log` and 81.12-GB `syslog` contents safely;
- removed `/swapfile2`, caches, traces, and disabled snaps;
- vacuumed journal;
- reduced ext4 reserved blocks;
- removed stopped Engram containers without volumes;
- removed five Engram custom images;
- removed selected zero-container images and dangling chains;
- preserved all 47 Docker volumes;
- preserved Traefik and Alfred;
- did not manually delete containerd metadata.

Cleanup dossier on Legion 2:

```text
/home/lotar/containerd-cleanup-20260901T100342Z/
```

BuildKit historically still reported:

```text
Total:       80.66 GB
Reclaimable: 80.66 GB
Private:     77.28 GB
```

Most was protected by leases. Manual lease deletion, manual `/var/lib/containerd` deletion, and volume pruning remain prohibited.

The current root filesystem changed after later unrelated workloads and was 49% used at handoff. Do not treat the historical 47% as current.

---

# NOT-DONE

## 24. Performance and correctness

1. **No meaningful Legion speed addition exists.** Best semantic-calibration-passing remote-MTP screen is `40.813359 tok/s`, below the `60.1624` local control and `66.18` floor; it is not strict matched-output A/B qualification.
2. **Staggered c4 pipeline is not qualified.** The final physical worker phase p95 is `78.093 ms`, above the `<58.7 ms` gate.
3. **Exact F32 one-row remote RTT is not measured.** The final stage probe uses an explicitly labeled two-F16-row byte-volume proxy. Current protocol source encodes request hidden rows as F16 at `remote-mtp-protocol.h:301/319`.
4. **Correct branch/commit target state is not implemented or tested.** The existing integration still mutates the live target sequence and uses invalid partial rollback or expensive serialized checkpoints.
5. **Qwen4Exp `n_rs_seq=1` partial rollback is semantically wrong.** Expected continuation token `15704`; actual `1787`.
6. **Full recurrent/KV/logit byte attestation is incomplete.** Continuation semantic probes exist, but a complete target-state attestation does not.
7. **Strict physical c4 A1/B/A2 was never acquired.** B failed every short screen, so the predeclared workflow stopped before expensive A/B/A.
8. **The strict harness does not yet enforce the declared `<=20%` per-stream p95 regression gate.** It records p95 values but compare can pass without checking them. Add the p95 comparison and negative/positive tests before any qualifying A1/B/A2 campaign.
9. **No full event-driven staggered coordinator exists.** The current `cycle()` waits for all workers before target verification.
10. **No trained Flash-Next DFlash2 weights exist.** Simulator and schemas are complete; production weights are not.
11. **Eight-node 50 tok/s remains a conditional projection, not a result.**

## 25. Promotion and source control

1. All llama.cpp benchmark/integration changes remain uncommitted in `/tmp` worktrees.
2. Strict A/B/A harness changes remain uncommitted in the main ai-mesh working tree.
3. The final stage-probe wrapper exists at `/tmp/run-staggered-phase-probe.sh` and in the immutable final evidence directory, but is not maintained production code.
4. The main working tree contains unrelated site/API/deployment changes. No performance commit should include those paths.
5. Remote llama integration trees are intentionally dirty and should not be called clean provenance.

## 26. Release/legal/publication

1. Qualified counsel has not reviewed the custom Swarmlet Community License.
2. `github.com/lotar/swarmlet` does not exist.
3. No public push or signed `v1.0.0-alpha.1` tag exists.
4. Do not describe the project as Open Source or OSI-approved.

---

# RESUME

## 27. First commands for every successor

Run these before changing or launching anything:

```bash
set -Eeuo pipefail
cd /Users/lotar/projects/ai-mesh

git rev-parse HEAD
git status --short

curl -sf --max-time 5 http://127.0.0.1:8099/health
sin-harness/scripts/flashnext-maintenance.sh check-only

for p in 50061 52061 52062; do
  ! lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null
  echo "port $p clean"
done

for h in 192.168.1.243 192.168.1.220; do
  ssh -o BatchMode=yes -o ConnectTimeout=5 lotar@$h '
    set -Eeuo pipefail
    test -z "$(ps -eo comm= | grep "^llama-mtp-work" || true)"
    ! ss -ltn | grep -q ":50061 "
    nvidia-smi --query-gpu=name,memory.used,memory.free,temperature.gpu \
      --format=csv,noheader,nounits
  '
done
```

Expected repository HEAD:

```text
0abad8025772f8e3de43e7177bc8dc68b3bf3016
```

Expected health:

```text
{"status":"ok"}
CHECK_OK
```

Do not continue if production ownership is ambiguous, a test listener exists, a remote test worker exists, or a heavy peer run is active.

## 28. Verify the final failure without loading a model

```bash
cd /Users/lotar/projects/ai-mesh
OUT=sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z
python3 - "$OUT" <<'PY'
import json,sys
p=sys.argv[1]
r=json.load(open(p+'/result.json'))
t=json.load(open(p+'/target.json'))
w=json.load(open(p+'/worker-rtt.json'))
assert r['status']=='fail-performance-stage'
assert r['targetVerifyTwoStreamP95Ms']==58.224
assert r['workerConcurrentPhaseP95Ms']==78.093
assert r['overlappedLowerBoundP95Ms']==78.093
assert r['checks']['targetTwoStreamP95'] is True
assert r['checks']['workerPayloadProxyP95'] is False
assert t['barrier']['start_file']==w['barrier']['startFile']
print(r)
PY

cmp "$OUT/docker-before.sha256" "$OUT/docker-after.sha256"
cmp "$OUT/volumes-before.sha256" "$OUT/volumes-after.sha256"
cat "$OUT/final-state.txt"
cat "$OUT/restore-check.log"
```

## 29. Recommended technical decision

With unchanged Wi-Fi/network and model architecture, stop. The performance prerequisite failed before branch/commit correctness work.

The next physical experiment is justified only after a material change, for example:

1. Legion 1 moved to wired Ethernet;
2. the Legion 1 SSH route demonstrably has lower p95 jitter;
3. Legion 1 removed from the critical path and a different independent-work schedule defined;
4. trained standalone DFlash2 weights become available;
5. enough RAM/hardware is added for complete target replicas.

Changing only coordinator code does not remove the observed `77.947 ms` Legion 1 request-RTT p95.

## 30. Exact rerun command after a real network/hardware change

This command stops production temporarily and loads the 104-GB target. Coordinate with all peers first.

```bash
set -Eeuo pipefail
cd /Users/lotar/projects/ai-mesh
SOURCE_OPERATOR=/Users/lotar/projects/ai-mesh/sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/operator.sh
test "$(shasum -a256 "$SOURCE_OPERATOR" | awk '{print $1}')" = 3b8c8f22e27d41d6dddcfc3fcf3c97d4b2af8540abc5b8b57628d2251ad74a03
OUT="/Users/lotar/projects/ai-mesh/sin-harness/data/legion-goal/staggered-phase-rerun-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
cp "$SOURCE_OPERATOR" "$OUT/operator.sh"
chmod 700 "$OUT/operator.sh"
OUT="$OUT" "$OUT/operator.sh" >"$OUT/console.log" 2>&1
```

The wrapper hard-pins:

```text
Legion IPs and users
model-set manifest SHA
local target and RTT-client binary SHA
per-Legion worker binary SHA
remote MTP model SHA
loopback-only worker ports
SSH tunnel ports
resource limits
global deadline
exact cleanup/restoration
stable Docker and volume state oracles
```

A result is only a stage pass if:

```text
result.json status == pass-performance-stage
targetVerifyTwoStreamP95Ms < 58.7
workerConcurrentPhaseP95Ms < 58.7
both barriers enabled
shared start file equal
target shape == seqs 2, proposals 1
worker shape == two rows per worker
cleanup == zero
production restored and healthy
Docker/volume hashes unchanged
```

Even a stage pass is not an E2E win.

## 31. If and only if the stage gate passes

Implement exact speculative target branching in:

```text
/tmp/llama-remote-mtp-integration/examples/remote-mtp/
  llama-remote-mtp-e2e-bench.cpp
```

Start reading at:

```text
save_checkpoint():                    line 405
compare_checkpoints_semantically():   line 519
launch_workers():                     line 588
cycle():                              line 614
partial rollback:                     line 707
```

Required design:

1. Two logical groups: streams 0/1 and streams 2/3.
2. Per-stream state machine rather than one global cycle barrier.
3. Verify one group on the M5 while the other group drafts remotely.
4. Keep a committed target sequence untouched.
5. Fork verification into a speculative sequence using proven `seq_cp`/`seq_keep`/`seq_rm` semantics or an equivalent exact shadow context.
6. On accept, commit by logical sequence-ID swap without serializing 118 MB.
7. On reject, discard speculative state and advance the untouched committed state.
8. Compare continuation token, selected logit, and hidden row against a full-checkpoint oracle.
9. Keep F32 hidden rows unless a quantized format independently preserves acceptance.
10. Do not use raw state digest equality as the semantic oracle.

Build commands after implementation:

```bash
cmake --build /tmp/llama-remote-mtp-build \
  --target llama-mtp-worker-server llama-remote-mtp-e2e-bench llama-mtp-rtt-client \
  -j4

/tmp/llama-remote-mtp-build/bin/llama-remote-mtp-e2e-bench \
  --protocol-self-test
/tmp/llama-remote-mtp-build/bin/llama-remote-mtp-e2e-bench \
  --no-model-smoke
/tmp/llama-remote-mtp-build/bin/llama-mtp-rtt-client \
  --protocol-self-test
/tmp/llama-remote-mtp-build/bin/llama-mtp-rtt-client \
  --no-model-smoke
```

The current E2E binary accepts `--unsafe-skip-calibration`. Never use that flag for qualification.

## 32. Strict c4 A1/B/A2 only after a valid B screen and p95-gate implementation

**Do not use the current compare result as qualification until `strict_ab_harness.py` enforces the declared `<=20%` per-stream p95 regression.** Add the p95 comparison and tests first. The commands below cover acquisition and the existing gates only.

Start and stop the exact required server separately for every arm. The 104-GB target-only and draft-enabled servers cannot coexist.

```bash
cd /Users/lotar/projects/ai-mesh

python3 sin-harness/proofs/dflash-pipeline/strict_ab_harness.py acquire \
  --arm A1 --url http://127.0.0.1:8095 \
  --out /tmp/flashnext-c4-a1 \
  --concurrency 4 --tokens 128 --warmup-waves 1 --measured-waves 3

python3 sin-harness/proofs/dflash-pipeline/strict_ab_harness.py acquire \
  --arm B --url http://127.0.0.1:8095 \
  --out /tmp/flashnext-c4-b \
  --concurrency 4 --tokens 128 --warmup-waves 1 --measured-waves 3

python3 sin-harness/proofs/dflash-pipeline/strict_ab_harness.py acquire \
  --arm A2 --url http://127.0.0.1:8095 \
  --out /tmp/flashnext-c4-a2 \
  --concurrency 4 --tokens 128 --warmup-waves 1 --measured-waves 3

python3 sin-harness/proofs/dflash-pipeline/strict_ab_harness.py compare \
  --a1-artifact /tmp/flashnext-c4-a1/arm.json \
  --b-artifact /tmp/flashnext-c4-b/arm.json \
  --a2-artifact /tmp/flashnext-c4-a2/arm.json \
  --out /tmp/flashnext-c4-final \
  --min-b-ratio 1.10 \
  --max-a-drift-pct 5 \
  --screen-label final
```

These acquisition commands are runnable only while the corresponding server is deliberately running on `127.0.0.1:8095`. The strict client never starts a model server.

## 33. Promotion procedure

Do not copy all uncommitted worktree changes wholesale.

1. Coordinate file ownership through the fleet bus.
2. Review each isolated diff against `dfa0c0f`.
3. Promote only code belonging to a validated result.
4. Do not promote `--unsafe-skip-calibration` as a production path.
5. Include dynamic-library hashes or use static linkage for reproducible coordinator attestation.
6. Add maintained tests before committing.
7. Exclude unrelated `site/`, `tools/site/`, `api/`, `deploy/`, and compose changes.
8. Run full `bun run test` and llama protocol/no-model builds after the final edit.
9. Run independent review before any new physical campaign.

---

# GOTCHAS

## 34. Operational traps already paid for

### Remote `nohup ... &` can hang SSH

The committed physical tiny-MoE runner used a remote background-launch pattern that did not return over SSH. The working operational pattern was:

```text
setsid -f bash -c 'record exact PID; exec worker ...'
```

Always record PID, `/proc/$pid/stat` start time, exact command line, listener ownership, and run directory.

### Do not hash only a dynamic executable

The remote-MTP coordinator links `libllama`, `libllama-common`, and GGML dylibs through `@rpath`. A source/library change may leave the executable hash unchanged. Hash the complete runtime dependency set or link statically.

### Target barrier ENOENT

`std::filesystem::symlink_status(path, ec)` on a missing path produced `ec=ENOENT` on this machine. Missing ready files are expected, not fatal. The helper must explicitly return false for `std::errc::no_such_file_or_directory` while still treating dangling symlinks as existing stale entries.

### Worker idle timeout versus target load

Do not connect and finish worker warmup before loading the target. The target takes approximately 13–17 seconds to load; worker socket receive timeout is 10 seconds. Load target to its barrier first, then connect/warm workers, then release both.

### Dynamic Docker output is not a stable state oracle

Do not hash complete `docker ps --format '{{json .}}'` output because uptime/status presentation changes. Do not hash unsorted `Mounts` arrays because Docker inspect can return semantically identical mounts in nondeterministic order. Stable identity/image/name/running status plus separately sorted volume names worked for the final probe.

### Network fields labeled bytes are packet counts

See `NETWORK_TELEMETRY_CORRECTION.md`. Never quote those fields as bytes.

### Raw checkpoint bytes are not semantic equality

Checkpoint size and position can match while raw digests differ. Probe continuation token, selected logit, and hidden row.

### Qwen4Exp partial rollback currently lies by position

`seq_rm()` can return true and leave the expected position while continuation semantics are wrong. Position checks are necessary but insufficient.

### F16 transport is not a free optimization

F16 cut request size but acceptance dropped from 94.1% to 50% in the integration. Keep precision effects separate from transport timing.

### Accept-all target verifier is not correctness

Every `target-accept-all*` result says:

```text
correctness: false
end_to_end: false
rollback: not_exercised
```

It is a capacity upper bound only.

### The stage RTT probe is a proxy

Two F16 rows per worker match the hidden payload byte volume of one F32 row. This does not establish F32 numerical behavior. It does expose the physical RTT tail because compute p95 was about 7 ms and worker 0 RTT p95 was 77.947 ms.

### Aggregate and per-stream throughput differ

Do not report response-reported per-stream median as aggregate wall throughput. Example: Q4 n=3 true c1 rerun reports 43.7124 per-stream median but 40.1646 wall aggregate.

### B-only is never A/B/A

A successful short B screen would only justify acquiring A1/B/A2. It is not itself a speed claim.

### Simulations are not measurements

Scheduler scenario outputs, DFlash2 projections, K3/eight-node math, and accept-all capacities must be labeled simulation or upper bound. Never combine them arithmetically with independent physical rates as though all stages run simultaneously.

### Dependent stage rates never add

Gate/up → down and per-layer tensor placements are dependency ordered. Their rates compose serially. Rates add only for independent requests or independent replicas.

### Protect persistent state

Never:

- prune Docker volumes;
- manually delete `/var/lib/containerd`;
- delete containerd leases by hand;
- use generic process killers;
- bind custom workers to LAN interfaces;
- reset shared dirty working trees.

---

# OPEN QUESTIONS

## 35. Can a wired Legion 1 meet the p95 phase gate?

Current answer: unknown; Wi-Fi/SSH worker 0 p95 is `77.947 ms`.

Resolving check after physically changing the network:

```bash
set -Eeuo pipefail
cd /Users/lotar/projects/ai-mesh
SOURCE_OPERATOR=/Users/lotar/projects/ai-mesh/sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/operator.sh
test "$(shasum -a256 "$SOURCE_OPERATOR" | awk '{print $1}')" = 3b8c8f22e27d41d6dddcfc3fcf3c97d4b2af8540abc5b8b57628d2251ad74a03
OUT="/Users/lotar/projects/ai-mesh/sin-harness/data/legion-goal/staggered-phase-wired-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"
cp "$SOURCE_OPERATOR" "$OUT/operator.sh"
chmod 700 "$OUT/operator.sh"
OUT="$OUT" "$OUT/operator.sh" >"$OUT/console.log" 2>&1
python3 -m json.tool "$OUT/result.json"
```

Required observation to reopen the branch:

```text
workerConcurrentPhaseP95Ms <58.7
```

## 36. Can exact target branch/commit fit the remaining p95 budget?

Current answer: unknown and not implemented. The target stage leaves only `0.476 ms` against the predeclared phase gate.

Check proving the current implementation is absent and still uses checkpoint/partial rollback:

```bash
rg -n 'save_checkpoint|restore_checkpoint|llama_memory_seq_rm|seq_cp|seq_keep' \
  /tmp/llama-remote-mtp-integration/examples/remote-mtp/llama-remote-mtp-e2e-bench.cpp
```

The resolving experiment must be a new exact semantic branch benchmark. It must compare committed versus speculative continuation token/logit/hidden values and emit branch/commit p50/p95. No current executable provides that check.

## 37. Can exact F32 one-row transport pass where the payload proxy failed?

Current answer: unmeasured. It is unlikely to erase a 19.393-ms failure because proxy compute p95 is only about 7 ms and the failure is Legion 1 RTT tail.

Check proving current wire format:

```bash
rg -n 'FEATURE_HIDDEN_F16_LE|w\.f16|r\.f16|PROTOCOL_DIGEST' \
  /tmp/llama-remote-mtp-integration/examples/remote-mtp/remote-mtp-protocol.h
```

A resolving physical check requires adding a separately attested F32 protocol mode and running the same synchronized stage wrapper. Do not relabel the existing F16 proxy.

## 38. Can a trained standalone draft make the remote work independent?

Current answer: no suitable Flash-Next DFlash2 weights exist.

Inventory check:

```bash
find /Users/lotar/projects/local-llm/models/qwen3.8-flash-next \
  -type f \( -iname '*dflash*' -o -iname '*draft*' \) -print
```

A trained independent draft capable of multi-token run-ahead would remove the per-token target-hidden barrier. Until such weights exist and are evaluated, this remains design work, not a result.

## 39. Would complete target replicas make throughput truly additive?

Yes in architecture: route independent requests to complete replicas and sum service throughput. No on current hardware: each Legion has about 16 GB RAM and 4 GB VRAM, far below the roughly 104-GiB target model set.

Capacity check:

```bash
for h in 192.168.1.243 192.168.1.220; do
  ssh lotar@$h 'free -b; nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits'
done
```

This becomes viable only with materially larger RAM/storage/accelerator capacity or a much smaller target that changes the product/model contract.

## 40. Can more containerd space be reclaimed safely on Legion 2?

Current answer: BuildKit historically reported 80.66 GB reclaimable, but lease protection blocked ordinary cleanup. Current exact containerd byte size was not re-established at handoff because unprivileged `du` is unreliable.

Safe checks:

```bash
ssh lotar@192.168.1.220 '
  docker system df -v
  docker builder du
  docker volume ls
  docker ps -a
'
```

Do not resolve this by manual metadata deletion or volume pruning.

## 41. Can the alpha release be published?

Current answer: technically packaged, legally blocked.

Checks:

```bash
cd /Users/lotar/projects/ai-mesh
sin-harness/scripts/release-check.sh
git ls-remote https://github.com/lotar/swarmlet.git HEAD
```

Publication requires qualified license review, creation of the public repository, an intentional clean release commit, and a signed tag. Do not push the shared dirty working tree.

---

# Evidence index

## 42. Primary physical evidence

```text
sin-harness/data/qwen-legion-e2e-20260901T074924Z/
sin-harness/data/qwen-legion-cuda-matrix-20260901T083747Z/
sin-harness/data/two-legion-campaign-20260901T103204Z/
sin-harness/data/legion-goal/mtp-fit-l2-fullcuda-20260901T160945Z/
sin-harness/data/legion-goal/mtp-screen-b-l2-c4-20260901T162633Z/
sin-harness/data/legion-goal/mtp-direct-q4-20260901T173014Z/
sin-harness/data/legion-goal/target-accept-all-20260901T183745Z/
sin-harness/data/legion-goal/target-accept-all-n1-20260901T184154Z/
sin-harness/data/legion-goal/remote-mtp-e2e-semantic2-20260901T205037Z/
sin-harness/data/legion-goal/remote-mtp-e2e-f16-partial-20260901T210815Z/
sin-harness/data/legion-goal/remote-mtp-e2e-rollback-diagnose-20260901T211530Z/
sin-harness/data/legion-goal/remote-mtp-e2e-unsafe-speed-20260901T212346Z/
sin-harness/data/legion-goal/staggered-phase-20260902T065326Z/
sin-harness/data/legion-goal/staggered-phase-20260902T070241Z/
sin-harness/data/legion-goal/staggered-phase-final-20260902T071035Z/
```

Campaign directory contains 192 files and was approximately 6.8 MiB at handoff. `sin-harness/data/legion-goal` was approximately 4.3 MiB.

## 43. Design/source reviews

```text
/tmp/legion-goal-recon/adversarial-feasibility.md
/tmp/legion-goal-recon/architecture-choice.md
/tmp/legion-goal-recon/benchmark-contract.md
/tmp/legion-goal-recon/coordinator-correctness.md
/tmp/legion-goal-recon/direct-worker-seam.md
/tmp/legion-goal-recon/integration-kill-review.md
/tmp/legion-goal-recon/legion-fit.md
/tmp/legion-goal-recon/live-safety-performance.md
/tmp/legion-goal-recon/llama-draft-rpc.md
/tmp/legion-goal-recon/mtp-assets.md
/tmp/legion-goal-recon/mtp-capacity-decision.md
/tmp/legion-goal-recon/mtp-quant-design.md
/tmp/legion-goal-recon/protocol-review.md
/tmp/legion-goal-recon/remote-mtp-protocol.md
/tmp/legion-goal-recon/server-integration-seam.md
/tmp/legion-goal-recon/strict-harness-final-review.md

/tmp/two-legion-miniprobes/subagent-concurrency-capacity.md
/tmp/two-legion-miniprobes/subagent-critical-path-math.md
/tmp/two-legion-miniprobes/subagent-cuda-utilization.md
/tmp/two-legion-miniprobes/subagent-evidence-timeline.md
/tmp/two-legion-miniprobes/subagent-llama-rpc-source.md
/tmp/two-legion-miniprobes/subagent-minimal-experiments.md
/tmp/two-legion-miniprobes/subagent-network-latency.md
/tmp/two-legion-miniprobes/subagent-parallel-architecture.md
/tmp/two-legion-miniprobes/subagent-qwen-dependencies.md
/tmp/two-legion-miniprobes/subagent-skeptic-60.md
```

## 44. Final one-line conclusion

On the current M5 + two 16-GB/4-GB-VRAM Legions and current SSH/Wi-Fi paths, dependent tensor splitting is serial and catastrophically slow, stock RPC drafting is slow, direct MTP compute is fast but end-to-end barriers/verification/rollback dominate, F16 destroys acceptance, partial recurrent rollback is semantically wrong, and the best staggered independent-stage design misses its p95 budget because Legion 1 has a 77.947-ms RTT tail while the M5 verifier itself leaves only 0.476 ms for exact commit work. Do not claim additive speedup from this system without new physical evidence after a material network, hardware, or draft-model change.
