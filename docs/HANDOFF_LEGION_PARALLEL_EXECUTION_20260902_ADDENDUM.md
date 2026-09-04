# Addendum: Legion Wi-Fi mesh, measured end to end with exact target state

**Date:** 2026-09-02, 09:00 to 15:06 UTC  
**Repository:** `/Users/lotar/projects/ai-mesh` at `0abad8025772f8e3de43e7177bc8dc68b3bf3016`  
**Supersedes the reasoning in** `docs/HANDOFF_LEGION_PARALLEL_EXECUTION_20260902.md` sections 21, 22, 24 and 29.  
**Verdict:** The mesh's Wi-Fi stage is fixed and passes the handoff's predeclared gate. Remote MTP n=1 with exact fork/commit target state works end to end at 79.3 % acceptance with the network fully hidden. It still delivers less c4 throughput than the M5 alone, and the measured cost structure shows why no speculative scheme on this MoE at c4 can clear the +10 % contract: the M5's 4-token step is fixed-cost dominated, so speculation's ceiling is +13 % at zero RTT and turns negative with any RTT or any batch split.

---

## 1. Gaps in the handoff, each with evidence

1. **Wrong root cause for the Legion 1 RTT tail.** The 77.9 ms p95 was NetworkManager Wi-Fi power save (`wifi.powersave = 3`, iwlwifi) on both Legions, not link capacity. A userland UDP keepalive every 50 ms (no root) removes it. The recommendation "move Legion 1 to wired Ethernet" was unnecessary.

   | ICMP M5 to Legion, 100 pings | p50 | p95 | over 20 ms |
   |---|---|---|---|
   | idle, no keepalive | 8.5 ms | 107 ms | 44 |
   | 50 ms keepalive | 6.8 ms | 10.5 ms | 1 |

2. **The stage gate passes.** Rerun of the handoff's own pinned binaries, protocol and shape (`llama-mtp-rtt-client`, two F16 rows per worker):

   | Configuration | phase p50 | phase p95 | gate < 58.7 ms |
   |---|---|---|---|
   | handoff final `staggered-phase-final-20260902T071035Z` | 22.2 ms | 78.1 ms | FAIL |
   | keepalive 50 ms, 2 rows/worker | 27.1 ms | 35.8 ms | PASS |
   | keepalive 50 ms, 1 row/worker | 19.9 ms | 28.1 ms | PASS |
   | aes128-gcm SSH cipher | no change | no change | PASS |

   Evidence: `sin-harness/data/legion-goal/wifi-keepalive-stage-20260902T092445Z/`, `sin-harness/data/legion-goal/wifi-keepalive-stage2-20260902T115519Z/`.

3. **"F16 collapses acceptance to 50 %" was confounded.** That 50 % came from the run with the semantically broken `n_rs_seq=1` partial rollback. With exact target state and the same F16 wire, Legion drafts are accepted 79.3 % of the time (288 of 363, identical in both Legion arms). The handoff's 94.1 % was 16 of 17 proposals.

4. **The "best" 40.8 tok/s remote screen was 5 cycles in 0.78 s.** Not a measurement.

5. **Exact target state was declared unimplemented.** It now exists: per-stream committed and speculative sequences, `seq_cp` copy-on-write in the recurrent memory and metadata-only in the unified KV, seq-id swap on accept, `seq_rm` plus a two-token replay entry on reject, no partial rollback, no checkpoint serialization. Stream 0 stays token-exact for 192 tokens through every fork, commit, discard and replay in every arm; repeated target-only arms are bitwise reproducible (A2 and A3 equal A1 on all four streams).

6. **Exact parity with target-only is unattainable for any batched verifier on this backend.** Streams 1 to 3 flip a greedy choice at positions that depend on batch composition (stream 1 flips at index 57 in three arms and never in the fourth). llama-server's own MTP mode showed the same in the handoff's section 14 matrix (1 of 4 and 2 of 4 streams identical). The correct correctness criterion is self-consistency of the accept/reject rule, which the fork/commit design guarantees by construction.

7. **The NO-GO was right for the wrong reason.** With the network fixed and hidden, the mesh still loses. See section 3.

