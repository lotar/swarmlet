# Flash-Next as a whole-model mesh replica on the M5 (2026-09-12)

Request: "update mesh to serve full model from m5, remeasure." Then, after the first
attempt was refused: "gracefully stop docker containers, then quit docker desktop / stop
the engine and retry."

## Outcome after the retry (14:10)

DELIVERED. `qwen3.8-flash-next` is served by the mesh as a whole-model replica on the Mac
node, deployment `flashnext-m5-64k` (`dep-5a6b848b63d0`, ctx 65536, 4 slots), ready since
13:54:02. The standalone production server on `127.0.0.1:8099` is stopped by the agent's
maintenance script while the replica runs and comes back when the deployment is stopped.
Docker Desktop is down (43 containers stopped cleanly, none removed). Measured against the
same-day production baseline, the replica is faster on every case: decode 30 to 36 tok/s
against 28 to 31, prompt 866 to 874 tok/s against 658 to 696 on the 2.5k-token prompts,
256 generated tokens in 7.5 s against 9.8 s. From the Windows laptop through its own agent
and the hosted router: 200 in 1.84 s, `x-swarmlet-deployment dep-5a6b848b63d0`, decode 35.4
tok/s (the same probe took 3.2 s through the production tunnel and 8.05 s through the split).

Two things the owner should know:

- The first retry ran the replica at production's context (262144 x 4). It loaded and served
  (decode 18 to 27 tok/s) but wired 108.4 GB and drove swap to 75 of 77 GB with 8% system
  memory free and pageouts climbing. I stopped it after the measurement rather than leave
  the host near out-of-memory, and reran at ctx 65536, which covers the p99 prompt (about
  36k tokens) seen on the production lane. The replica recipe keeps its KV cache at f16 with
  no `--kv-unified`, where production quantizes it, so a full-context mesh replica needs the
  recipe change listed under follow-ups, not just more free memory.
- Docker Desktop must stay down while the replica serves. Its VM (28 GiB) was the tenant
  that made the fit gate refuse in the morning. To bring it back: stop the deployment
  (`POST /api/deployments/dep-5a6b848b63d0/stop`, production restores itself), open Docker
  Desktop, then `docker start $(cat /tmp/docker-running-before-20260912.txt)`.

## Retry timeline (local time, UTC+2)

| Time | Event |
|---|---|
| 13:10 | Bus notice to all lanes (`m_018923f8`): all containers stop in 60 s, Docker Desktop quits. Three acks, no objection; the hud-swebench lane paused its Docker steps. |
| 13:11:37 | `docker stop -t 30` on all 43 containers. 10 exited 0 (all eight Postgres instances, redis, theshop-db), 5 exited 1, 22 `inspect` sleepers hit the 30 s grace and exited 137, 1 exited 43. Names saved to `/tmp/docker-running-before-20260912.txt`. |
| 13:13:13 | `gbrain-postgres` had been restarted by the `com.fleet.gbrain-heal` launchd job (`docker start`, policy `unless-stopped`); stopped again. The heal script does not launch Docker Desktop, it only logs errors while the daemon is down. |
| 13:13:14 | `osascript quit app "Docker Desktop"`; backend, virtualization and UI processes gone by 13:13:35; `docker info` fails. Only `com.docker.vmnetd` (privileged helper) remains. |
| 13:13:55 | Memory with production still loaded: free plus reclaimable 10071 MiB, wired 96.3 GB, swap 34.3 of 39.9 GB. |
| 13:14:16 | Bus notice #4; `POST /api/deployments/dep-19fb57bca9a0/start` (ctx 262144 x 4). Agent stopped production, gate passed, `llama-server` spawned 13:16:29. |
| 13:20:37 | Replica ready on port 8100. Wired 108.4 GB, swap 73.3 of 73.7 GB, free plus reclaimable 5373 MiB. |
| 13:22:55 | Measured through `127.0.0.1:47800` (table below, column "M5 replica, ctx 262144"). |
| 13:24:42 | `memory_pressure`: system-wide free 8%, `kern.memorystatus_level 8`, swap 75.2 of 76.8 GB and still growing. Decision: stop, rerun smaller. |
| 13:25:06 | `POST .../dep-19fb57bca9a0/stop`; bus notice #5. Engine exited 13:25:20, production restore started. |
| 13:32:51 | Production restored (7.5 min: the 77 GB reload ran while swap drained; swap peaked at 97.7 GB used). Deployment `stopped`, 8099 `/health` 200. |
| 13:33:14 | `flashnext-m5-64k` created (`dep-5a6b848b63d0`: replica, Mac, ctx 65536, parallel 4, `stopExternal true`). Create only registers the deployment (`planned`, no plan); I missed the explicit start and lost 20 minutes. |
| 13:53:45 | `POST .../dep-5a6b848b63d0/start`. Production stopped, gate passed, ready 13:54:02 (10 s: the model pages were still in the file cache). |
| 13:54:21 | First 64k measurement: decode 8 to 21 tok/s, unstable. Cause found: an MLX job from the `webwright` lane (pid 48242, 40 GB unified memory, "fused vs chunked at L=8192 in the FULL model", started 13:31) shared the M5 GPU. Not mine; bus notice #6 (`m_c2b7bdb0`), waited. |
| 14:07:33 | MLX job exited. System free 25%, swap 17 GB. |
| 14:08:14 | Clean 64k measurement (table below). Wired 98.5 GB, swap 16.3 GB, free plus reclaimable 22687 MiB. |
| 14:09:16 | Windows laptop probe through its agent and the hosted router: 200, 1.84 s, `dep-5a6b848b63d0`, node `30f05a2670c368d0`. |

