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

Set the offer in the local UI (Resources tab) or `bun run node-agent/main.ts offer set enabled=true roles.worker=true gpu.cuda:0=3072 ramMiB=8192 cpuCores=6`.
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
bun run typecheck && bun test protocol control node-agent   # unit + in-process integration
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

## Security model (short)

Node identity = Ed25519 key; enrollment is a signed request with a one-time join code; the agent channel
is authenticated by a nonce signature. Engine processes bind 127.0.0.1 only. The only exposed socket is
the agent's TLS data listener; peers must present a client certificate whose fingerprint control listed
for the current assignment (pinning, not CA validation: certificates are self-signed and bound to the
node by the signed enrollment), and may only reach ports of running assignments. Everything else goes
through the outbound control channel, relayed when no direct path exists.
