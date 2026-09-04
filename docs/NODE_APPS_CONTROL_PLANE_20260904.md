# Design: Swarmlet node apps (macOS + Linux, GUI) and the control plane (routing)

**Date:** 2026-09-04
**Status:** implemented on branch `feat/node-apps-control-plane`; M0–M3 accepted on the rig, M4 blocked by external clients (§13), M5 macOS bundle built / Linux in progress, M6 gate green
**Scope:** roadmap item 04 "Product alpha" on swarmlet.ai minus model distribution; gap-audit §5 steps 1–3 (`docs/GAP_AUDIT_INTERNET_MOE_20260902.md`)
**Rig for acceptance:** M5 (macOS 26.5, 128 GB, production Flash-Next on :8099), Legion 1 (Ubuntu 24.04, GTX 1650 Ti 4 GB), Legion 2 (Ubuntu 24.04, GTX 1650 4 GB)

## 1. Problem

The mesh is operated by hand. Scratchpad scripts ssh into the Legions, start `ggml-rpc-server` under `systemd-run`, open Cloudflare quick tunnels and websocat, bridge them on the M5, stop production through `flashnext-maintenance.sh`, launch `llama-server --rpc ... --tensor-split ...`, run a client, tear down, restore. The M5 is "the router" only in the sense that it runs the RPC-client `llama-server` and the bridges. No machine owner can say "the mesh may use 3 GiB of my GPU and 8 GiB of RAM"; there is no registry of nodes; nothing routes requests.

## 2. Topology decision

The control plane routes **requests** to **deployments**. A deployment is either

- a **replica**: one node serving the whole model (20+ tok/s per node measured, zero per-token network hops), or
- a **split**: one coordinator holding the model file plus few workers holding layer slabs, MTP on the coordinator (best exact 3-node Flash-Next: 12.59 tok/s c1 over the internet relay path, 18.17 lossy on the LAN; `docs/FLASHNEXT_RING_LEVERS_20260904.md`).

Expert-parallel over WAN stays closed (audit §3, kill criterion in `docs/KIMI_K3_DISTRIBUTED_MOE.md`).

## 3. Components

```
 owner's machine (mac / linux)                       control host (M5 now, swarmlet.ai later)
 ┌──────────────────────────────────────┐            ┌──────────────────────────────────────┐
 │ node-shell (Tauri: window+tray)      │            │ control                              │
 │   └─ opens http://127.0.0.1:47800    │            │  registry · enrollment · heartbeats  │
 │ node-agent daemon (LaunchAgent /     │──WSS────▶  │  planner · deployments · router      │
 │   systemd --user)                    │  /agent    │  relay (stream mux)                  │
 │   probe · offer · roles · supervisor │            │  web UI · /v1/* OpenAI API · SQLite  │
 │   data listener :47801 (TLS, pinned) │◀─TLS──┐    └──────────────────────────────────────┘
 │   ggml-rpc-server / llama-server     │       │  direct path from another node's agent
 │     bound 127.0.0.1 only             │       └─ (or relay stream via control when unreachable)
 └──────────────────────────────────────┘
```

| Component | Location | Runtime | Purpose |
|---|---|---|---|
| protocol | `swarmlet/protocol/` | TypeScript, zero deps | schemas, validators, canonical JSON + Ed25519 (re-exports `sin-harness/core/sign.ts`), channel framing |
| node-agent | `swarmlet/node-agent/` | Bun, compiled to `bun-darwin-arm64` / `bun-linux-x64` binaries | probe, offer, enforcement, roles, transport, local web UI, CLI, service install |
| node-shell | `swarmlet/node-shell/` | Tauri v2 (Rust shell, system webview) | window + tray + autostart around the agent's local UI; ships agent + engine as sidecars |
| control | `swarmlet/control/` | Bun + SQLite | registry, enrollment, agent channel + relay, planner, deployments, OpenAI-compatible router, web UI |
| engine | `swarmlet/engine/` | patch + build script | patched llama.cpp (`ggml-rpc-server`, `llama-server`, `llama-ring-bench`) per platform |

