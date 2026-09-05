# Three-node reliability acceptance — 2026-09-05

**Result: passed.** Mac, Legion 1 and Legion 2 run refreshed native node packages. The standing 2B internet-relay mesh is ready, the external Flash-Next production service is restored and healthy, and control sees all three nodes online.

Runtime release: `e6690822824f800125e8fd3a867f81021270e89c`. Acceptance operator: `a9fd21c` (only the audit operator and its tests changed after the runtime release). Five subagent lanes completed implementation/review; follow-up review cleared each amendment.

## Verified behavior

The final real run completed from 12:52:58 to 12:57:23 UTC, using the actual Mac coordinator and both Legion GPU workers through the internet relay. Qwen3.5-2B used the existing 3/3/18 layer split, context 4096 and two slots. Existing identities, enrollment and resource offers were retained.

| Check | Result | Recorded timing |
|---|---|---|
| Initial three-node generation | Passed | Ready wait 18.08 s; request 6.44 s |
| Pause Legion 1 agent while keeping its worker alive | Passed: offline route withdrawn, worker confirmed alive, old assignments replaced | Offline detected in 30.13 s; pause lasted 45.83 s |
| Reconnect paused agent | Passed: automatic recovery and generation | Ready wait after resume 18.07 s; request 6.07 s |
| Stop/start Legion 1 node service | Passed: automatic recovery and generation | Ready wait after service start 22.09 s; request 6.00 s |
| Restart control service | Passed: all nodes reconnect, stale relay assignments replaced, generation restored | Node reconnect wait 2.01 s, then ready wait 25.12 s; request 6.17 s |
| Intentional deployment stop | Passed: zero managed engines/listening ports, no automatic resurrection | Stayed stopped 66.12 s |
| Explicit restart and final generation | Passed | Ready wait 17.08 s; request 6.90 s |
| Final OS process/port audit | Passed | Exactly three managed engine processes, one per node; no errors |
| Production restoration | Passed | `CHECK_OK`, health=ok, `PRODUCTION_RESTORED` |

All five routed generation requests returned generated output. The successful run needed **zero audit retries**. No claim is made that an individual in-flight inference request survives a broken relay; serving recovers automatically.

## Source and validation

Recovery adds durable running intent, reconciliation after node/control interruption, cleanup acknowledgement before port reuse, retired-assignment handling, bounded retry, and intentional-stop persistence. Agent cleanup waits for asynchronous startup, retains external-service restoration obligations, and verifies process birth identities before signalling.

Metrics deduplicate external endpoint watches, keep per-endpoint counter baselines, distinguish stale/unknown/active/idle samples, and release routed inflight counts on completion/error/cancel. Live browser verification saw one direct production request shown as **“1 active · decode rate unavailable”** in control and **“active · decode rate unavailable”** in the node UI. Idle was shown as **“idle at engine sample”**, and only one production watch remains.

- `cd swarmlet && bun run typecheck && bun test protocol control node-agent` → `119 pass`, `0 fail`, `469 expect() calls`.
- `cd swarmlet && bun test e2e` → `6 pass`, `0 fail`, including actual simulated agent disconnect and persisted control restart.
- `python3 -m unittest discover -s swarmlet/e2e -p 'test_*.py'` → `Ran 22 tests`, `OK`.
- Native Mac `.app` and Linux `.deb` builds passed; engine checksums passed.
- Final verifier command below → `FINAL_ACCEPTANCE_OK: 3 online nodes; mesh ready; 1 external watch; installed/running hashes match; production healthy`.

## Installed artifacts

| Machine | App/package | Service agent |
|---|---|---|
| Mac | `/Users/lotar/Applications/Swarmlet Node.app` | `/Users/lotar/projects/ai-mesh/swarmlet/dist/agent/darwin/swarmlet-node` |
| Legion 1, 192.168.1.243 | `swarmlet-node` Debian package, `/usr/bin/swarmlet-node-shell` | `/home/lotar/swarmlet/swarmlet-node` |
| Legion 2, 192.168.1.220 | Same Debian package | `/home/lotar/swarmlet/swarmlet-node` |

Mac engine resources now use the stable `/Users/lotar/.swarmlet/runtime/engine` directory. Each service matches the agent bundled with its GUI. Linux running executable hashes were also read through `/proc/<MainPID>/exe` and matched both installed copies.

- Mac agent SHA-256: `2c696f46991e386506411b82f25c0653823870e8df6b4a35e4f3b2285ec098d1`.
- Linux agent SHA-256: `5d8be2c0ef7e86e74bc7d97c89132da49e9269d374b9c6029c5abaa07f56a0e0`.
- Linux installer SHA-256: `bd35d6a3adfabbd97aef51ec48b100689a6c0a2da6cf9fe68a7ccf9e50b9c819`.

Persistent installer copies are under `swarmlet/dist/shell/darwin/Swarmlet Node.app` and `swarmlet/dist/shell/linux/swarmlet-node_0.1.0_amd64.deb` in the live checkout. Native app windows were not visually inspected; the shared installed node UI and monitoring webapp were checked in Chrome. Signing/notarization, DMG/AppImage and a 104 GB three-node benchmark are outside this acceptance scope.

## Evidence and replay

Private evidence directory: `/Users/lotar/.swarmlet/backups/20260905T121826Z`.

- `refresh.json`: completed installation steps and artifact hashes; its original combined run has success=false because the first real audit timed out.
- `real-faults.json`: original partial real run and timeout, with no cleanup errors.
- `real-faults-retry.json`: complete successful run, success=true and cleanupErrors=[].
- `acceptance.json`: consolidated final live verification of the installed release and successful rerun.
- `verify-current.py`: read-only live verification (uses the existing local control credential internally).
- `/private/tmp/swarmlet-reliability-window.log`: all maintenance attempts and restoration outcomes.

Read-only final verification:

```sh
python3 /Users/lotar/.swarmlet/backups/20260905T121826Z/verify-current.py
```

Real fault acceptance must remain inside `idle-window.py`; do not invoke it directly against active production. The wrapper requires zero active/deferred/routed requests and unchanged token count for 60 seconds, then the existing connected-client/ownership guard. It restores production in finally.

## Issues found and closed during execution

1. Cold Metal device enumeration took 43–59 seconds, exceeding the old 30-second integration-test deadline. A process sample located the wait in Metal shader compilation. The test now uses the runtime probe's existing 90-second budget plus overhead and additionally rejects GPU fallback, retaining device/hash assertions.
2. Fresh native builds lacked the shared signing source and a tracked frontend splash. The archive now includes the exact shared module; the original splash is tracked under `node-shell/frontend` and referenced by Tauri.
3. Tauri emits a Debian filename using `productName`; staging now derives that input name and retains the stable published installer filename.
4. A real read-only SSH audit timed out. Rerunning that probe took 1.06 s. Audit sampling now records bounded stage failures and allows one complete fresh retry for timeouts/disappearance only; topology failures and signal operations never retry.
5. The process audit could count periodic `--list-devices` probes as orphan servers. It now records them separately only with exact probe arguments, the current agent as parent, no listening ports, and no expected assignment match. Real server/orphan assertions remain strict.

No required implementation or acceptance work remains for this scope.
