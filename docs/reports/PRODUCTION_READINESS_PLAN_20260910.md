REQUIREMENTS
- Windows node installed and working | Lotar | keep: current fleet excludes Windows.
- macOS/Windows/Linux autostart and automatic updates | Lotar | keep: unattended production operation requires both.
- Controller broadcasts and nodes automatically register | Lotar | keep: removes manual enrollment; private-LAN TOFU, sharing off, retained controller binding.
- Every node displays the full model catalog and prevents unavailable inference | Lotar | keep: current ready-only list conceals unavailable models.
- Live E2E before completion | Lotar | keep: native lifecycle and network failures evade unit tests.
DELETED
- Separate model-fit rules: delete; reuse actual planner.
- Separate registration identity system: delete; reuse signed enrollment and persisted identity.
- OS/firmware update management: unowned, delete; updates cover Swarmlet only.
- Replacement GUI/service manager: delete; retain native services and current node UI. A minimal stable update launcher may need adding back for safe process replacement.
SIMPLIFIED
- Extend authenticated model endpoint with opt-in catalog metadata; preserve ordinary SDK ready-model semantics.
- Existing native installers remain service owners. Side-by-side signed releases preserve a rollback target.
ACCELERATED
- Native Windows CPU engine is building while independent controller/UI work proceeds.
AUTOMATED
- Automate full catalog/eligibility now. Discovery uses private-LAN TOFU with sharing off by default. Update installation follows signature, rollback, and OS lifecycle proofs.
SCOPE
- Complete the requested fleet installation, lifecycle, discovery, model availability and live E2E; no unrelated host service changes.

GOAL / DONE-WHEN: four real nodes connect automatically, show full catalog with honest availability, survive service restart, and install a verified release automatically with rollback tested. Native shell and inference paths exercised before any production-ready claim.
CURRENT STATE (updated 2026-09-10): all four real nodes are online under the stable service supervisor and have automatically activated signed releases 2026091001 and 2026091002. Final Mac, Windows NSIS and Linux DEB packages are built. Catalog, LAN discovery, controller RTT, network rates, capability-based fan telemetry and signed updates are implemented and exercised on the fleet. Mac fan authentication, a Mac visual check while unlocked, physical reboot/login checks, and FlashNext memory remain unresolved.
PREMISE CHECK: model catalog and discovery are missing. Autostart exists at login; boot-before-login semantics differ by OS. Tauri autostart uses package name, so hypothesized identifier collision is refuted by installed crate source.
STEPS:
1. Windows engine and power verification -> real build exit, manifest hashes and binary --version; keep-awake -Verify.
2. Catalog from profiles plus routing, local eligibility from planDeployment -> bun tests for planner refusals, authenticated catalog, stale/offline UI; browser model selection.
3. LAN discovery and registration under agreed trust -> real UDP across machines, fresh identity autojoin, reject untrusted/forwarded enrollment, persist identity across restart.
4. Signed updater and native service integration -> invalid signature/hash/replay, rollback, interrupted transaction; two real versioned releases on all OSes.
5. Install exact artifacts and E2E -> live service/process hashes, catalog and chat API/browser/native checks; autostart and update evidence.
RISKS / NON-GOALS: updates cannot interrupt in-flight inference or lose deployment intent; Windows low memory cannot be treated as valid local model capacity; no unrelated Docker restart without pending approval.
ASSUMPTIONS: private-LAN TOFU with sharing initially off; local eligibility shown separately from selectable ready mesh routes. These defaults were communicated after optional questions went unanswered.
PRE-MORTEM: passing code tests while untested native startup/update fails on Windows. Mitigation: real OS actions and exact artifact checks before completion.