Naming follows the site: **Node** (agent), **CLI**, **API**, **Web**.

## 4. Resource allocation

The owner edits an `Offer`; the agent enforces what the OS allows and advertises the rest.

```ts
interface Offer {
  enabled: boolean;
  roles: { worker: boolean; coordinator: boolean; replica: boolean };
  gpu: Array<{ id: string; memGiB: number }>;   // per device; on Apple silicon = accelerator share of unified memory
  ramGiB: number;                                 // host RAM for engine processes
  cpuCores: number;
  diskGiB: number;                                // models dir cap
  modelsDir: string;
}
```

Validation: `memGiB ≤ device total − margin`, `ramGiB ≤ total − OS reserve` (4 GiB Linux, 12 GiB macOS), `cpuCores ≤ nproc`.

| Resource | Linux (Ubuntu 24.04) | macOS |
|---|---|---|
| GPU memory | `ggml-rpc-server --mem-cap-mib` (new; caps allocations and what `get_device_memory` reports) + planner budget; `nvidia-smi` live | same cap on the Metal device; `iogpu.wired_limit_mb` displayed, not set (root, global) |
| Host RAM | `systemd-run --user -p MemoryMax= -p MemorySwapMax=0` (cgroup v2, user slice delegates `cpu memory pids`, verified on both Legions) | RSS watchdog (soft, kill at +10 %) + free-RAM fit gate before launch (`vm_stat` free+inactive+speculative+purgeable, as in the operators) |
| CPU | `-p CPUQuota=<cores*100>%` + `-t cores` (cpuset not delegated → no pinning) | `-t cores` + optional `taskpolicy -c background` |
| Disk | models dir accounting, refuse beyond cap | same |
| Network | measured RTT and 5 s up/down probe to control, advertised | same |

Not in v1: bandwidth shaping (root), schedules, idle detection.

## 5. Identity, enrollment, transport

- **Identity:** Ed25519 keypair per node (`sin-harness/core/sign.ts`, `~/.swarmlet/keys/`), plus a self-signed X.509 cert generated with `openssl` for the TLS data listener. `nodeId` = first 16 hex of SHA-256(public JWK).
- **Enrollment:** control issues a one-time join code (10 min TTL) in the web UI; the agent `POST /enroll {code, pubkey, certFingerprint, hostname, capabilities}` signed with its key; control stores identity + fingerprint. Later sessions: control sends a nonce over the WSS, agent signs it.
- **Agent channel:** one outbound WSS `/agent` per node. Text frames = control messages (`{t, id, ...}`); binary frames = multiplexed streams `[u32 streamId][u8 op: open|data|close][payload]`. Streams carry relayed data-plane bytes and forwarded HTTP for the router.
- **Data plane:** for every remote endpoint in an assignment the agent opens a local `127.0.0.1` port that pipes to
  1. a **direct** TLS connection to the peer agent's data listener (`:47801`), fingerprint pinned to what control published, when the peer is reachable (same LAN via advertised private IPs, or a public address the peer advertised), else
  2. a **relay** stream through control (control bridges stream A of node X to stream B of node Y).
  The engine only ever sees `127.0.0.1` endpoints (`--rpc`, `--peer`). Push forwarding L1→L2 (`--peer 1=127.0.0.1:port`) uses the same mechanism.
- **Listener policy:** the data listener accepts a connection only if the client cert fingerprint is in the allowlist control attached to the current assignment. Everything else (`ggml-rpc-server`, `llama-server`, agent UI) binds `127.0.0.1`.
- **Control auth:** admin token (env/config, cookie session) for the web UI; API keys for `/v1/*`.

## 6. Control plane

