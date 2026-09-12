# Flash-Next as a whole-model mesh replica on the M5: refused by the fit gate (2026-09-12, 12:34 to 13:00)

Request: "update mesh to serve full model from m5, remeasure."

Result: NOT delivered. The mesh can now plan and launch a whole-model replica of
`qwen3.8-flash-next` on the Mac node (`30f05a2670c368d0`, Apple M5 Max, 128 GiB), and the
node agent stops the standalone production server for it the same way it does for a split
coordinator. The launch was refused twice by the agent's own memory fit gate: after
production was stopped, only 66143 MiB and then 68612 MiB of RAM were free plus
reclaimable, and the whole model needs 79232 MiB. The other tenants on the Mac (Docker
Desktop VM 28 GiB with 44 containers running, about 33 GiB of applications, swap 22.4 of
23.5 GB in use) leave too little. The agent restored production each time. Nothing on the
Mac was killed to make room; that is the owner's decision (options at the end).

State at 13:00: production `127.0.0.1:8099` healthy and serving Flash-Next (router picks
`flashnext-prod`, `dep-ce2358418a7d`); the split `flashnext-mesh` (`dep-0867eec8aa93`) is
stopped and was not restarted (see "Why the split stays stopped"); the new replica
`flashnext-m5` (`dep-19fb57bca9a0`) exists in state `stopped`, ready to be started once
memory allows; `win-2b-cpu` on the laptop unchanged and ready.

## What changed in the mesh (commit 407b9c2, live on the controller)

Before this change `control/deployments.ts startReplica` sent no `fitMiB` (except with
fleet allocations) and never a `stopExternal`. A plain replica of Flash-Next on the Mac
would therefore have launched with no memory check while production held about 100 GB,
loading a second copy of the model. Now, on darwin:

- `fitMiB` = `profile.layers x layerMiB + coordinatorHostMiB` (48 x 1608 + 2048 = 79232 MiB
  for Flash-Next), unless a fleet allocation already budgets the node.
- `stopExternal` = the name of the external deployment registered on the replica's own
  node when the spec says `stopExternal: true` (here `flashnext-prod`), so the agent may
  stop it through its maintenance script and restores it when the replica stops or fails.
- `protocol/types.ts`: `ReplicaAssignment.stopExternal` documented. The agent already
  read that field at runtime in `fitGate` and its replica validator accepts extra keys, so
  no node release was needed (nodes stay on 2026091109).
- Test: `control/test/recovery.test.ts` "darwin replica carries the whole-model fit gate
  and, on request, the production server it may stop". `bun run typecheck` clean; full
  `bun test` 398 pass, 1 fail in `node-agent/test/enforce-rss.test.ts` (a 6.5 s real-process
  timing test on a host at load about 39; it passes alone in 5.4 s; unrelated to this change).

Controller redeployed from `releases/407b9c2` on the-shop (`swarmlet-control:407b9c2`,
recreated 12:47 local, 10:47 UTC). All four nodes reconnected within 40 s; `win-2b-cpu` stayed
ready. The idle gate read 0 requests processing and 0 in flight before the restart.

## Timeline (local time, UTC+2)

| Time | Event |
|---|---|
| 12:44 | Split `dep-0867eec8aa93` stopped. Agent restored production; `/health` 200 at 12:44:07. |
| 12:44:46 | Same-day production baseline measured on 8099 (table below). |
| 12:47 | Controller switched to `407b9c2`; 4 nodes online, plan preview for the replica accepted (79232 of 117996 MiB offered). |
| 12:48:12 | `flashnext-m5` created (`kind replica`, `replicaNodeId` Mac, ctx 262144, parallel 4, chain 0, `stopExternal true`) and started. |
| 12:48:27 | Agent: "stopping external flashnext-prod via maintenance script". 8099 gone. |
| 12:51:15 | Agent: "does not fit even after stopping flashnext-prod: 66143 MiB free, need 79232" (180 s poll window). Production restore started, healthy 12:52:07. |
| 12:52 to 12:55 | Controller automatic recovery attempt 2 repeated the cycle: 8099 stopped again, refused with 68612 MiB free, restore started 12:55:12. |
| 12:55:37 | `POST /api/deployments/dep-19fb57bca9a0/stop` issued to clear the running intent before attempt 3 of 5. |
| 12:57:41 | Replica `stopped`, production `/health` 200 (restored 12:57:30). No swarmlet engine process left on the Mac. |

## Memory picture of the M5 during the attempt

- Machine: 131072 MiB RAM. Mesh offer on this node: 117996 MiB RAM, 98304 MiB Metal,
  reserve 12288 MiB.
- Model files behind `~/.swarmlet/models` symlinks: shards 1 to 4 (Metal weights) 78745 MiB,
  shard 5 (hashed n-gram PLE table, kept on CPU by `-ot ple_ngram_embd=CPU`) 26.8 GiB,
  MTP head 3.9 GiB (unused, chain 0). Total 103.7 GiB on disk.
- Planner requirement: 48 x 1608 + 2048 = 79232 MiB. This covers the Metal weights and a
  2 GiB host part; it does not include KV cache (production at ctx 262144 x 4 slots sat at
  about 100 GB wired on 2026-09-11).
- Gate formula (`node-agent/probe/darwin.ts reclaimableMiB`): free + inactive + speculative
  + purgeable pages from `vm_stat`. Active and wired pages are not counted.
- Observed with production stopped: 66143 MiB (attempt 1) and 68612 MiB (attempt 2) at the
  end of the 180 s window. Shortfall 10.6 to 12.8 GiB before any KV cache.
