# Swarmlet product surface

The packaged form of the mesh: a **node agent** with a GUI for machine owners, and a **control plane**
that keeps the registry, plans placements, runs deployments and routes OpenAI-compatible requests.
Design: [`docs/NODE_APPS_CONTROL_PLANE_20260904.md`](../docs/NODE_APPS_CONTROL_PLANE_20260904.md).

```text
protocol/      shared types, validators, Ed25519 identity helpers, binary stream mux (zero deps)
control/       control plane: config, SQLite registry, enrollment, agent channel + relay, planner,
               deployments, OpenAI router, web UI (control/ui)
node-agent/    daemon + CLI: identity, probes, offer, enforcement, roles (worker/coordinator/replica/stage),
               TLS data listener + dialer, local web UI (node-agent/ui), service install
node-shell/    Tauri v2 desktop shell (window + tray + autostart) around the agent's local UI
engine/        patched llama.cpp build (ggml-rpc-server, llama-server, llama-ring-bench)
e2e/           fake engine + end-to-end test of the whole loop on one machine
```

## Run from source

```bash
cd swarmlet && bun install
bun run control                                   # http://127.0.0.1:47900 ; admin token in ~/.swarmlet/control/control.json
bun run agent                                     # daemon; local UI http://127.0.0.1:47800
bun run node-agent/main.ts join http://<control>:47900 <JOIN-CODE>   # code from the control UI (Nodes > New join code)
```

Set the offer in the local UI (Resources tab: 0–100% GPU memory, RAM, CPU and free disk, with exact amounts shown; 100% RAM excludes the OS reserve and CPU rounds down to whole cores) or `bun run node-agent/main.ts offer set enabled=true roles.worker=true gpu.cuda:0=3072 ramMiB=8192 cpuCores=6`.
Create a deployment in the control UI (Deployments > New), preview the plan, start it, then:

```bash
curl -s http://127.0.0.1:47900/v1/chat/completions -H "Authorization: Bearer <api key>" \
  -d '{"model":"qwen3.8-flash-next","messages":[{"role":"user","content":"hello"}]}'
```

## Placement and execution options

The deployment API accepts `POST /api/deployments/plan-preview` with a deployment
spec, then `POST /api/deployments` and `POST /api/deployments/<id>/start`.
Use the control admin token for these operations.

- **Exact asymmetric placement:** a `split` spec can pair ordered `workerNodeIds`
  with `workerLayers`, for example `[2,3]`. `coordinatorNodeId` selects the node
  holding the remaining blocks. The plan distinguishes transformer-block counts
  from native tensor weights, whose final device also holds the output layer.
  Automatic placement retains its historical weight semantics.
- **Replicas and pools:** create one `replica` deployment per selected
  `replicaNodeId`. Ready deployments serving the same model form a pool in the
  existing router. `x-swarmlet-deployment` pins an individual deployment.
- **Speculation:** `speculation: {"type":"ngram-simple"}` enables verified ngram
  draft/accept decoding on `split` or `replica`. It requires no additional model
  and cannot be combined with an MTP chain.
- **Resident stages and prefill/decode:** `stages` and `prefill-decode` use the
  native worker and controller-owned qualification records. See
  [native example specs](e2e/native-rig-cases.example.json) for the explicit node,
  artifact path/hash and stage-interval fields. Admission requires an exact
  qualified artifact/binary combination; request JSON cannot bypass it.

After staging native artifacts, rescan models through each node's owner interface
(`POST /api/models/rescan`) to populate its verified inventory. Hashes persist
across restart and offer refresh when file metadata is unchanged. Replaced or
changed files require another rescan; workers verify the actual file before load.

Native execution initially supports Qwen3.5-2B Q8_0, context 1024, one active
request per deployment, greedy text generation and 1–128 output tokens. Both
`/v1/completions` and text-only `/v1/chat/completions` support streaming and JSON
responses. Unsupported sampling, tool, image and template options are rejected.
A busy native deployment returns 429. Cancellation resets its resident contexts;
failed cleanup withdraws the route and recovery creates fresh contexts. Raw native
worker ports are private implementation endpoints, not OpenAI servers.

