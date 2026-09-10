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
release sequence and process ID. Native shell/bootstrap replacement and privileged fan-provider
installation remain installer operations; the automatic feed updates the agent, web UI, and engines.

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
