# How to run a Swarmlet node and the control plane

This is the packaged form of the mesh described in [NODE_APPS_CONTROL_PLANE_20260904.md](NODE_APPS_CONTROL_PLANE_20260904.md).
Everything lives under `swarmlet/`.

## 0. What is installed on the rig right now (2026-09-04)

| Machine | What runs | How |
|---|---|---|
| M5 | control plane `http://192.168.1.53:47900` | LaunchAgent `ai.swarmlet.control` (`swarmlet/control/install-launchd.sh`) |
| M5 | node agent (coordinator + replica roles, local UI `http://127.0.0.1:47800`) | LaunchAgent `ai.swarmlet.node` (`dist/agent/darwin/swarmlet-node install`) |
| M5 | `Swarmlet Node.app` (window + tray) | attaches to the service; starts a sidecar only when no service answers |
| Legion 1, Legion 2 | node agent (worker role) | systemd user service `swarmlet-node` (`e2e/rig-setup.sh`), UI via `ssh -L 47800:127.0.0.1:47800` |
| Legion 2 | `swarmlet-node-shell` (Linux GUI) | installed from the `.deb`; appears in the applications menu |

Admin token: `~/.swarmlet/control/control.json` on the M5. Production (`:8099`) is registered as the external
deployment `flashnext-prod` and is routed under model `qwen3.8-flash-next`.

## 1. Control plane (one machine, the M5 today)

```bash
cd swarmlet && bun install
bun run control                      # http://127.0.0.1:47900, foreground
cat ~/.swarmlet/control/control.json # adminToken
```

To let Legions on the LAN reach it, bind the LAN address and tell enrollment where you are:

```bash
SWARMLET_CONTROL_HOST=0.0.0.0 SWARMLET_CONTROL_URL=http://192.168.1.10:47900 bun run control
```

As a service on macOS: `swarmlet/control/install-launchd.sh` (uninstall with `--uninstall`). Logs in
`~/.swarmlet/control/control.err.log`.

Open the web UI, paste the admin token, create a join code (Nodes tab). For a control plane on your own
laptop, `SWARMLET_ADMIN_TRUST_LOOPBACK=1` lets browsers on 127.0.0.1 in without the token (dev only;
the LAN address still requires it).

## 2. Node agent

Service on macOS from the compiled binary (`bun run node-agent/build.ts darwin` puts it in
`dist/agent/darwin/` with the engine beside it):

```bash
dist/agent/darwin/swarmlet-node install     # LaunchAgent ai.swarmlet.node; uninstall: ... uninstall
dist/agent/darwin/swarmlet-node status      # JSON from the running daemon
```

From source on any machine with Bun:

```bash
bun run agent                                     # daemon + local UI on http://127.0.0.1:47800
bun run node-agent/main.ts join http://192.168.1.10:47900 ABC123
```

Compiled binaries (macOS arm64 and Linux x64) come from `bun run node-agent/build.ts`; the Linux
engine is built on a Legion with `engine/build.sh linux`. `swarmlet/e2e/rig-setup.sh` ships, installs
(`swarmlet-node install` = systemd user service, linger enabled) and enrolls both Legions in one go.

The GUI shell (`swarmlet/node-shell`, Tauri) wraps the same local UI with a window, a tray icon and
start-at-login; it starts the agent as a sidecar when no service is installed.

## 3. Offering resources

Resources tab (or `swarmlet-node offer set ...`): GPU memory per device, RAM, CPU cores, disk cap,
models directory, roles (worker / coordinator / replica), master switch. Values above what the
machine has are rejected with the reason. What each control enforces:

| | Linux | macOS |
|---|---|---|
| GPU memory | `ggml-rpc-server --mem-cap-mib` + planner budget | same (unified memory share) |
| RAM | cgroup `MemoryMax`, `MemorySwapMax=0` | soft cap: RSS watchdog kills at +10 % |
| CPU | cgroup `CPUQuota` + `-t` | `-t` |
| disk | models dir cap | same |

## 3a. Chat and live throughput

The **Chat** tab (`http://192.168.1.53:47900/#chat`) is a small chat client that goes through the router like any
API client: pick a served model and, when several deployments serve it, the deployment (the list defaults to the
one spanning the most nodes, e.g. `mesh-2b · split · 3 nodes: M5 → legion → legion-2`); type, Enter. API clients
can pin a deployment the same way with the header `x-swarmlet-deployment: <id or name>`. Each reply shows the server's own timing (tok/s, prompt and completion
tokens, time to first token), which node and deployment served it, and a running session average. The **Topology**
panel draws the path of the selected model (and, after each reply, of the deployment that served it): browser →
control router → coordinator node (device, layers, ctx/parallel/chain) → each RPC worker (device, layers, memory
cap, ports, direct or relay path, bytes per token), with the ring and boundary settings spelled out below it. "Thinking"
toggles the model's reasoning mode. The **Nodes** tab (`#nodes`) has a tok/s column: every agent reports the
generation rate of its local llama-server (coordinator, replica, or the external production server) over the last
heartbeat interval, so the number moves while a reply streams and drops to 0.0 when idle.