Physical acceptance and outstanding gates are recorded in the
[placement/execution report](../docs/reports/PLACEMENT_EXECUTION_PLAN_20260909.md).

### Direct paths and the relay fallback

A placement names every address a peer published, plus a relay flag. The node agent opens a local port
per RPC endpoint and tries, in order: a reverse stream the peer offered, each direct address (private
IPs first so a LAN pair stays on the LAN, then a public IP, then a NAT mapping), and finally the control
relay. The path chosen is remembered per endpoint, and the assignment's ready detail names it
(`rpc0=direct`, `rpc0=relay`).

Direct is a preference, not a requirement: the planner orders direct peers first by RTT and lists
relayed ones after them with a reason, and a split plans with no direct endpoint anywhere. See
`docs/HOST_CONTROL_PLANE.md` for the measurement and for why a relayed RPC is safe now when it was not
before.

### Model weights live on the nodes

Control never carries weights. A profile declares `download.files[]` (URL, bytes, sha256) and the
catalog surfaces it for a node that lacks them; the node fetches on its owner's confirmation and
re-hashes what lands. The planner refuses to place a model a node does not hold.

## Allocate hardware across deployments

Open **Allocation** in the control web UI. Select deployments and a hardware pool,
then recommend a balanced allocation. Each deployment can keep its current nodes
or use manually assigned model/worker nodes and qualified worker layer counts.
An optional CPU budget applies per node; RAM and GPU reservations come from the
model profile with headroom. **Create deployment** here saves a workload without
starting it so several workloads can be planned together.

Review the proposed placements, budgets and reasons, then **Apply and run**.
Applying reloads the selected workloads and starts selected stopped workloads.
Active requests, stale previews, missing agents and capacity changes block
admission. Cleanup must be acknowledged before capacity is reused. Progress is
stored on the controller and survives browser reloads; interrupted or partially
failed runs show their per-deployment outcomes.

Recommendations balance model availability, memory pressure, CPU sharing,
GPU placement, contention and measured controller RTT. They are bounded
heuristics, not a guarantee of maximum tokens per second. GPU memory is reserved
in the scheduler; GPU compute is shared. OS enforcement remains platform-specific.
External services and qualified native stage placements stay fixed. Old agents
must update before participating in shared budgets. Search and pagination support
large inventories; large planning jobs run outside the controller request thread.

The authenticated admin API uses `GET /api/fleet`, `POST /api/fleet/preview`
(`items: [{deploymentId, mode: "balanced" | "keep" | "manual", cpuCores?, placement?}]`
and `poolNodeIds`), `POST /api/fleet/<previewId>/apply`, and
`GET /api/fleet/<runId>`. Previews expire after ten minutes. Repeating an accepted
apply returns its existing run. The API accepts at most 500 workloads and 2,000
pool nodes per request, with a 20-second planning timeout.

## Tests

```bash
bun run typecheck && bun test protocol control node-agent   # unit, HTTP and compiled-process integration
bun test e2e                                                  # control + two agents + fake engine, full loop
```

## Binaries

```bash
engine/build.sh darwin|linux          # engine (see engine/README.md)
engine/build.ps1                      # engine on Windows (MSVC, CPU; -Cuda / -Vulkan optional)
bun run node-agent/build.ts [darwin] [linux] [windows]   # dist/agent/<target>/swarmlet-node[.exe] (+ engine/)
```

The Windows node (agent, scheduled-task service, Mica desktop shell, NSIS installer) is described in
[docs/WINDOWS_NODE_20260909.md](../docs/WINDOWS_NODE_20260909.md).

## Services and signed updates

Run `swarmlet-node install` to register the stable supervisor with launchd, systemd --user, or
Windows Task Scheduler. macOS and Windows start it at login; Linux enables linger for operation
after logout. `swarmlet-node uninstall` removes the service. Build into a separate directory with
`SWARMLET_AGENT_DIST=/path/to/staging` when the current executable is still serving requests.

Enrolled nodes check their controller after 30 seconds, then every five minutes. A release must
match the OS/architecture and carry a newer sequence signed by the pinned controller key. Downloads
are authenticated by the enrolled node, including through a controller tunnel. Every file is length
and SHA-256 checked before activation. The controller grants one idle update window at a time; local
inference must also finish. Active and previous releases remain separate, and failed health checks
or interrupted activation select the previous release without lowering the replay floor.