2026-09-10 continuation: Windows native engine, service installation, UDP autojoin and real mesh chat passed. Catalog, discovery, RTT and network telemetry implemented; native GUI rebuild, signed updater, final fleet E2E remain. Lotar also requires dynamically detected fan maximum and detailed stats: retain capability-based providers and explicit unsupported states; delete machine-model tables and unsupported vendor register writes. Linux recovery now journals originals across repeated max requests and hotplug, serializes privileged mutations, rejects unsafe journal paths, and discards stale boot state; seven fake-hwmon recovery tests pass. No privileged helper installed or fan writes performed yet.

2026-09-10 signed-update validation:
- `bun run typecheck && bun test protocol control node-agent`: 299 pass, 0 fail, 3733 expectations, 14.99 seconds after the Windows logging change.
- A compiled-process integration test publishes a signed release over HTTP, activates it, rolls back an unhealthy successor, then kills the supervisor during another activation and verifies the previous release returns with the replay floor retained.
- Real fleet release 2026091001 activated automatically on Mac 30f05a2670c368d0, Windows 01f78366eb893349, Linux 19d7c8f75e54726a and Linux 6474b864aaf6fa5d. Linux downloads use their existing controller tunnel with enrolled-node signatures. The 2B mesh returned to ready after rolling activation.
- Mac install originally failed with launchd EIO 5. The identical plist passed plutil and registered once the previous job finished unloading. Bounded retry was added; the original installer then succeeded and the new agent connected.
- Windows log probe: long-lived Add-Content pipeline made a temporary log unreadable; per-line writes remained readable. Source now closes the log between lines. The live Windows wrapper was refreshed; the original Get-Content read succeeds while the service runs.
- Existing failed FlashNext intent no longer prevents all updates. The controller waits for recovery of deployments affected by its last update and preserves pre-existing failure state. A before/after regression reproduced null lease before the fix and passed afterward.

Review status: DO NOT claim final production readiness until the remaining acceptance checks below finish.
Correctness — native launchd race fixed and reproduced; local and controller inference admission both guard updates.
Contracts — normal /v1/models stays ready-only; node-agent/ui/chat.js consumes opt-in catalog fields. Supervisor consumes signed release and lease endpoints; native service installers call supervise.
Data safety — no schema migration or model deletion. Failed downloads remove only their own temporary directory. Release cleanup removes generated obsolete release directories while retaining active/previous/pending. Publication rejects an existing sequence, preserves earlier payloads and atomically replaces only the feed pointer. Node configuration pin migration saved backups. Privileged helper installation overwrites only the named helper and exact-command sudoers rule; Mac authentication remains pending.
Time — signed UTC epoch milliseconds, bounded clock tolerance, expiration and persisted monotonic sequence. POSIX file and directory fsync; Windows file flush and atomic rename (no directory fsync API).
Concurrency — one fleet update lease, routes withdrawn synchronously, local streams drain through completion/cancellation, deployment recovery precedes the next update, and source build output is isolated from running executables.
Security — enrolled-node signatures protect software downloads even through the public tunnel; only the pinned controller can sign executable inventories and update grants. No HTTP publishing API. Flat inventories reject traversal, Windows aliases and case collisions. No signing private keys are distributed.
Tests — successful signatures, tampering, replay, expiry, invalid paths, corruption, truncation, interrupted streams, native compiled process rollback and local stream admission exercised; actual OS failure checks and final release acceptance tracked separately.
Simplicity — existing Ed25519 identities, native services, inference stream hooks and planner reused. No new package manager, archive extractor, OS updater or machine-specific fan tables.

