# Participant chat rollout — 2026-09-05

Status: functionality deployed and real inference verified; native packages installed on all three machines. Rendered chat verification remains pending.

## Legion desktop-package installation follow-up

Both staged `2db2e7e9` Debian packages were installed successfully with `sudo dpkg -i` after the user supplied the required credential. On each Legion, `/usr/bin/swarmlet-node`, `/home/lotar/swarmlet/swarmlet-node` and `/proc/<MainPID>/exe` now have SHA256 `42edefd57ce3cdf947e4d56d37eb76dc4365c5e513b00d556f00a9c49f36a862`. `dpkg --verify swarmlet-node` reports no differences. Both services remained active with unchanged PIDs, both local `/v1/models` endpoints returned `qwen3.5-2b` with `route: mesh` and `mesh_available: true`, and all three nodes remained online through Cloudflare with the mesh deployment ready. Evidence: `~/.swarmlet/backups/node-chat-2db2e7e9/legion-package-install.json`.

The browser access retry after installation was again denied because the admin-enforced policy could not be verified. No browser workaround was used. The earlier sections below retain historical rollout evidence; package installation is no longer a blocker.

Final-state change at17:29UTC: the mesh coordinator received SIGKILL and recovered automatically by17:29:56. Production8099 subsequently has no listener and its LaunchAgent is unloaded; the external deployment is correctly excluded from routing. The earlier smoke tests below observed production healthy. None of this rollout's operations unloaded that LaunchAgent; the cause/intent of the later stop is unverified. The user was asked whether to leave production stopped or restore it. The three-node2B model remains ready.

Feature revision: `05f9730d48f7ac236e36b9aabb0729cee03eb634`. Packaging follow-up: `f3f8f82` seals locally built macOS bundles with an ad-hoc signature. Branch: `feat/control-dashboard-redesign`.

## Strict SDK compatibility follow-up

Revision `2db2e7e91e15295caac960ee7b34bece258df1b0` is now installed in all three running services and the Mac app. The OpenAI Python SDK3.8.0 with strict response validation found a missing required `created` integer in `/v1/models`. Control now reports the earliest ready deployment's registration timestamp; local models use their node assignment registration timestamp, and remote entries preserve control's timestamp. Legacy control entries without a timestamp use0 to signal unknown metadata.

`uv run --with openai==3.8.0 python /tmp/swarmlet-sdk-check.py` passed model listing and real streaming on Mac (`local`), Legion1 (`mesh`), Legion2 (`mesh`) and the keyed public endpoint. All returned “SDK works.” The reproducible single-endpoint client is `swarmlet/e2e/tools/openai-client.py`.

New Linux service/package hash: `42edefd57ce3cdf947e4d56d37eb76dc4365c5e513b00d556f00a9c49f36a862`. New Mac signed sidecar hash prefix: `eeb2cb06159150f3`; package/service manifests now record the final signed bytes. New packages and evidence are under `~/.swarmlet/releases/node-chat-2db2e7e9` and `~/.swarmlet/backups/node-chat-2db2e7e9`. Canonical `swarmlet/dist/agent` and `swarmlet/dist/shell` artifacts were refreshed. Linux system-package replacement and rendered UI checks remain pending; the original rollout evidence below is historical where hashes differ.

Validation after the metadata fix:135 runtime tests,622 expectations;6 simulated E2E tests,62 expectations. Mac package `codesign --verify --deep --strict` and signed service/package hash agreement passed. Public unauthorized/admin401, keyed200 and private dashboard/admin404 matrix passed again.

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
| Updated native payloads | Mac app/service installed and matching; both Linux Debian packages installed, with packaged, service and running binary hashes matching the latest release. | Passed |

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

1. Legion system-package installation and hash verification are complete; see the follow-up above.
2. Use the permitted browser tool to inspect node Chat, send/stop a reply, select a model and check desktop/narrow layouts. Attempts against preview47810 and installed47800 were rejected because the tool could not verify its admin-enforced policy. No alternative browser automation was used to bypass that restriction.
3. Resolve the production8099 stop intent with the user. `sin-harness/scripts/flashnext-maintenance.sh status` confirms unloaded/down; if restoration is requested, use the same script with `start`. Do not undo an intentional stop from another session.
4. Repeat final health and source/package checks after those finishing steps, then close the goal. Do not claim complete from the API and asset checks alone.