## 3c. Internet path (relay through the Cloudflare edge)

**Public access restricted as of 2026-09-05:** only the `/agent` WebSocket is exposed through the tunnel, with the existing signed node authentication. Dashboard assets, login, admin/OpenAI APIs, enrollment, health and bandwidth/IP probes return 404 publicly, even with valid admin credentials. Open the dashboard directly at `http://192.168.1.53:47900`; proxy headers or a public Host cannot grant local access. All three existing nodes use the internet channel. Host/engine metrics continue over that channel; HTTP network probes through the public URL are unavailable, so previous RTT/bandwidth samples retain their age. New nodes must enroll over the LAN before their configured agent URL is switched to the tunnel. The historical re-enrollment script described below cannot enroll through the public URL under this restriction.

All three rig machines share one public IP, so an internet path needs an external hop. `swarmlet/control/cloudflare-tunnel.sh start`
puts a quick tunnel in front of control (LaunchAgent, new hostname on every start); `swarmlet/e2e/rig-internet.sh` pins that
hostname on the Legions (the LAN router's resolver drops A records for fresh trycloudflare names) and re-enrolls them through it,
so their agent channels run as `wss://<tunnel>/agent`. A deployment created with `transport: "relay"` then carries every RPC
hop through control and the edge (Nodes tab: `relay ↓/↑` bytes per node and `via wss://<tunnel> (Cloudflare edge)` under
network; the chat topology labels each RPC edge with the worker's channel host; measured RTT to control 44–85 ms instead of 8).
The M5 keeps its LAN channel because it hosts control. Stop with `cloudflare-tunnel.sh stop` and re-join the Legions on the
LAN address to go back.
Limitation: in relay mode control sits in the data path, so restarting control drops the RPC streams and the coordinator
aborts on its next request (the deployment goes `failed`; measured 2026-09-04: `engine exited (code 134, SIGABRT)`).
Redeploy after any control restart (the 2B split is back in ~15 s). Direct-TLS deployments are unaffected.

## 3b. Day-to-day

1. Open `http://192.168.1.53:47900`, paste the admin token once (cookie).
2. Nodes tab: everything online with its offer and measured RTT/bandwidth. New node: **New join code**, then on that
   machine `swarmlet-node join http://192.168.1.53:47900 <CODE>` (or the Connection tab of its local UI).
3. Deployments tab: **New**, choose profile/kind/nodes, **Preview plan**, **Create** (starts it). Wait for `ready`.
4. Keys tab: create an API key. Routing tab shows the base URL and a curl example.
5. Stop a deployment from its row when done; workers and the coordinator are torn down and production is restored
   if the deployment had stopped it.

Uninstall everything on the M5: `launchctl bootout gui/$(id -u)/ai.swarmlet.control ai.swarmlet.node` (or the two
`--uninstall`/`uninstall` commands above); on a Legion: `swarmlet-node uninstall`.

## 4. Deployments and routing

Deployments tab: pick a profile (Flash-Next UD-Q4_K_XL, Qwen3.5-2B, Qwen3.6-35B-A3B), kind
(`split` = coordinator + workers, `replica` = whole model on one node, `external` = an already running
server such as production `:8099`), nodes, ctx / parallel / chain / wire / batched GETs, then **Preview
plan** (tensor split, devices, every reason) and **Create + Start**. The planner refuses anything outside
the profile's validated envelope and says why.

Requests: `POST /v1/chat/completions` on the control plane with an API key from the Keys tab; the router
picks a ready deployment serving `model` (least in-flight, then lowest RTT) and streams the answer back.

## 5. Production on the M5

Register production as an external deployment (`kind: external`, url `http://127.0.0.1:8099`, model
`qwen3.8-flash-next`) so it is routed like a replica. A split that needs the M5's memory can only stop it
when the deployment sets `stopExternal` **and** the M5 agent's `node.json` lists the service with its
maintenance script:

```json
"externals": [{ "id": "flashnext-prod", "modelName": "qwen3.8-flash-next", "url": "http://127.0.0.1:8099",
                "healthPath": "/health", "maintenance": "/Users/lotar/projects/ai-mesh/sin-harness/scripts/flashnext-maintenance.sh" }]
```

The agent runs `stop` through that script, which refuses while any client holds a connection to :8099;
the agent then retries every 20 s for up to 20 minutes (the deployment shows "waiting for flashnext-prod
clients to disconnect" with the PIDs), waits for the memory, and always runs `start` again when the
deployment ends or fails. Idle keep-alive connections count as clients: close them on the calling side.

## 6. Security in one paragraph

Ed25519 node identity, signed enrollment with a one-time code, nonce-signed channel auth. Engines bind
127.0.0.1. The agent's TLS data listener (:47801) is the only exposed socket: client certificates are
pinned by fingerprint to enrolled identities and only ports of running assignments are reachable.
Anything else travels over the outbound control channel and is relayed when no direct path exists.


## 7. Refreshing the three rig installations

Build and stage first; apply only after the local AI is idle and the operator has
acquired the maintenance window. Use `flashnext-maintenance.sh` to stop/restore
production. A quiet token counter alone does not establish idle: verify processing
requests and foreign clients too. Do not run real inference or deliberately restart
control while other clients use the local AI.

1. From the intended final source revision, build the Mac release with
   `SWARMLET_ENGINE_DIST=/Users/lotar/projects/ai-mesh/swarmlet/engine/dist/darwin CARGO_TARGET_DIR=/Users/lotar/projects/ai-mesh/swarmlet/node-shell/src-tauri/target swarmlet/node-shell/scripts/build-release.sh`.
   The native Cargo cache is reused; only two build jobs run by default.
2. Stage the same source tree on Legion 1, with its native prebuilt engine
   `/home/lotar/swarmlet-engine/dist/linux`, then run
   `SWARMLET_ENGINE_DIST=/home/lotar/swarmlet-engine/dist/linux swarmlet/node-shell/scripts/build-release.sh`.
   Reuse the existing `/home/lotar/swarmlet-shell` Cargo target directory if present,
   using an absolute `CARGO_TARGET_DIR`. Alternatively compile Linux's agent on the
   Mac and transfer `dist/agent/linux` intact, then use `--reuse-agent` on Linux.
3. Before application, save the existing agent executable, GUI package/app, service
   definition and `~/.swarmlet/node.json` in a dated private rollback directory on
   each host. Never overwrite identities, offers, enrollment, models, or externals.
4. Copy the canonical binary from `dist/agent/<os>/swarmlet-node` to a sibling
   temporary file at the service's existing stable path, preserve executable mode,
   then rename it into place. Current paths: Mac
   `/Users/lotar/projects/ai-mesh/swarmlet/dist/agent/darwin/swarmlet-node`; both
   Legions `/home/lotar/swarmlet/swarmlet-node`. Install the corresponding
   `agent-build.json` beside it. Copy the Mac engine to the service's sibling
   `engine/` and keep the Legions' engine at
   `/home/lotar/swarmlet-engine/dist/linux`. Update **only** `enginePath` in each
   `node.json` to that stable absolute directory. Do not point a service at a GUI
   bundle, staging worktree, or transient AppImage mount.
5. Replace `/Applications/Swarmlet Node.app` on the Mac with the staged native app;
   install the **same** refreshed `.deb` on Legion 1 and Legion 2 using
   `sudo dpkg -i swarmlet-node_0.1.0_amd64.deb`. Package installation supplies the
   GUI and `/usr/bin/swarmlet-node`; the existing systemd service still uses its
   stable `/home/lotar/swarmlet/swarmlet-node` path. Close an old GUI instance before
   replacing its files. Restart agents in the coordinated maintenance window;
   the shell must attach to the service instead of launching another agent.
6. Compare SHA-256 for the canonical artifact, installed service executable and
   GUI sidecar (Mac `Contents/MacOS/swarmlet-node`, Linux `/usr/bin/swarmlet-node`).
   Verify each against `agent-build.json.sha256`; do not accept a GUI merely
   attaching successfully as proof it contains the current agent. Native signing
   may change Mach-O metadata: if packaging changes the Mac sidecar bytes, make
   that final packaged sidecar the canonical installed service artifact and record
   its final hash in the release evidence. Check engine checksums in each stable
   directory and `/api/status` on each node; verify three online nodes in control.
7. Run real three-node inference, disconnect/reconnect and control-restart
   acceptance. Confirm production restoration even if an acceptance check fails.
   If rollout fails, restore the saved agent, app/package, config and service
   definition, restart only the affected agent, and recheck its status and
   production health. Do not re-enroll nodes as part of an update.

These are an operator-controlled refresh and rollback procedure, not auto-update.
The source manifest labels uncommitted builds `-dirty`; the binary SHA-256 is the
exact artifact identity. Record final source status and all three installed hashes
with the acceptance evidence.