8. **Production is degraded by memory pressure.** A c4 probe against the live server measured 46.1 tok/s against its 60.16 control, with 33.6 swap-ins and 38.6 file page-ins per generated token. The Docker Desktop VM reserves 28 GB (`MemoryMiB 28672`, physical footprint 28.1 GB) while its 24 containers use 8.2 GB. Lowering the reservation to about 12 GB is the largest single speed gain available on the M5.

## 2. End-to-end results

Bench: `llama-remote-mtp-fork-bench` v2 (source copied into each evidence directory), one model load, fresh context per arm, arms interleaved with target-only controls, greedy, 4 streams, 192 tokens per stream, kv_unified, n_seq_max 12.

Window `sin-harness/data/legion-goal/fork-e2e-20260902T150312Z/` (clean A1 and A2; A3 flagged by a CPU spike from another process):

| Arm | Design | tok/s | verify p50 | worker wait p50 | Legion RTT p50 (w0 / w1) |
|---|---|---|---|---|---|
| A1 | target-only, 4 tokens per batch | 65.75 | 58.3 ms | | |
| B2 | Legion MTP n=1, two groups, 4 tokens per batch | 54.15 | 53.4 ms | 0.0 ms | 23.6 / 18.7 ms |
| A2 | target-only | 66.99 | 57.8 ms | | |
| B1 | Legion MTP n=1, one group, 8 tokens per batch | 51.35 | 77.6 ms | 33.8 ms | 35.4 / 25.8 ms |
| O2 | oracle drafts, two groups | 44.08 | 59.5 ms | 0.0 ms | |
| A3 | target-only (contaminated) | 54.28 | 69.7 ms | | |

Contract: handoff control 60.16 tok/s, floor 66.18; in-bench control mean of A1 and A2 66.37 tok/s. Every mesh arm is below both. Per-stream p95 time per token: B2 89 ms, B1 96 ms, A 72 ms.

Earlier window `fork-e2e-20260902T144124Z/` (v1, one process per arm) reproduced the same acceptance and the same worker wait but all arms after A1 were contaminated by Spotlight indexing and 55 GB per-arm model re-reads; it is kept as evidence of the contamination mechanism, not as a speed result.

## 3. Why the mesh cannot win at c4 on this model, measured

- 4-token verify batch: 53 to 58 ms whether it is 4 streams by 1 token or 2 streams by 2 tokens. 8-token batch: 78 ms. Fixed cost about 38 ms, marginal about 5 ms per token.
- Target-only already yields 4 useful tokens per 58 ms step.
- Two groups (B2) hide the network completely but halve the streams per batch: 3.08 useful tokens per 55.6 ms step.
- One group (B1) keeps 8-token batches but the draft for the next step depends on the hidden state of this step, so the 26 to 35 ms round trip is serial: 5.85 useful tokens per 118 ms.
- Zero-RTT bound for one group: 5.85 tokens per 78 ms = 75 tok/s, +13 % over the in-bench control. Wired Ethernet at 2 ms would give roughly +8 %. Chained multi-token drafts decay from the measured 79 % single-step acceptance and do not change the picture.
- Any approach that needs the target's hidden state per step has this dependency. The Legions add throughput only for workloads where the M5 cannot batch, which c4 on a 512-expert MoE is not.
- The same MTP head drafted on the M5 itself (Metal, same worker binary, loopback) costs 2.4 ms compute per row: phase 3.4 ms for one row per worker, 5.8 ms for two rows per worker, against 19 to 35 ms for the Legion round trip. Evidence: `sin-harness/data/legion-goal/local-mtp-loopback-20260902T151633Z/`. Drafting locally is 6 to 10 times cheaper in wall time than any Wi-Fi round trip, so the Legions cannot beat local drafting for this model even with the network fixed.

## 3a. The speed increase that is reachable: local MTP n=1 on the M5

Predicted from the measured pieces (8-token verify 78 ms, local draft about 5 ms, acceptance 79 %): about 71 tok/s at c4, +18 % over the 60.16 llama-server control and +7 % over the in-bench target-only. The handoff only ever measured local MTP with n=3 (16-token verifies, which lose at c4). The direct production-relevant test is llama-server on the :8095 test lane with 4 slots, `MTP=<Q4 or Q8 head> SPECN=1`, measured by `benchmark_concurrency.py` at c4 against a target-only arm, the same client that produced the 60.16 control. Operator prepared at `<evidence-dir>/local-mtp-operator.sh` (arms target, q4-n1, q8-n1, q4-n2, target2); its launch requires a production-stop window that the auto-mode classifier refused in this session:

