# Swarmlet product surface

The packaged form of the mesh: a **node agent** with a GUI for machine owners, and a **control plane**
that keeps the registry, plans placements, runs deployments and routes OpenAI-compatible requests.
Design: [`docs/NODE_APPS_CONTROL_PLANE_20260904.md`](../docs/NODE_APPS_CONTROL_PLANE_20260904.md).

```text
protocol/      shared types, validators, Ed25519 identity helpers, binary stream mux (zero deps)
control/       control plane: config, SQLite registry, enrollment, agent channel + relay, planner,
               deployments, OpenAI router, web UI (control/ui)
node-agent/    daemon + CLI: identity, probes, offer, enforcement, roles (worker/coordinator/replica),
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

## Tests

```bash
bun run typecheck && bun test protocol control node-agent   # unit + in-process integration
bun test e2e                                                  # control + two agents + fake engine, full loop
```

## Binaries

```bash
engine/build.sh darwin|linux          # engine (see engine/README.md)
bun run node-agent/build.ts           # dist/agent/<target>/swarmlet-node (+ engine/)
```

## Security model (short)

Node identity = Ed25519 key; enrollment is a signed request with a one-time join code; the agent channel
is authenticated by a nonce signature. Engine processes bind 127.0.0.1 only. The only exposed socket is
the agent's TLS data listener; peers must present a client certificate whose fingerprint control listed
for the current assignment (pinning, not CA validation: certificates are self-signed and bound to the
node by the signed enrollment), and may only reach ports of running assignments. Everything else goes
through the outbound control channel, relayed when no direct path exists.