Remaining acceptance:
- Isolated native supervisor rollback/crash proofs now pass on Linux (Bun 1.3.14) and Windows (both 1.4.2 and shipping 1.3.14). Windows uses the real local shutdown API because its SIGTERM kill is unconditional; exit-code-zero assertion is retained. The actual installed Windows task also exited 0 through /api/shutdown and restarted successfully.
- Final release 2026091002 activated automatically on all four nodes. Active process paths, every release file size and SHA-256, and package agent hashes match: Mac 10 files, Linux 7 per host, Windows 6.
- Final desktop packages built; Mac app installed in ~/Applications, Windows NSIS installed and its service re-registered, Linux DEB extracted into ~/.local/opt/swarmlet-node/20260910 with a user desktop launcher. Native Windows and Linux screenshots verified; Mac app process and signature verified, but the locked desktop prevents visual inspection. The system-wide Linux package is unchanged because sudo authentication is unavailable.
- Complete Mac administrator authentication, then verify maximum fan targets/RPM and restore behavior. Both current Linux hosts and Windows expose no supported generic writable fan controls; this must remain explicit, never simulated.
- Native autostart registration and service restarts are verified; physical OS reboot/login-trigger testing has not been performed.
- FlashNext remains blocked by the existing memory requirement. Do not restart unrelated Docker workloads without the outstanding authorization.

