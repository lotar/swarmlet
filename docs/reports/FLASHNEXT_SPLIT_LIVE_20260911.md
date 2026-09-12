# Flash-Next served by the mesh split: Mac plus both Legions (2026-09-11, 18:48 to 18:58)

Status 2026-09-12 12:44: the split is stopped. It crashed 11 times overnight (a WebSocket
drop on any node breaks the relay ring) and bounced production 8099 each time. A
whole-model replica on the Mac was attempted and refused by the memory fit gate; production
on 8099 serves Flash-Next again. See `docs/reports/FLASHNEXT_M5_REPLICA_20260912.md`.

Status 2026-09-12 14:10: with Docker Desktop stopped, the whole-model replica on the Mac
(`flashnext-m5-64k`, `dep-5a6b848b63d0`, ctx 65536) serves Flash-Next; 8099 is down while
it runs. Decode 30 to 36 tok/s against the split's 5.5. The split stays stopped.

Status 2026-09-12 14:31: the replica was lost at 14:22 (controller re-placed it after a 7 s
WebSocket blip, then the fit gate refused twice) and is `stopped`; production on 8099
serves Flash-Next again. The split stays stopped. Details in the M5 replica report.

Request: "update flash next to serve partially, have legions serve 2 layers each."

Result: Flash-Next (`qwen3.8-flash-next`) is now served by the split deployment
`flashnext-mesh` (`dep-0867eec8aa93`) on the hosted controller: the Mac coordinator
holds 46 of 48 layers on Metal, `lotar-legion` and `lotar-legion-2` hold 1 layer each on
their GTX 1650 cards. The standalone production server on the Mac (`127.0.0.1:8099`,
launchd `com.lotar.llm-flashnext`) is stopped while the split runs; stopping the split
restores it. The "2 layers each" part is NOT delivered: see "Two layers per Legion".

## What was wrong before

- `flashnext-mesh` (old id `dep-69d2ac8c0272`) was `failed` with "offer disabled" for the
  Mac and lotar-legion-2. That message means the node's offered RAM/CPU was fully
  reserved: `mesh-2b-internet` (the 2B split) had no explicit budgets, so it reserved the
  whole offer of the Mac and both Legions (`control/resources.ts planWithResources`,
  `plan.allocations = offeredAllocation(...)`).
- Before that, the same deployment failed on the Mac with "does not fit: 53177 MiB free,
  need 76016; no external service to stop" (Mac agent log, 17:49 and 21:15). Its spec had
  no `stopExternal`, so the fit gate could not stop the production server, and a second
  copy of the 104 GB model does not fit beside it.
- The Legion GPUs offer 3600 and 3604 MiB. A 2B split worker needs 752 MiB (3 x 80 + 512)
  and a Flash-Next worker needs 3144 MiB (1 x 1608 + 1536). Both together (3896 MiB) do not
  fit, so the Legions can carry the 2B split or the Flash-Next split, not both.

## What was done (hosted operations, no code change)

1. Bus: claimed the work with the Flash-Next owner (`codex:01a070be`, `m_e595963c`) and
   broadcast the planned 8099 outage to every session (`m_6e90b6b2`), because the fleet
   topology uses `http://127.0.0.1:8099/v1` as its `local` model lane (about 3 requests per
   minute in the production log).
2. `POST /api/deployments/dep-65bedf5278d1/stop`: `mesh-2b-internet` stopped. `qwen3.5-2b`
   is still served by the Windows CPU replica `win-2b-cpu` (`dep-4fe6dbe93f1a`, ready).
3. `DELETE /api/deployments/dep-69d2ac8c0272`, then `POST /api/deployments` with the same
   spec plus `"stopExternal": true`: coordinator Mac, workers `[lotar-legion-2, lotar-legion]`,
   `workerLayers [1, 1]`, ctx 1024, parallel 1, chain 0, transport relay. New id
   `dep-0867eec8aa93`.
4. `POST /api/deployments/dep-0867eec8aa93/start` at 18:48:43. Workers listening at
   18:49; the coordinator fit gate stopped production through
   `sin-harness/scripts/flashnext-maintenance.sh stop`; `ready` at 18:55:02.

## Evidence

- Coordinator argv on the Mac (pid 73993, release 2026091109): `--rpc <relay>,<relay>
  --device RPC0,RPC1,MTL0 --tensor-split 1,1,47 -ngl 999 -c 1024 --parallel 1`.
  Engine log: `RPC0 compute buffer size = 140.00 MiB` and `140.35 MiB`, `MTL0 compute
  buffer size = 156.04 MiB`.
