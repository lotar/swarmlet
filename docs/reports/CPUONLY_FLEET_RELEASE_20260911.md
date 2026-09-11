# CPU-only rule on every node: fleet release 2026091109

Date: 2026-09-11. Control plane: `https://app.swarmlet.ai` (the-shop, image `swarmlet-control:6a4128e`). Source: `main` at `b5bf420`.

## Goal

The CPU-only compute rule (a node may run compute on its CPU only when it has no usable GPU) had shipped only to the Windows laptop as releases 2026091105 and 2026091106. This run puts the same agent code on all four nodes, proves on the hosted mesh that every node works after the switch, and adds repo-level e2e tests for the CPU-only path so it is not tied to the Windows machine.

## What shipped

Release `2026091109` (`0.1.0-linkwatch.20260911.9`) on all three feeds: `darwin-arm64` (16 files, signed Mac app included), `linux-x64` (7 files), `win32-x64` (6 files). Compared with the previous feed contents (`2026091108`, published by the Codex session from `19b6332`), only `swarmlet-node` (`swarmlet-node.exe` on Windows) and three `engine/desktop-app-*.bin` chunks on the Mac differ. All engine binaries are byte-identical to the earlier feeds.

Code in the release, all on `main`:

- `protocol/validate.ts`: `usableGpus`, `cpuOnlyRefusal`, the scaled Windows RAM reserve.
- `control/planner.ts` `placeResident` and `control/fleet.ts`: the planner never places a coordinator or replica on the CPU of a node that has a usable GPU.
- Replica recipe: planner device `CPU` becomes `--device none -ngl 0`.
- `node-agent/agent.ts`: link watchdog. The agent records the time of the last message from control. If control has been silent for 45 s (`CONTROL_SILENCE_MS`) the agent drops the socket and reconnects. Before this change the agent trusted the TCP socket; a half-open connection kept it "connected" and blocked the supervisor's switch (see the Legion 1 incident below).
- e2e: `e2e/fake-engine/llama-server` can hide its GPU (`FAKE_NO_GPU=1`), rejects invalid `--device` values the way the real engine does, and records its argv (`FAKE_ARGV_FILE`). `e2e/mesh.test.ts` gained two cases: a node with a GPU refuses a CPU-only offer through its local API (400, offer unchanged), and a GPU-less node serves a CPU-only replica end to end (plan device `CPU`, argv `--device none -ngl 0`, pinned chat answered by that node).
- `node-agent/test/agent-link.test.ts`: a silent control link reconnects exactly once; a link that keeps pinging stays up.

## Rollout

Idle gate before publishing: `requests_processing 0, requests_deferred 0, router_inflight 0` (FlashNext production on port 8099 was running; the check read its live metrics).

Every node switched on its own within 6 minutes of publishing, no manual restart:

| Node | OS | Before | Verified 109 | Activated 109 |
| --- | --- | --- | --- | --- |
| Lotars-MBP.home | darwin | 2026091108 | | 16:46 |
| LAPTOP-PPN32FP0 | win32 | 2026091108 | | 16:49 |
| lotar-legion | linux | 2026091108 | 16:50:27 | 16:50:37 |
| lotar-legion-2 | linux | 2026091108 | 16:52:06 | 16:52:09 |

Times are local (CEST) from the supervisor logs (`journalctl --user -u swarmlet-node` on Linux) and the controller's `/api/nodes`. Each node's local `/api/status` reports `connected true, releaseSequence 2026091109`.

The earlier fleet release `2026091107` (same code minus the watchdog and e2e cases) activated on the Mac, Windows and Legion 2 within 3 minutes; Legion 1 took 16 minutes because of the incident below.

## Legion 1 half-open link (root cause of the watchdog)

During the 2026091107 rollout Legion 1 stayed "connected" locally while the controller showed it offline. `ss` showed the WebSocket to the controller with 236792 bytes stuck in Send-Q: the TCP connection was half-open. The supervisor requires the staged child to report `connected` before switching, and the running agent never noticed the dead link, so the switch waited. The kernel gave up on the socket after about 16 minutes, the agent reconnected and activated 2026091107 at 16:36:16. The watchdog in this release closes that gap: 45 s of silence (the controller pings every 10 s) now forces a reconnect.

## Hosted end-to-end evidence (all on 2026091109)

Script: a read-only Python check against the hosted API (26 checks, all PASS, last run 16:58 CEST).

- Nodes: all four online on 2026091109. Windows: `caps.gpus []`, offer `gpu []`, replica role only (CPU-only offer allowed, no usable GPU). Mac `MTL0 110100 MiB`, Legion 1 `CUDA0 3706 MiB`, Legion 2 `CUDA0 3714 MiB` all offer GPU memory.
- Deployments `win-2b-cpu` (`dep-4fe6dbe93f1a`), `mesh-2b-internet` (`dep-65bedf5278d1`) and `flashnext-prod` (`dep-ce2358418a7d`, external, owned by the Codex session) are `ready`. The split went through `loading` while the Legion workers restarted on the new release and came back `ready` on its own.
- Pinned chat through `POST /v1/chat/completions` with `x-swarmlet-deployment`, `chat_template_kwargs.enable_thinking=false`:
  - `win-2b-cpu`: `x-swarmlet-node 01f78366eb893349` (Windows), 0.8 s, "Mercury is the planet closest to the Sun."
  - `mesh-2b-internet`: answered by the Mac coordinator, 5.2 s, same text. Live assignments: worker `lotar-legion` `CUDA0` listening, worker `lotar-legion-2` `CUDA0` listening, coordinator `Lotars-MBP.home` `RPC0,RPC1,MTL0` ready.
  - `flashnext-prod`: "READY", 0.3 s (read-only check of the Codex-owned production deployment).
- Placement: `win-2b-cpu` plan device is `CPU`. Plan preview of a 2B replica pinned to each GPU node (with `?replaces=dep-65bedf5278d1` so the preview can use the memory the split reserves) places it on `CUDA0` (both Legions) or `MTL0` (Mac), never `CPU`.

Repo tests at `b5bf420`: `tsc --noEmit` clean; `bun test node-agent/test/agent-link.test.ts` 2 pass; `bun test e2e/mesh.test.ts` 10 pass (two full runs); full `bun test` 394 pass.

## Known limits and notes

- Coordinator on a CPU-only node: the split-coordinator recipe still emits `--device ...,CPU`, which llama-server rejects. Not reachable in production because no CPU-only node offers the coordinator role. Fix belongs with the recipe when a CPU-only coordinator is wanted.
- Plan preview and "offer disabled": when a node's offered RAM or CPU is fully reserved by running deployments, `availableNodes` in `control/resources.ts` reports the node with `enabled false`, and the planner error reads "has its offer disabled". The node's offer is not disabled; the message should say the offer is fully reserved. This is also why `flashnext-mesh` (`dep-69d2ac8c0272`, Codex-owned) sits in `failed`: the Mac's offer is consumed by the `mesh-2b-internet` coordinator. Left as is on purpose; it competes with `flashnext-prod` for Mac memory.
- Qwen3.5 thinking: with thinking on, a small `max_tokens` is spent in `reasoning_content` and `content` stays empty. Pass `chat_template_kwargs.enable_thinking=false` or a larger budget.
- Housekeeping: staging directories `agent-dist-2026091107` and `agent-dist-2026091109` remain under `/root/projects/swarmlet-control` on the-shop. A stale fake engine `e2e/fake-engine/llama-server --port 8199` from 2026-09-06 (pid 95038) is still running on the Mac.