### Registry (SQLite)
`nodes(id, pubkey, certFp, hostname, os, arch, firstSeen)`, `offers(nodeId, json, updatedAt)`, `capabilities(nodeId, json, measuredAt)` (GPU list, RAM, cores, disk, private IPs, public IP, RTT/up/down to control, engine version), `heartbeats(nodeId, ts, metricsJson)`, `models(nodeId, path, sizeBytes, sha256, name)`, `deployments(...)`, `assignments(...)`, `events(...)`, `apiKeys(...)`, `joinCodes(...)`.

### Deployment state machine
```
planned → placing → loading → ready → draining → stopped
              │          │        │
              └──────────┴────────┴──▶ failed  (any node error / heartbeat loss / refused assignment)
```
- `placing`: planner output accepted, allowlists computed, assignments sent (workers first, coordinator last).
- `loading`: workers report `listening`; coordinator reports `loading` until `/health` is ok.
- `ready`: router may send requests.
- `draining`: no new requests, in-flight finish (bounded), then `stop` to coordinator, then workers.
- `failed`: stop everything that was started, restore external deployments the agent stopped, keep logs.

### Assignments (control → agent)
```ts
type Assignment =
  | { kind: "worker";      id; deploymentId; port; device; threads; memCapMiB; peerPort?; peers?: Array<{ index; endpoint: Endpoint }>; allow: string[] /* fingerprints */ }
  | { kind: "coordinator"; id; deploymentId; model: { path; sha256 }; rpc: Endpoint[]; devices: string[]; tensorSplit: number[]; ctx; parallel; mtp?: { path; chain }; env: Record<string,string>; port; stopExternal?: string }
  | { kind: "replica";     id; deploymentId; model | external: { url; healthPath } ; port }
  | { kind: "stop";        id };
type Endpoint = { nodeId; certFp; direct?: { host; port }; relay: true };
```
Agents answer with `{t:"assignment", id, state: "starting"|"listening"|"loading"|"ready"|"stopped"|"failed", detail}` and stream log tails.

### Planner (v1, deterministic)
Inputs: model profile + offers of online nodes with the right roles. Output: coordinator = the node holding the model file with the largest RAM offer; workers = nodes with `worker` role ordered by measured RTT to the coordinator; `--tensor-split` = one profile row per worker (validated envelope), remainder on the coordinator; ctx/parallel/chain from the request, clamped to the envelope. The planner refuses (with the reason) anything outside the profile's validated rows. Profiles (`swarmlet/control/profiles/*.json`):

| model | layer GiB | boundary | host-side | validated rows |
|---|---|---|---|---|
| Qwen3.8 Flash-Next UD-Q4_K_XL | 1.57 | 2 × 40 KiB per boundary | PLE 28.8 GiB mmap (`-ot ple_ngram_embd=CPU`) | 4 GB workers: 1 layer, ctx ≤ 1536, parallel ≤ 3, chain ≤ 8; parallel 1: chain ≤ 12 |
| Qwen3.5-2B (rig/test) | 0.07 | 2 × 4 KiB | none | any split, ctx ≤ 4096 |
| Qwen3.6-35B-A3B Q4_K_M | 0.5 | 4 KiB | none | 4/4/32 |

