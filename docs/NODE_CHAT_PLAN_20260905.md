# Participant chat and local inference

Owner: Lotar. Goal: every installed node offers chat and an OpenAI-compatible localhost API for models served by the mesh; public inference remains available with API keys, while the dashboard/admin/probes stay private.

## Scope scrub and current state

- Keep participant chat, local API and keyed public API: dropping any loses an explicit requirement.
- Delete the need for another HTTP service/port, manual credential distribution, or a second frontend application. Extend the existing local server at 127.0.0.1:47800 and node UI.
- Simplify locality: a ready local coordinator/replica serves directly; a worker cannot decode alone and forwards via its configured internet control URL. No duplicate model loading.
- Accelerate with the existing signed enrollment channel, router and package refresh tooling.
- Automate behavioral tests after agreeing this scope, then install and verify all three machines.

Verified source: node-agent/main.ts wires AssignmentRunner and startLocalApi; localapi.ts currently serves settings/status only. control/server.ts blocks every public route except /agent. Registry already stores inference API keys; channel.ts sends welcome only after Ed25519 verification. Node UI is embedded into the agent binary and used by the native shell.

## Implementation and evidence

1. Public /v1 permits API keys only; public admin token/cookie cannot substitute. All other public restrictions preserved. Per-node key delivered only after signed channel authentication. Evidence: control/protocol tests and real public 401/200/404 matrix.
2. Local /v1/models merges local ready servers with the mesh list. Chat/completions, completions and embeddings stream to a matching local server first, otherwise mesh. No redirects or client-supplied upstreams, credentials stripped locally and replaced remotely; cancellation propagates; no automatic replay after a generation starts. Evidence: fake-engine integration tests for direct/fallback, streaming, cancellation, unknown/offline, credentials and local Host/Origin guard.
3. Node Chat tab: model selection, conversation, streaming, stop, new chat, errors and route indicator; local API URL and copyable client example. Reuse existing UI tokens and components; clear empty/offline/loading states. Evidence: source build, UI behavioral checks, rendered desktop/narrow views where browser access is available.
4. Rebuild/install updated agent and embedded native-app payloads on Mac and both Legions. Evidence: installed/running hashes, local endpoints and real streamed replies on each machine; direct Mac route and internet Legion routes; all nodes/deployments healthy afterward.
5. Public API verified using an inference key, no/invalid/admin credentials denied; public dashboard/admin still404. Documentation explains local endpoint, public keys and locality limits.

## Risks and non-goals

Keep external production LLM running. Perform agent/control restarts at router idle. No full-model download to workers, resource changes, new tunnel hostname, or public admin reopening. A local coordinator for a split model still needs its remote workers. Browser policy verification was unavailable during the previous task; retry legitimately, never bypass it. This does not waive UI verification from completion.

## Design brief

Add useful participant chat within the existing operator app, with a large readable conversation and compact model/route controls. Existing dark utility-console archetype; DNA rhythm2 edge3 motion1 density3 contrast4 texture1. Reuse tokens. Mutations: conversational body width within the denser settings app; restrained green route status; API example in a collapsible detail rather than another metrics grid. No provided reference URLs. Visual QA and accessibility review remain required.

## Completion audit

- [x] Public inference key gate deployed, admin/dashboard stay private.
- [x] Every enrolled participant obtains inference access without admin secret sharing.
- [x] Local API on all three nodes; direct local optimization proven and remote fallback proven.
- [ ] Chat streaming, stop, errors and model selection proven in node UI.
- [x] Updated installed services and native app payloads on all three machines.
- [x] Real three-node mesh replies through both Legion local endpoints and Mac direct endpoint.
- [ ] Documentation complete; final health verification pending production-stop intent and remaining install/UI checks.
