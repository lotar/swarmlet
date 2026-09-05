# Participant chat rollout — 2026-09-05

Status: functionality deployed and real inference verified; native Linux system-package replacement and rendered chat verification remain pending.

Final-state change at17:29UTC: the mesh coordinator received SIGKILL and recovered automatically by17:29:56. Production8099 subsequently has no listener and its LaunchAgent is unloaded; the external deployment is correctly excluded from routing. The earlier smoke tests below observed production healthy. None of this rollout's operations unloaded that LaunchAgent; the cause/intent of the later stop is unverified. The user was asked whether to leave production stopped or restore it. The three-node2B model remains ready.

Feature revision: `05f9730d48f7ac236e36b9aabb0729cee03eb634`. Packaging follow-up: `f3f8f82` seals locally built macOS bundles with an ad-hoc signature. Branch: `feat/control-dashboard-redesign`.

## Verified behavior

| Requirement | Evidence | State |
|---|---|---|
| Public inference protected by API keys | Actual Cloudflare `/v1/models`: no key, invalid key and admin token each401; participant key200. Real public streamed reply: “Key protected API works.” | Passed |
| Dashboard and admin remain private | Public `/`, `/api/nodes` and `/probe/ip`404, including calls with valid credentials. | Passed |
| Enrolled participants receive access | Signed welcome provisions a distinct stable key per node. Tests verify distinct credentials; both Legion local APIs successfully authenticate to the public API. Key absent from local status and chat assets. | Passed |
| Local OpenAI-compatible endpoints | `http://127.0.0.1:47800/v1` on all three machines; models and real streamed chat verified. Forwarders support chat/completions, completions and embeddings when supported by the engine. | Passed |
| Prefer a local model server | Mac response `x-swarmlet-route: local`; both Legion responses `mesh`. Unit test proves local inference makes zero control requests. | Passed |
| Three-node model accessible to participants | Each local endpoint used `dep-65bedf5278d1` and returned “Participant chat works.” Mac3.71s, Legion1 3.57s, Legion2 3.56s. These are smoke-test times, not a comparative latency benchmark. | Passed |
| Cancellation releases work | Real Legion1 request closed after4 SSE events; router inflight0 and both coordinator slots idle. Unit test verifies upstream disconnect and no replay. | Passed |
| Chat implementation available on each node | All three live `/chat.js` assets match source SHA256 `8f494c77ae639cadfff63e401e44db68a4c7932b93e005615d43aabefa30da8a`. Chat includes models, stream, stop, new chat, local history, errors and API example. SSE rendering uses textContent and has parser tests. | Deployed; rendered UI unverified |
| Updated native payloads | Mac app/service installed and matching; Linux running service binaries updated and checked against `/proc/<pid>/exe`. Linux deb built and staged on both machines, but `/usr/bin/swarmlet-node` still belongs to the previous system package. | Partial |

## Validation

- `cd swarmlet && bun run typecheck && bun test protocol control node-agent`:135 pass,0 fail,621 expectations.
- `cd swarmlet && bun test e2e`:6 pass,0 fail,60 expectations. Includes real in-process coordinator and worker localhost inference calls.
- `python3 /tmp/verify-sw-node-chat-public.py`: public authorization matrix.
- `python3 /tmp/verify-sw-node-chat-rig.py`: real replies on all three machines, matching served chat assets, all three internet channels and both deployments ready; production8099 healthy.
- `python3 /tmp/verify-sw-node-chat-public-reply.py`: real keyed public generation.
- `codesign --verify --deep --strict ~/Applications/'Swarmlet Node.app'`: passed after adding an ad-hoc resource seal. This is a local build, not Developer ID/notarization.

Private evidence and backups: `~/.swarmlet/backups/node-chat-05f9730d/`. Built release: `~/.swarmlet/releases/node-chat-05f9730d/`. Updated installers also staged under `swarmlet/dist/shell/darwin` and `swarmlet/dist/shell/linux`.

Installed Mac sidecar/service SHA256: `fe2ecb020d582341` prefix (full hash in private mac-install.json). Installed/running Linux services: `35bcb4cedd82622477233fb87d31d68041820ed5ae1fbfcd69af07904f945a51`. Previous system-package sidecar on both Legions: `5d8be2c0ef7e86e74bc7d97c89132da49e9269d374b9c6029c5abaa07f56a0e0`.

## Remaining

1. Install the staged deb on both Legions using the existing sudo-password-file workflow. Passwordless sudo is unavailable; the file path was requested. Then compare `/usr/bin/swarmlet-node`, the service binary and `/proc/<MainPID>/exe` to the new Linux hash. Existing desktop apps already attach to the updated service; their packaged fallback sidecars still need replacement.
2. Use the permitted browser tool to inspect node Chat, send/stop a reply, select a model and check desktop/narrow layouts. Attempts against preview47810 and installed47800 were rejected because the tool could not verify its admin-enforced policy. No alternative browser automation was used to bypass that restriction.
3. Resolve the production8099 stop intent with the user. `sin-harness/scripts/flashnext-maintenance.sh status` confirms unloaded/down; if restoration is requested, use the same script with `start`. Do not undo an intentional stop from another session.
4. Repeat final health and source/package checks after those finishing steps, then close the goal. Do not claim complete from the API and asset checks alone.
