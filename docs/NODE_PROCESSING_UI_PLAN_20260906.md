# Node workspace and shared response processing

## Requirements

| Requirement | Owner | Decision |
|---|---|---|
| Node apps match the existing web workspace | Lotar | Keep: current dark horizontal node UI differs from the light web sidebar. |
| Show nodes processing a chat and how much | Lotar | Keep: use the actual serving deployment from response headers and its assigned layers. |
| TPS and percentage | Lotar | Keep: response TPS from stream deltas (estimate), final server timing when supplied. Percentage means assigned layer share pending clarification; it is not elapsed answer progress or measured compute time. |
| Match processing on web | Lotar | Keep: one shared panel and data contract for both clients. |

## Deleted

No second framework, telemetry socket, public admin endpoint, or synthetic completion percentage. Remove the node-only dark skin in favor of the existing web stylesheet. Keep detailed web topology as an expandable diagnostic below the shared panel; individual diagnostics may move back into the default view if testing shows they are needed.

## Simplified / accelerated / automated

Reuse the existing embedded UI servers, API-key gate, model routing and web tokens. One keyed `/v1/mesh` read endpoint exports only serving-node display metrics, never secrets, paths or addresses; localhost proxies it with the enrolled node key. One shared browser component polls every two seconds only when visible, scopes updates to the current response and rejects stale results. Automate metric/selection/auth/staleness tests after this scope; preserve real runtime smoke checks.

## Current state and done-when

Verified live deployment `dep-65bedf5278d1`: Mac MTL0 18 layers, both Legion CUDA0 workers 3 each, state ready. Host metrics arrive roughly every two seconds; workers have no independent decoder TPS. Runtime chain: node main → inference/localapi → ui/ui.ts; control main → server → ui/ui.ts + router. Both UIs embed distinct CSS today. Existing node chat is plain SSE with no processing panel; web shows detailed deployment topology.

Done when redesigned node screens use the web shell and tokens, both chat panels show the same actual serving nodes, accurate layer percentages and response TPS through send/stop/error/offline states; binaries and native packages installed on all three machines; public dashboard stays closed and keyed API continues working.

## Steps and validation

1. Sanitized telemetry contract and local forwarding → `bun test control/test/processing.test.ts node-agent/test/inference.test.ts` plus control access matrix.
2. Shared processing panel, response accounting and node shell redesign → shared component tests, existing chat tests, `bun run typecheck`.
3. Render web and node at desktop/narrow sizes, exercise send/stop/models/errors → permitted browser tool only. Currently admin-policy verification unavailable; report this gate unverified if it persists.
4. Build isolated release, install services and native payloads at idle, verify hashes → real `/v1/mesh` reads and SDK streams on all three local endpoints/public endpoint, all nodes connected.

## Design brief

Swiss workspace archetype: grid alignment and quiet light surfaces, green signal accent, local Avenir/Segoe fonts intentionally inherited from the web reference. DNA rhythm2 edge2 motion1 density3 contrast4 texture1. Reuse web tokens. Mutations: wide conversational surface with a narrow live contribution rail; a single segmented layer-share strip instead of three equally weighted summary cards; diagnostics collapsed beneath the response evidence. Native settings remain fully functional and become visually consistent. No decorative imagery required.

## Risks / pre-mortem

Layer share is allocation, not measured compute or portions of answer text. Label it explicitly. Never assign per-worker token ownership. Response throughput derived from delta events stays marked estimated until engine timings arrive. A switched model or a late telemetry response must not relabel an in-flight reply; freeze final reply summary and use fresh host-metric timestamps. No node keys, admin APIs, physical screen settings or production8099 restart changes. Existing browser policy prevents screenshots; do not bypass it. A failed final visual gate means partial verification, not completed acceptance.

## Review and verification

- Correctness: corrected completed-reply pin loss during model refresh; regression test covers it. Stream completion now requires `[DONE]`; web and node errors/stops stay distinct from completion.
- Contracts: `/v1/mesh` consumed by the shared processing component through node `inference.ts` or the control key gate. Sanitized display projection only; no SDK model/chat schema change.
- Data safety: no database migration or data deletion. Release installations use backups and staged atomic binary replacement.
- Time: host metrics use UTC timestamps with a 10-second freshness bound; response rates use a monotonic client clock. Final server timing supersedes stream estimates.
- Staleness/concurrency: aborted and superseded requests cannot replace a newer deployment; hidden views do not poll; final response summary stays pinned; selectors disabled during generation. Panel updates capped at five per second while streaming.
- Security: public telemetry requires an inference key; admin/dashboard restrictions remain unchanged. Participant response contains names and display metrics, no addresses, model paths, keys, assignment commands or raw registry rows. DOM uses textContent.
- Tests: layer shares, stale/offline suppression, payload projection, model/pin validation, local telemetry preference, caller credential stripping, late-result races, response rate semantics and stop states covered.
- Simplicity: one shared component and stylesheet serve both chats. Node app imports the existing web workspace stylesheet; its own stylesheet contains node-specific layout only.

Browser visual acceptance remains unverified: the permitted tool rejected the web reference URL because it could not verify the admin-enforced policy. No alternate rendering automation was used.