## Remeasure

Same six prompts, same script (`/tmp/fn-measure.py`), temperature 0, non-streaming, engine
`timings` from the response. Production measured at 12:44:46 directly on 8099 with Docker
running. Replica rows measured through the Mac agent (`127.0.0.1:47800/v1`, route `local`).
Both engines answer with reasoning first, so the 64-token cases spend their budget on
`reasoning_content` and return an empty `content`; that is identical across columns.

| Case | Production 8099, ctx 262144 (12:44) | M5 replica, ctx 262144 (13:23, swap 73 GB) | M5 replica, ctx 65536 (13:54, MLX job on GPU) | M5 replica, ctx 65536 (14:08, clean) |
|---|---|---|---|---|
| short-1 (46 gen) | 29.8 tok/s decode, prompt 104 | 18.9, prompt 87 | 20.8, prompt 94 | 33.0, prompt 43 |
| short-2 (47 gen) | 29.3, prompt 95 | 22.1, prompt 189 | 15.6, prompt 243 | 34.4, prompt 269 |
| short-3 (64 gen) | 31.5, prompt 86 | 20.9, prompt 234 | 11.6, prompt 252 | 34.5, prompt 261 |
| long-1 (2492 prompt, 64 gen) | 29.5, prompt 658, wall 5.9 s | 22.9, prompt 498, wall 7.9 s | 9.2, prompt 766, wall 10.3 s | 32.8, prompt 866, wall 4.8 s |
| long-2 (2532 prompt, 64 gen) | 19.9, prompt 696, wall 7.1 s | 27.1, prompt 566, wall 6.8 s | 15.2, prompt 805, wall 7.5 s | 30.3, prompt 874, wall 5.0 s |
| gen-256 | 27.8, wall 9.8 s | 17.8, wall 14.7 s | 8.2, wall 32.0 s | 35.7, wall 7.5 s |

Raw rows: `/tmp/fn-measure-prod-8099.json`, `/tmp/fn-measure-m5-replica-47800.json`,
`/tmp/fn-measure-m5-replica-64k-47800.json`, `/tmp/fn-measure-m5-replica-64k-clean.json`.
The clean 64k column is the number to quote; the two middle columns show what memory
pressure and a concurrent Metal job do to the same engine.

## Memory footprint, measured