- Who holds the rest (top -o mem, 12:51): `com.apple.Virtualization` (Docker Desktop VM,
  configured `MemoryMiB 28672`, 44 containers running, most of them hud-swebench lanes)
  28 GB; ZCode Helper 2.9 GB; com.docker.backend 1.9 GB; Chrome helpers 1.6 + 0.8 GB;
  `stable` 1.6 GB; WindowServer 1.2 GB; Cursor 1.0 GB; Telegram 0.9 GB; claude.exe 0.8 GB.
  `vm.swapusage`: 23552 MB total, 22372 MB used.
- Production fits only because it has no gate: macOS pushes the other tenants into
  compression and swap. The mesh gate exists to stop the mesh from doing the same to an
  owner's machine, so the refusal is the gate working as designed, not a fault.

## Measurements

Same prompts, same script (`/tmp/fn-measure.py`), temperature 0, non-streaming, engine
`timings` from the response. Production measured today at 12:44:46 directly on 8099 (its
own engine `llama.cpp-pr27739`, `--jinja`, thinking on, ctx 262144, 4 slots, `--kv-unified`).
Split numbers are from 2026-09-11 (`docs/reports/FLASHNEXT_SPLIT_LIVE_20260911.md`). The
M5 replica could not be measured.

| Case | Production 8099 (today) | Split, 1 layer per Legion (09-11) | M5 replica |
|---|---|---|---|
| short prompt, 46 to 64 gen tokens | 2.0 to 2.6 s wall; prompt 86 to 104 tok/s; decode 29.3 to 31.5 tok/s | decode 5.5 tok/s; prompt 13.6 tok/s | not measured (refused) |
| 2450 to 2490 token prompt, 64 gen | 5.9 and 7.1 s wall; prompt 658 and 696 tok/s; decode 29.5 and 19.9 tok/s | prompts above 1024 tokens rejected (ctx 1024) | not measured |
| 256 gen tokens | 9.8 s wall; decode 27.8 tok/s | not measured | not measured |

Raw rows: `/tmp/fn-measure-prod-8099.json`, log `/tmp/fn-measure-prod-8099.log`.

## Why the split stays stopped

Since it went live at 18:55 on 2026-09-11 the split coordinator on the Mac died 11 times
with SIGABRT (agent log 19:39, 19:40, 22:59, 23:29, 05:27, 06:39, 10:04, 10:22, 10:29,
10:39, 11:26 local). Each time the controller logged "reconnect cleanup pending" then
"deployment failed" and its automatic recovery restarted the split. The trigger is a
WebSocket drop on any of the three nodes ("1006 Connection ended", roughly hourly through
Cloudflare); the relay ring loses a worker, llama-server aborts. Every cycle bounced
production: the agent restored 8099 (3 to 5 min), the restarted coordinator stopped it
again. The agent log holds 14 "external service restored" events between 18:48 on 09-11
and 12:58 today: 11 from the crashes, 1 from stopping the split, 2 from the replica attempts.
With the whole-model replica refused, restarting the split would only bring the flapping
back, so production on 8099 is the interim Flash-Next path. Restart if wanted:
`POST /api/deployments/dep-0867eec8aa93/start`.

## Options for the owner

1. Free at least 13 GiB on the M5 while the replica loads (Docker Desktop VM is the single
   largest tenant at 28 GiB; lowering its limit needs a Docker Desktop restart and touches
   the lanes running those 44 containers), then `POST /api/deployments/dep-19fb57bca9a0/start`.
   The gate stops production, loads the whole model on Metal, and restores production when
   the replica is stopped. Expect roughly the same decode speed as production (same
   hardware, single node, no relay), with the recipe differences below.
2. Relax the gate for this replica (for example an operator `fitMiB` override in the spec).
   Not recommended: the true footprint with a production-size context is about 100 GB, so
   passing the gate at 79232 MiB would still push 25 GiB or more of other work into swap.
3. Keep production on 8099 as the Flash-Next path (current state). Nothing else to do.

Recipe differences that would remain after option 1 (profile `flash-next-ud-q4kxl`
`extraArgs`, shared with the split): no `--jinja`, no `--reasoning-format auto`, no
`--chat-template-kwargs enable_thinking`, no `--kv-unified`, `--cache-ram 0`; default
sampler instead of production's temp 1.0 / top-p 0.95 / top-k 20; no `--mmproj`.

## Follow-ups (not done, out of scope)

- Controller recovery retries a deterministic fit refusal up to 5 times (backoff capped at
  60 s). With `stopExternal` each retry stops and restores production (3 to 5 min outage per
  attempt). A "does not fit" failure should end the running intent or back off for much
  longer. Stopped manually here after attempt 2.
- Planner message "Requested replica node ... has its offer disabled" appears when the
  node's RAM is fully reserved by another deployment (hit again in the new unit test); the
  wording is misleading (also noted in `docs/reports/FLASHNEXT_SPLIT_LIVE_20260911.md`).
- Split resilience: a single WebSocket drop on any node kills the ring; a reconnect grace
  on the coordinator's RPC connections would avoid the production bounce.
- `node-agent/test/enforce-rss.test.ts` is timing sensitive under host load.

## Bus

Claim to `codex:01a070be` (`m_b70f055a`), outage notices to `pi:01a09067` (`m_052a3fc3`) and
`pi:01a0906c` (`m_ca9115ff`) before the work; release and final state notice after.