After building the final native bundle, publish its exact agent directory on the controller host:

```bash
bun run control/publish-release.ts /path/to/control-data dist/agent/darwin darwin arm64 2026091001 0.1.0-release1
# Linux: dist/agent/linux linux x64; Windows: dist/agent/windows win32 x64
```

The command uses the controller's existing signing key and refuses to overwrite a sequence.
Keep that private key on the controller. Existing installations without `controlPubJwk` need their
existing controller identity pinned through trusted enrollment before updates are enabled.
The supervisor's update messages appear in the normal service log; `/api/status` reports the active
release sequence and process ID. The automatic feed updates the supervised agent, web UI and engines.
On macOS, a packaged signed release also replaces an existing app at
`~/Applications/Swarmlet Node.app` or `/Applications/Swarmlet Node.app`; it does not install a GUI
on headless nodes. Open web UI pages refresh when their activity and saved drafts allow it;
already-running native shell code takes effect after the app is reopened.

Unattended updates require the installed service supervisor. Opening the desktop app alone starts
an unsupervised `run` sidecar. The bootstrap executable pinned by the OS service is intentionally
separate from the signed child releases: publishing a child does **not** update supervisor code.
Supervisor fixes require an operator to replace the stable service executable and restart it in an
owned maintenance window, then verify its hash separately from the active child's release/hash.
See the [bootstrap refresh procedure](../docs/HOW_TO_NODE_APP.md#supervisor-bootstrap-refresh).
Linux/Windows native shell replacement and privileged fan-provider installation remain installer
operations. Mac build scripts seal apps with ad-hoc signing by default, honor a configured signing
identity, and do not perform notarization. Release-manifest signing is a separate trust mechanism.

Fan telemetry detects exposed OS/driver capabilities. The bundled macOS SMC and Linux hwmon
providers request maximum cooling through an administrator-installed helper; the one-time installer
is `node-agent/native-fans/install-root.sh <user> <built-helper>`. Normal shutdown restores control.
On macOS the helper maintains the maximum while the node sends heartbeats over its child-process
pipe; node exit, a closed pipe, or a 10-second heartbeat timeout restores automatic control.
Firmware keys are detected at runtime, including systems without the optional SMC unlock key.
Missing permission and unsupported firmware/drivers are shown explicitly. Windows monitoring can
read LibreHardwareMonitor sensors when available; it does not claim a generic writable fan control.

## Security model (short)

Node identity = Ed25519 key; enrollment is a signed request with a one-time join code, or automatic
enrollment on a direct private LAN when enabled. LAN discovery uses trust on first use and initially
keeps resource sharing off. Set `SWARMLET_LAN_AUTO_ENROLL=0` on control to require manual enrollment.
An already bound node retains its controller. The agent channel is authenticated by a nonce signature.
Engine processes bind 127.0.0.1 only. Peers connecting to the agent's TLS data listener must present a
client certificate whose fingerprint control listed for the current assignment (pinning, not CA
validation: certificates are self-signed and bound to the node by signed enrollment). Those peers
may only reach ports of running assignments. Everything else goes
through the outbound control channel, relayed when no direct path exists.

## Automatic re-placement when nodes come and go

A deployment is not a property of the machines it happened to start on. When a node leaves, the model is
still servable by whatever is left, so the control re-plans onto the best remaining nodes instead of
declaring the deployment failed; when a node arrives, it asks the same question in reverse.

- **A node leaves.** `onOffline` - and a departing agent, which fails its own assignments on the way out -
  withdraws the route and starts the reconnect grace. If the node returns inside the grace nothing moves.
  When the grace expires, `redistribute()` re-plans the spec against the nodes present and starts it.
- **A node arrives.** `onNodeOnline` asks whether the nodes here now would place the deployment better. It
  moves only for a material gain: at least `moveMarginLayers` (2) fewer layers on the serving node, or a
  coordinator with >=25% more offered RAM. It also respects `moveSettleMs` (60 s of stability) and
  `moveIntervalMs` (10 min between moves), because every move costs an engine reload.
- **A move that cannot start costs nothing.** The node whose assignment failed is dropped, remembered for
  ten minutes (`moveExcluded`, consulted by `plan()`), and the move is tried again without it. That is what
  keeps a failed move from turning into a failed deployment - including for the recovery that follows,
  which would otherwise walk straight back into the node it just bounced off.
- **Pinned specs never move.** If the spec names its coordinator/workers, or is a replica, stages,
  prefill-decode or external deployment, the placement is the owner's and control refuses, recording
  `placement is pinned, not moving`.
- **Starts tolerate cleanup they cannot prove; stops do not.** A node that leaves mid-teardown can never
  acknowledge its stop, and waiting for that made deployments permanently unrestartable. Starts proceed and
  the assignment is retired (`agent confirmed assignment absent` / `will be stopped on reconnect`); an
  explicit Stop still proves what it reports and still refuses to claim success it does not have.
- **No viable placement fails loudly**, with the planner's reason attached rather than limping along.

Every step is written to the deployment's events (`re-placing after …`, `<host> joined; … fits better
there`, `re-placement did not start … re-placing without …`). The deployments table shows the last
placement change inline; the drawer lists the deployment's placement history.

Measured on the live rig (auto-placed 2B split, one Mac coordinator and two Linux workers):

| stage | placement | answer |
|---|---|---|
| before | `3/3/18` on legion > legion-2 > M5 Max | `a120e6472d4d40cd` |
| legion stops (`systemctl --user stop swarmlet-node`) | route withdrawn, then `3/21` on legion-2 | `a120e6472d4d40cd` |
| a third node (M5 Pro) drops | re-placed again, without it | `a120e6472d4d40cd` |
| legion returns, cooldown elapsed | `… fits better there (21 -> 18 layers on the serving node)`, back to `3/3/18` | `a120e6472d4d40cd` |

**Known limitation:** a re-placement restarts the engine, so an in-flight request is dropped - there is no
drain step in front of a move yet. "On the fly" means automatic and unattended, not zero-downtime.

## Choosing the model automatically

A deployment can be asked for without naming a model: `profile: "auto"`. Control then answers the question
"what is the best thing these nodes can serve right now", and keeps answering it as the mesh changes.

- **Ranked, explicitly.** Each profile carries a `rank` (`flash-next` 40, `27B` 30, `35B-A3B` 25, `2B` 10).
  The order is the owner's judgement written down, not a number inferred from file size.
- **A whole-model replica is tried before a split**, per profile: no boundary traffic, no ring to cross.
  Only if no node can hold the model alone does a split get considered.
- **The planner decides feasibility, not the policy.** A model whose weights a node does not hold, or
  whose layers do not fit, is refused by the planner, so the choice can only land on something the nodes
  can really run.
- **What is free now, not what was offered.** The planner admits against the offer a node published - what
  it is willing to lend - while the agent's fit gate checks live free RAM. A machine running Docker, a
  browser and another model still advertises its whole GPU, so the automatic choice also checks the node's
  reported free memory against `layers × layerMiB + coordinatorHostMiB` before committing. The first time
  it ran without that check it picked a 110 GiB model on a machine with 65 GiB free and the fit gate killed
  it seconds later.
- **It re-decides when the mesh changes.** A node leaving or joining re-runs the choice: the model can be
  downgraded to what the survivors hold, or upgraded when a node arrives that makes a better one
  placeable. The chosen profile and kind are written back onto the spec, so the record always says what is
  really being served, and the deployment keeps its identity and history across the change.
- **No pointless restarts.** When the re-decision lands on the same model and the same nodes it does
  nothing - a restart costs an engine reload - and it says so instead: `already the best this mesh can
  serve`.

Every decision is in the events, including why a better-ranked model was passed over, e.g.

```
created mesh-auto (replica, automatic: qwen38-27b-q8 as replica
  (skipped: flash-next-ud-q4kxl needs 109952 MiB free on Lotars-MBP.home, which has 66758))
```

The deployments table marks automatic deployments (`· auto`) and the drawer explains the profile came from
the hardware online.