| State | Wired | Swap used | Free plus reclaimable | System free |
|---|---|---|---|---|
| Production loaded, Docker running (13:09) | 96.5 GB | 26.9 of 28.0 GB | 7.8 GiB | |
| Production loaded, Docker down (13:13) | 96.3 GB | 34.3 of 39.9 GB | 9.8 GiB | |
| Replica ctx 262144, Docker down (13:23) | 108.4 GB | 73.3 of 73.7 GB | 5.2 GiB | 8% |
| Replica ctx 65536, MLX job running (13:54) | 101.5 GB | 32.0 of 32.8 GB | 6.8 GiB | 10% |
| Replica ctx 65536, clean (14:08) | 98.5 GB | 16.3 of 17.4 GB | 22.2 GiB | 25% |

Engine flags that explain the gap. Production (`local-llm/bin/serve-flashnext.sh`):
`--kv-unified`, `--cache-type-k/v` quantized, `--flash-attn on`, `--jinja`,
`--chat-template-kwargs enable_thinking`, `--reasoning-format auto`, `--cache-ram` prompt
cache, `--predict 32768`, temp 1.0 / top-p 0.95 / top-k 20. Replica (recipe
`node-agent/roles/recipes.ts replicaArgv`): `-ngl 999 --device MTL0 -ot ple_ngram_embd=CPU
-fa on --cache-ram 0 --ctx-checkpoints 0 -t 10 -tb 10`, f16 KV cache, no `--jinja`. Without
`--jinja` the server rejects requests that carry `tools`.

## History: the first attempt (12:34 to 13:00) was refused by the fit gate

The mesh can now plan and launch a whole-model replica of
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

The owner chose option 1 in its strongest form (stop every container, quit Docker Desktop).
The retry above is the result.

## Operating notes and reversal

- Serving now: `flashnext-m5-64k` (`dep-5a6b848b63d0`) on the Mac, port 8100, reached through
  `https://app.swarmlet.ai/v1` (needs an API key) or `http://127.0.0.1:47800/v1` on the Mac
  (no key). `flashnext-prod` shows `loading` (its 8099 target is down) and gets no traffic.
- `flashnext-m5` (`dep-19fb57bca9a0`, ctx 262144) is kept in state `stopped` for the record.
  Do not start it while Docker or any other 20 GB tenant is up; at that context it wired
  108 GB and filled swap.
- Restore production 8099: `POST /api/deployments/dep-5a6b848b63d0/stop`. The agent runs the
  maintenance script; the reload took 52 s, 2.3 min and 7.5 min today depending on swap.
- Bring Docker back: stop the replica first (its VM plus the replica do not fit), open
  Docker Desktop, then `docker start $(cat /tmp/docker-running-before-20260912.txt)`. The
  list has 43 names; `com.fleet.gbrain-heal` restarts `gbrain-postgres` on its own.
- Consumers still pointed at 8099 (`ai-fleet/fleet/config/fleet-topology.json engines.local`,
  `~/.pi/agent/models.json local-llm`, gbrain autopilot and heal scripts, hermes) get
  connection refused while the replica serves. Repointing them at `127.0.0.1:47800/v1`
  works for plain chat but not for tool calls until the recipe carries `--jinja`; the
  context they advertise (262144) is above the replica's 65536.

## Follow-ups (not done, out of scope)

- Replica recipe for Flash-Next should carry production's cache and template flags
  (`--kv-unified`, quantized `--cache-type-k/v`, `--jinja`, `--reasoning-format auto`,
  `--chat-template-kwargs enable_thinking`) so a mesh replica at ctx 262144 fits where
  production fits and accepts tool calls. Needs a node release on all three feeds.
- The fit gate counts weights plus 2 GiB host only. KV cache at the requested context is not
  in `fitMiB`, which is how a 262144-context replica passed the gate and then wired 29 GB
  more than the gate had checked. Add a per-context KV term to the planner requirement.
- `POST /api/deployments` only registers a deployment (`planned`); a separate `/start` is
  needed. Either document it in `docs/HOST_CONTROL_PLANE.md` or accept `start: true` in the
  create body.
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

Retry: host notice to all (`m_018923f8`, 60 s lead, three acks, no objection), Flash-Next
notices #4 to #6 (`m_06fb6ada`, #5 at 13:25, `m_c2b7bdb0`), final state notice after this
report.