- Legion VRAM with one Flash-Next layer loaded (`nvidia-smi`, 18:56): lotar-legion (GTX
  1650 Ti) `ggml-rpc-server` 1842 MiB, card 2004 of 4096 MiB used; lotar-legion-2 (GTX
  1650) 1804 MiB, card 1813 of 4096 MiB used.
- Routing (`GET /api/routing`): `qwen3.8-flash-next` lists only `flashnext-mesh` (3 nodes);
  `flashnext-prod` (`dep-ce2358418a7d`) shows `loading`, "external http://127.0.0.1:8099
  unhealthy", so the router never picks it. `qwen3.5-2b` lists only `win-2b-cpu`.
- Unpinned request from the Mac to `https://app.swarmlet.ai/v1/chat/completions`: 200,
  `x-swarmlet-deployment: dep-0867eec8aa93`, `x-swarmlet-node: 30f05a2670c368d0`, engine
  timing prompt 66 tokens at 13.6 tokens per second, decode 40 tokens at 5.47 tokens per
  second (183 ms per token; each token crosses the relay three times).
- Request from the Windows laptop through its own agent (`http://127.0.0.1:47800`, the path
  the shell chat uses), thinking off: 200 in 8.05 s, `x-swarmlet-route: mesh`,
  `x-swarmlet-deployment: dep-0867eec8aa93`, `x-swarmlet-node: 30f05a2670c368d0`, content
  "Mercury is the planet closest to the Sun.", finish `stop`, 11 completion tokens.
- Production: `lsof -iTCP:8099` shows no listener; `/health` on 8099 fails.
- Mac memory before and after (vm_stat): wired 104.9 GB then 96.4 GB, compressor 17.8 GB
  then 18.2 GB, free percentage 10% then 15%. The split uses less memory than the
  production server did (ctx 1024 instead of 262144).

## Two layers per Legion (not delivered)

Requested `workerLayers [2, 2]`. `POST /api/deployments/plan-preview` refuses it:
"Worker lotar-legion-2: no envelope row for requested 2 layers fits ctx 1024, parallel 1,
chain 0. Worker lotar-legion-2 needs 4752 MiB for requested 2 layers but offers 3600 MiB on
CUDA0" (same for lotar-legion, 3604 MiB).

Two facts behind that refusal:

- The profile `flash-next-ud-q4kxl` has envelope rows only for 1 layer per worker. The
  planner treats envelope rows as measured facts (`control/planner.ts`,
  `docs/FLASHNEXT_RING_LEVERS_20260904.md`); the last written measurement of a 2,2,44 split
  (ctx 4096) overflowed the cards (`docs/FLASHNEXT_3NODE_40TPS_20260904.md`).
- Memory model: 2 x 1608 MiB weights plus the 1536 MiB worker margin is 4752 MiB, above the
  3600 MiB offers and above the 3706 and 3714 MiB the engine sees on the cards.

What the live numbers say: one layer costs 1842 MiB (Ti) and 1804 MiB on the cards, so the
overhead beyond the 1608 MiB weights is about 200 to 235 MiB at ctx 1024, parallel 1. A
second layer would put the workers at about 3450 MiB (Ti, which also drives a display and
has about 3546 MiB available) and about 3412 MiB (GTX 1650, about 3705 MiB available), and
the compute buffer may grow with the second layer. It is at the edge of the 4 GB cards, not
clearly impossible, but making it official needs: a measurement run of 2,2,44 at ctx 1024,
a per-row worker margin or a new envelope row in the profile (planner change, tests,
control-plane redeploy on the-shop), and a second production outage for the measurement.
Speed would not improve: decode is dominated by the three relay crossings per token, not
by Legion compute. Left for the owner to decide.

## How to reverse

- Back to production Flash-Next (ctx 262144, parallel 4, about 29 tokens per second):
  `POST /api/deployments/dep-0867eec8aa93/stop`. The Mac agent then runs
  `flashnext-maintenance.sh start` and `flashnext-prod` turns `ready` again once `/health`
  answers on 8099.
- Back to the 2B split on the Legions: `POST /api/deployments/dep-65bedf5278d1/start`
  (only after the Flash-Next split is stopped; the Legion GPUs cannot hold both).

## Side effects to know

- While the split runs, Flash-Next has ctx 1024 and parallel 1 for every client, including
  the fleet's `local` lane on 8099, which is down. Announced on the bus (`m_6e90b6b2`).
- `qwen3.5-2b` requests now all land on the Windows laptop (17 tokens per second, ctx 2048).
- Deployment id changed: `flashnext-mesh` is `dep-0867eec8aa93` (was `dep-69d2ac8c0272`).