### Router
`GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/completions` (streaming SSE passthrough). Pick among `ready` deployments serving the requested model: least in-flight, then lowest RTT. Forwarding goes over the agent channel (a stream to the coordinator/replica node's local llama-server) so it works wherever control runs; a direct HTTP path is an optimization for later. External deployments (production `:8099` on the M5) are registered read-only and routed like replicas.

### Web UI (dependency-free, `site/app.js` style)
Nodes (online, roles, offer vs measured, usage), Deployments (create → planner suggestion → review flags → start; status; live tok/s from `/metrics`; stop), Routing (models, in-flight, per-deployment throughput), Events.

## 7. Node agent

- `probe/darwin.ts`, `probe/linux.ts`, `probe/net.ts` (parsers unit-tested on fixture outputs of `vm_stat`, `sysctl`, `/proc/meminfo`, `nvidia-smi --query-gpu`).
- `offer.ts` (persist `~/.swarmlet/node.json`, validate against probe).
- `enforce/linux.ts` (systemd-run properties), `enforce/darwin.ts` (threads, QoS, RSS watchdog, fit gate).
- `roles/worker.ts`, `roles/coordinator.ts`, `roles/replica.ts` with the supervisor pattern of `sin-harness/proofs/tiny-moe/supervisor.ts` (exact argv restart, pid file, SIGTERM then SIGKILL after 90 s).
- Coordinator recipe (from the measured best exact config): `llama-server -m <gguf> --rpc 127.0.0.1:p1,127.0.0.1:p2 --device RPC0,RPC1,<local> --tensor-split ... -ngl 999 -ot ple_ngram_embd=CPU -c <ctx> --parallel <n> -fa on --cache-ram 0 --ctx-checkpoints 0 --metrics [--spec-type draft-mtp -md <mtp> --spec-draft-n-max <chain> -ngld 999]` with env `GGML_RPC_FORWARD=1 GGML_RPC_PIPELINE=1 GGML_SCHED_PIPELINED_COPY=1 GGML_RPC_GET_PIPELINE=1 GGML_RPC_WIRE=off`.
- `transport/dataListener.ts`, `transport/dial.ts` (replace `ws-bridge.py`, websocat, cloudflared, `ssh -L`).
- `agent.ts` (WSS client, auth, 5 s heartbeat with metrics, assignment execution, log streaming, reconnect with backoff).
- `ui/` at `127.0.0.1:47800`: Status, Resources, Models, Connection, Logs.
- CLI = the same binary: `swarmlet node install|uninstall|join <url> <code>|status|offer set k=v|ui`.
- **Production guard (M5):** an external deployment is registered from `~/Library/LaunchAgents/com.lotar.llm-flashnext.plist`. A coordinator/replica assignment on that node first runs the fit gate; if it fails, the assignment is refused unless it carries `stopExternal`, in which case the agent runs `sin-harness/scripts/flashnext-maintenance.sh stop` (honoring its active-client refusal) and always runs `start` when the deployment ends or the agent exits.

## 8. Node shell (Tauri v2)

Window loads `http://127.0.0.1:47800`; tray: Enable/Disable, Open, Quit; `tauri-plugin-autostart`; sidecars: agent + engine binaries (`externalBin`, target-triple suffixes). If the agent service is installed the shell only connects; otherwise it starts the sidecar and offers "Install as service". Bundles: `.app`/`.dmg` (built on the M5), `.deb`/`.AppImage` (built on Legion 1). Unsigned in alpha.

## 9. Engine

`swarmlet/engine/patches/llama-mesh-engine-9400c89.patch` = the complete lab delta (pipelined dispatcher, graph cache, push forwarding, batched GETs, wire modes, server trace, qwen4exp MTP head-only loading, `tools/ring-bench/`) plus the new `--mem-cap-mib`. `build.sh <darwin|linux>` clones upstream at `9400c89`, applies the patch, configures (Metal + Apple BLAS / CUDA arch 75), builds `ggml-rpc-server`, `llama-server`, `llama-ring-bench` into `dist/<target>/` with `sha256.txt`.

## 10. Milestones and acceptance

| M | Deliverable | Acceptance (evidence under `sin-harness/data/legion-goal/app-*`) |
|---|---|---|
| M0 | engine patch + build.sh + `--mem-cap-mib` | fresh builds on M5 and Legion 1 answer HELLO 8.1; `lan-2b-ring` byte-identical; a 1024 MiB cap makes a larger placement fail cleanly |
| M1 | protocol + control core | `bun test`: enroll, heartbeat, 10 MB relay bit-exact, bad signature / expired code rejected |
| M2 | node agent + local UI + service install | three nodes enrolled; offers editable; worker under cgroup limits; M5 reaches both workers via direct LAN and via relay; RTT per path recorded |
| M3 | deployments + planner + coordinator + router | Qwen3.5-2B split from the web UI beside production; `/v1/chat/completions` streams; ring-bench within noise of `lan-2b-ring` / `fn-ringstep`; kill-a-worker → `failed` + cleanup; production routed as external replica |
| M4 | Flash-Next through the app | one window: chain 4 + batched GETs, wire off, parallel 3, split 1,1,46, ctx 1536 → ≥ 12 tok/s c1 relay, ≥ 9 nospec LAN, parity 5/6; production restored by the agent |
| M5 | Tauri shells + installers | `.deb` on Legion 2, `.app` on M5; slider → agent → registry within one heartbeat; quit shell, daemon keeps serving |
| M6 | hardening + docs + gate | release gate covers `swarmlet/`; bind audit; docs; site roadmap 04 → in progress |

## 11. Constraints kept

Never a second copy of the 104 GB model beside production; production only via `flashnext-maintenance.sh` with guaranteed restore; kill by PID only; engine listeners on `127.0.0.1`; Legion password only from the scratchpad file via `sudo -S` for one-time build deps; other sessions' services (`jarvis`, `openclaw-gateway`, `auto-fix` on Legion 2; the Docker containers on the M5) untouched; no Docker Desktop changes; the Legion VRAM envelope encoded in profiles.

## 12. Out of scope (v2)

Model distribution with digests; NAT hole punching / WireGuard; bandwidth shaping; schedules/idle detection; multi-tenant users and public enrollment; code signing/notarization; KV-affinity routing; profile discovery by dry-run.

## 13. Results (2026-09-04)

| Milestone | Outcome | Evidence |
|---|---|---|
| M0 engine | patch + `build.sh` on M5 (Metal) and Legion 1 (CUDA), `--mem-cap-mib` probe passes on all three nodes | `swarmlet/engine/`, `engine/test/memcap_probe.py` |
| M1 core | 78 unit/integration tests (protocol, control, agent transport); e2e with a fake engine: split, replica, external, worker-crash cleanup | `cd swarmlet && bun test protocol control node-agent && bun test e2e` |
| M2 agent | both Legions enrolled as systemd user services with worker offers (cuda:0 3600 MiB, 8192 MiB RAM, 10 cores); cgroup `MemoryMax=8192M MemorySwapMax=0 CPUQuota=1000%` observed on the real workers | `sin-harness/data/legion-goal/app-rig-2b-20260904T113351Z` |
| M3 deployments | Qwen3.5-2B split 3/3/18 planned and started from the control plane, request routed through `/v1/chat/completions`; direct pinned-TLS path **11.87 tok/s** c1 (ready in 12 s), relay through control **10.37 tok/s** c1 | same directory (`plan-*.json`, `deployment-*.json`, `*-c1/summary.json`) |
| M4 Flash-Next window | production registered as an external deployment and routed (answered through the control plane); plan = split 1,1,46, chain 4, batched GETs, wire off, exactly the measured configuration; the maintenance script refused to stop production for 20 min because two other sessions held idle keep-alive connections to :8099 (PIDs logged); production never stopped, everything cleaned up | `app-rig-flashnext-20260904T115553Z` |
| M5 shell | macOS `Swarmlet Node.app` (97 MB) with the compiled agent as sidecar and the Metal engine as resources; Linux deb/AppImage build on Legion 1 in progress | `swarmlet/node-shell/` |
| M6 gate | `sin-harness/scripts/release-check.sh` runs the swarmlet typecheck + tests: `RELEASE_CHECK_OK` | — |

Reference for M3: the earlier ring-bench run of the same model on the same LAN (split 2/2/20, `ssh -L` forwards,
`lan-2b-ring-20260904T070303Z`) measured 17.5 tok/s with push forwarding and 11.8 without. The app's number is
llama-server (not ring-bench) at `--parallel 1` with three layers per worker and the dialer/listener hops in the
path; a like-for-like ring-bench through the app's ports is the next measurement, not a regression claim.

To finish M4, rerun `swarmlet/e2e/rig-flashnext.sh` when `lsof -nP -iTCP:8099 | grep ESTABLISHED` shows no
foreign clients; the agent retries the stop every 20 s for 20 minutes and restores production afterwards.
