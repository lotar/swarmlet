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
API client: pick a served model, type, Enter. Each reply shows the server's own timing (tok/s, prompt and completion
tokens, time to first token), which node and deployment served it, and a running session average. "Thinking"
toggles the model's reasoning mode. The **Nodes** tab (`#nodes`) has a tok/s column: every agent reports the
generation rate of its local llama-server (coordinator, replica, or the external production server) over the last
heartbeat interval, so the number moves while a reply streams and drops to 0.0 when idle.

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