Windows signal behavior reference: [official Node process documentation](https://nodejs.org/api/process.html#signal-events); verified against the real Windows runtime. The Linux packaging staging archive initially contained AppleDouble `._default.json` (magic 00051607); normal default.json parsed correctly. Removing 58 generated metadata files from the isolated staging directory allowed the native DEB build to finish successfully.

Final Mac package integrity correction: bundle metadata originally matched the pre-sign agent 0d074b799195dc34ccd3716226911fed97553f4b91749fa7ea95c5a544a85f28, while the signed executable was aa44ad2d4142a5bcf795564d948be250a155c2b123765ce4f9d5ea80a06579a4. build-release.sh now updates both manifests and re-seals only the outer app. Native rebuild completed in 37.26 seconds, codesign deep/strict verification passed, and bundled/service bytes plus both manifests match the signed hash. Engine bytes remained unchanged.


Final fleet acceptance (2026-09-10 11:48 UTC):
- `python3 /tmp/swarmlet-production-acceptance.py` -> `PASS: 4/4 online; 4/4 chat endpoints; full catalogs; live RTT/network/fan status; distributed 2B ready`. Each real node's local OpenAI endpoint returned HTTP 200 and FLEET_OK. The Mac serves locally; Windows and both Linux nodes use the mesh. All three catalog entries are present everywhere; both unavailable models are unselectable.
- Final Windows browser chat returned FINAL_WINDOWS_OK, with processing attributed to the Mac and both Linux workers. The UI disabled sending during a rolling restart and recovered on catalog refresh. A fresh browser reload after rollout reported `(no console errors)`; earlier expected disconnect/503 errors occurred during service replacement.
- LaunchAgent is running on Mac; both Linux systemd units are enabled/active with Linger=yes; the Windows scheduled task is Running. This proves registration and restart behavior, not a physical boot test.
- Exact final agent hashes: darwin aa44ad2d4142a5bcf795564d948be250a155c2b123765ce4f9d5ea80a06579a4; linux 160cf73024a6c71dd2eadefc46f03e405acbb4742b0d3bd6c7c8b71ae7b5e03a; windows dd200aaf8d6825a3d3987c5e2e1480be872696216c2022b624ae77fd3df19acd.
- Evidence (local, not committed): ~/.swarmlet/backups/production-final-20260910 contains runtime/file audits, four chat responses, live fleet telemetry and native/browser screenshots. Packages are in swarmlet/dist/shell/{darwin,linux,windows}.
- Overall status remains partial: the Mac helper authentication prompt is pending, current Linux/Windows drivers expose no supported maximum-fan control, and FlashNext is not serving because its memory fit remains unresolved. No unrelated Docker workloads were restarted.


Mac fan compatibility follow-up (2026-09-10 14:27 UTC):
- Administrator installation completed and the unlocked native Mac window rendered correctly. The initial live FanManager max/restore proof then failed with `write Ftst=1 failed: SMC firmware error: 132`; both fans remained automatic.
- Discriminating read-only probe: Ftst and F0Md/F1Md returned firmware error 132, while F0md/F1md read 0. Thus the helper's unconditional unlock-key requirement excludes this firmware. This agrees with the upstream [ThermalForge capability report](https://github.com/ProducerGuy/ThermalForge/issues/23).
- Lotar owns the requirement: maximum cooling on supported hardware. Kept runtime capability detection; deleted the unconditional Ftst requirement; retained the existing unlock order when the key exists. No machine-model table or new daemon. The canonical AppleSMC backend now distinguishes missing keys from other firmware errors, and FanController conditionally uses Ftst in both maximum and automatic paths.
- Regression command: `swiftc swarmlet/node-agent/native-fans/darwin/{FanController,FanKeys,SMCBackend}.swift swarmlet/node-agent/native-fans/darwin/test/main.swift -o /tmp/swarmlet-fan-probe/controller-tests && /tmp/swarmlet-fan-probe/controller-tests` -> `PASS: legacy and absent-key maximum/restore; read and write failures remain closed`.
- Review: correctness, contracts, data safety, timing, concurrency, security, tests and simplicity clean for this diff. JSON consumers in fans.ts are unchanged; only a confirmed missing key skips the unlock, and permission/transport errors still propagate. Both restore paths are exercised.
- Native package rebuilt successfully in 44.19 seconds. Corrected helper bytes match the canonical agent directory and signed app bundle. The running fleet remains on release 2026091002; this helper correction has NOT been published yet.
- The corrected privileged-helper installation now awaits the visible macOS administrator prompt. Physical maximum/restore verification and node-startup maximum verification remain pending; do not claim the fan issue resolved until `bun /tmp/swarmlet-fan-live-proof.ts` and the subsequent service-start telemetry pass.


Mac sustained cooling and registration follow-up:
- The optional-key correction installed successfully, but the real test then exposed a second failure: `write F0Tg did not stick: expected 5349, got 1350`. A subsequent timing capture showed manual mode with a replaced target; no third-party fan controller was running. A one-shot target write does not maintain maximum cooling on this firmware.
- Scope scrub: Lotar owns maximum cooling while a node runs. Keep actual RPM feedback and automatic restoration; delete a separate permanent daemon, socket, arbitrary target commands, and machine-specific tables. Extend the existing helper with a pipe-owned `hold` command. Only the existing maximum/automatic operations touch firmware; fixed heartbeats keep ownership alive. EOF, SIGTERM, malformed input, and a 10-second heartbeat timeout restore automatic control. An exited helper is retried by the node after 30 seconds.
- Original live reproduction now passes: `bun /tmp/swarmlet-fan-live-proof.ts` -> `PASS: actual fan maximum and automatic restoration verified`. Fan 1 measured 5347 RPM against max 5349; Fan 2 measured 5765 against max 5777, both manual with exact maximum targets. Stop verified both modes returned to automatic.
- Six real child-process tests cover normal stop, watchdog expiry, malformed input, owner SIGKILL, helper SIGTERM, and permission rejection. A Bun disturbed-stream issue found during these tests was corrected in the canonical lease wrapper. Final `bun run typecheck && bun test protocol control node-agent`: 305 pass, 0 fail, 3746 expectations, 16.28 seconds.
- Review: correctness/contract/security/time/concurrency/data-safety/tests/simplicity clean. JSON metrics remain unchanged; the root command accepts only fixed ping lines, exposes no command/target arguments, and retains the installed root-owned helper boundary. No unrelated services were stopped.
- Windows report investigated against both endpoints and the controller UI: LAPTOP-PPN32FP0 / 01f78366eb893349 is registered and online. Reinstalling its existing service changed PID 7232 to 12428, reconnected without a join code, preserved node identity, and resumed release 2026091002. All four nodes appear online in the controller screenshot. Windows resource sharing is disabled, so it is absent from the selected model's processing participants; the user was asked which view appeared unregistered.
- Corrected held helper installed and verified SHA-256 2bc2a4cb871567edab5178d8964b2e4054afd308fd1301a42b6fa0895690c572. Final agent/package rollout and installed-node sustained RPM verification follow.