```bash
bash /private/tmp/claude-501/-Users-lotar-projects-ai-mesh/e4943658-3266-45f8-b527-06d3b4c3f1d2/scratchpad/local-mtp-operator.sh
```

Note from the handoff's own server logs: with `--parallel 4 --kv-unified` llama-server prints "QSA needs per-sequence streams -> running DENSE attention"; production runs dense attention today.

## 3b. Mesh speed that did increase, end to end, via Wi-Fi

Every request that crosses the mesh's Wi-Fi gets faster with the keepalive, in both directions, reversibly (measured on, then off, then on again; `sin-harness/data/legion-goal/mesh-e2e-latency-20260902T152013Z/`):

| Path | keepalive off | keepalive on | gain |
|---|---|---|---|
| M5 to Legion 2 Traefik HTTP, 100 sequential requests, p50 | 88.6 ms | 15.2 to 17.1 ms | 5.2 to 5.8× |
| same, p95 | 99.3 ms | 22.3 to 23.2 ms | 4.3× |
| Legion 2 to M5 production LLM, 8-token completion via SSH tunnel, p50 | 416.3 ms | 334.0 to 341.6 ms | 1.22 to 1.25× |
| same, p95 | 418.4 ms | 345.7 to 374.5 ms | 1.12 to 1.21× |

This is the mesh traffic that exists today (fleet calls into Legion-hosted services, Legion-side clients calling the M5 LLM), not the drafting experiment. The keepalive works with or without a UDP sink on the M5 (HTTP p50 15.0 ms with the sink killed). It currently runs as a detached process on each Legion (`/home/lotar/wifi-keepalive.py`, pid in `/home/lotar/wifi-keepalive.pid`) and will not survive a Legion reboot; the session's attempt to add a `@reboot` user crontab line was refused by the auto-mode classifier. To make it durable, on each Legion:

```bash
( crontab -l 2>/dev/null | grep -v wifi-keepalive; echo '@reboot sleep 20; /usr/bin/python3 /home/lotar/wifi-keepalive.py 192.168.1.53 52099 0.05 >/dev/null 2>&1' ) | crontab -
```

The proper fix is NetworkManager `wifi.powersave = 2` for the connection (needs sudo, which these accounts do not have without a password).

## 4. Operational traps added to the handoff's list

- Worker sockets have a 10 s receive timeout by default; any arm that idles the workers longer than that (a target-only control arm) kills the session with "peer closed connection". Start workers with `--timeout-ms 900000`; the client keeps 10 s.
- `llama_context` reserves `n_seq_max` output slots at construction; `n_outputs_max` must be at least `n_seq_max` or `output_reserve` asserts.
- `memory_pressure` free percentage is useless right after an arm exits; reclaimable page cache counts as not free. Judge contamination by swap delta and by interleaved controls.
- Spotlight (`mds`, `mdworker_share`) and a 28 GB Docker VM each turned a 66 tok/s control into 37 to 54 tok/s during the day.
- The auto-mode classifier refuses to stop production; the operator had to be launched after explicit user direction.

## 5. Reproduce

```bash
# workers need the long idle timeout (already in remote-worker-start.sh copies in the evidence dirs)
BSHA=$(shasum -a256 /tmp/llama-remote-mtp-build/bin/llama-remote-mtp-fork-bench | awk '{print $1}')
BSHA=$BSHA ARMS=A,B2,A,B1,O2,A TOKENS=192 bash <evidence-dir>/fork-e2e-operator.sh
python3 <evidence-dir>/fork-e2e-compare.py <new-out-dir>
```

Source of record: `/tmp/llama-remote-mtp-integration/examples/remote-mtp/llama-remote-mtp-fork-bench.cpp` (uncommitted worktree on llama.cpp `dfa0c0f`), binary SHA-256 `48e370f66fcf94296f2b36868fe3a12d28acc33a34281b4baae0f2e13ff17ae5`. Keepalive: `/home/lotar/wifi-keepalive.py` on both Legions, 50 ms interval to a UDP sink on the M5.
