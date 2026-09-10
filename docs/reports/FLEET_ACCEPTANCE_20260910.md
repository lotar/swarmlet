# Fleet acceptance — 10 September 2026

## Final deployed state

**Live:** [app.swarmlet.ai](https://app.swarmlet.ai). All four nodes run signed release **2026091006** and connect to the hosted controller over HTTPS/WSS with their original identities, signing pins and resource offers. The existing **Flash-Next three-node deployment is READY and serving**. The 2B deployment remains saved as a stopped fallback. The 2B/35B allocation matrix passed all eight cases, and the hosted update and four-gateway checks passed.

Remaining qualification limits: physical OS reboot/login-trigger tests were not performed; Linux/Windows fan control is unsupported by the current drivers; Windows local model inference is unavailable under its current disabled offer and absent model. These limits do not prevent its verified mesh chat.

## Result before hosted cutover

PASS for the supported model/allocation matrix: **8/8 cases, 16/16 responses**, each returning `ALLOCATION_OK`. All four original resource offers were restored, and the original three-node 2B deployment returned to READY with its saved `[3,3,18]` layer split. Cleanup errors: none.

At the local acceptance checkpoint, the four installed nodes ran signed release **2026091005**, source **5dc77f9f900deb6e1483508bad1a944229afcec2**, already pushed to `main`. Every active release file was checked against its signed inventory, and every running agent executable resolves to that release directory: Mac 10 files, each Linux node 7 files, Windows 6 files. All four nodes expose the three-entry model catalog.

This checkpoint preceded hosted cutover and the release-6 update test. Their completed results and the later Flash-Next recovery are recorded below.

## Actual allocation and response measurements

Caps below are **RAM MiB / CPU cores**. Percentages apply to each node's available offer ceiling; CPU values round down to whole cores. The distributed 2B tests use Linux worker layers `[2,2]` and 20 Mac layers, relay transport, context 1024 and one parallel slot. Replica tests use the same context and slot count. Each case launches a new deployment after applying its offer, waits for readiness and a fresh resource heartbeat, then issues two requests.

RSS is the maximum sampled node RSS during this short test, including the resident sample before requests. It excludes GPU allocation and is not a stress-test high-water guarantee. Response times include routing and completion; these short, fixed replies do not establish sustained throughput.

| Case | Offered cap MiB / cores | Sampled RSS MiB | Response seconds | Result |
|---|---|---|---|---|
| 2b-three-nodes-ram-25 | mac: 29696 / 4; linux1: 2949 / 3; linux2: 2812 / 4 | mac: 2295; linux1: 314; linux2: 327 | 3.08 / 2.20 | PASS |
| 35b-mac-ram-25 | mac: 29696 / 4 | mac: 19596 | 0.17 / 0.12 | PASS |
| 2b-three-nodes-ram-50 | mac: 59392 / 9; linux1: 5899 / 6; linux2: 5625 / 8 | mac: 2295; linux1: 322; linux2: 330 | 3.18 / 2.03 | PASS |
| 35b-mac-ram-50 | mac: 59392 / 9 | mac: 19881 | 0.19 / 0.14 | PASS |
| 2b-three-nodes-ram-100 | mac: 118784 / 18; linux1: 11798 / 12; linux2: 11251 / 16 | mac: 2298; linux1: 321; linux2: 330 | 2.65 / 5.74 | PASS |
| 35b-mac-ram-100 | mac: 118784 / 18 | mac: 19884 | 0.21 / 0.17 | PASS |
| 2b-linux1-ram-50 | linux1: 5899 / 6 | linux1: 944 | 0.17 / 0.14 | PASS |
| 2b-linux2-ram-50 | linux2: 5625 / 8 | linux2: 777 | 0.21 / 0.12 | PASS |

## Resource enforcement

Every case checks the actual assignment's enforcement details. Linux checks also read the live systemd scope's `MemoryMax`, `MemorySwapMax=0`, and `CPUQuotaPerSecUSec`, verifying the values against the requested offer. Replica process commands and Mac coordinator commands end with matching `-t` and `-tb` thread limits.

Linux uses cgroup memory and CPU limits. macOS and Windows use a five-second RSS watchdog; macOS CPU participation also uses the engine's thread count. This is not an instantaneous hard CPU percentage cap on macOS. Saving new resource values applies to the next deployment launch; running deployments are not resized.

The UI/API boundary checks saved and reread 0%, 25%, 50% and 100% on all four nodes with sharing disabled, then restored their offers. The earlier real-browser checks cover percentage/absolute edits, save/reload, unchanged-value preservation, and rejecting RAM beyond the OS reserve. Mac 100% is 118,784 MiB out of 131,072 MiB physical RAM, retaining 12,288 MiB for the OS. Enabled compute roles require at least one CPU core.

Two defects found during this qualification were corrected:

- The macOS/Windows RSS watchdog previously tolerated 10% above the offer. It now acts above the configured cap. A real allocating child reproduced the original failure and passed after the fix; the native Windows regression also passed.
- Owned replicas previously started without RAM/CPU enforcement, and serving recipes omitted CPU thread limits. Release 5 passes the owner offer through the existing enforcement path and adds thread limits after custom arguments. Regression checks cover actual launch arguments, zero-budget refusal, coordinator override ordering, and external-endpoint lifecycle behavior.

## Native installation and lifecycle

- **Mac:** updated, signed app installed in `~/Applications`; deep/strict signature verification passed. Its bundled agent matches the canonical signed service artifact. The native window has been visually checked during this session. The installed fan helper maintains maximum RPM while the node runs and restores automatic mode on owner exit, with live proof recorded in the readiness history.
- **Linux 1 and 2:** latest native DEB installed per user under `~/.local/opt/swarmlet/20260910-5`; desktop entries point there, and both native shell processes remained running. System-wide packages remain older because installation used the supported per-user location.
- **Windows:** latest native NSIS package installed; bundled agent hash matches its build manifest; the node scheduled task is Running. The newly opened native window rendered the model selector, availability explanation and retained chat history.
- **Automatic updates:** all four nodes activated signed release 5 through the updater. File inventories and actual process paths were audited after activation. Registered autostart and service restart behavior have prior live evidence. A physical reboot/login-trigger test was not performed.

## Models and hardware limits

- **Qwen3.5 2B Q8:** distributed operation and independent replicas on both Linux nodes passed.
- **Qwen3.6 35B A3B Q4_K_M:** Mac replica passed at 25%, 50% and 100%; the registered model file is 20,419,565,568 bytes. Sampled RSS approached 19.4 GiB.
- **Windows local inference:** not qualified. Its offer is disabled, replica role is disabled, and the model is absent; the catalog explains these conditions. Windows can use mesh inference, as verified in earlier four-node endpoint/browser tests. Its driver exposes no supported GPU/fan control interface.
- **Flash-Next at the local checkpoint:** runtime admission was blocked with 66,071 MiB free, below the existing 76,016 MiB requirement. Later, available RAM increased and the normal runtime gate admitted the existing deployment; the successful hosted recovery is detailed below. No unrelated Docker services were restarted to free memory.

## Executed evidence and retained failures

`bun run --cwd swarmlet test` after the resource fix:

```text
313 pass
0 fail
3824 expect() calls
Ran 313 tests across 42 files. [23.50s]
```

`python3 swarmlet/e2e/idle-window.py --allow-stopped --timeout 180 --quiet-seconds 60 --poll 10 -- python3 -I /tmp/swarmlet-resource-acceptance.py`:

```text
{"passed": 8, "failed": 0, "restored": true, "cleanupErrors": []}
```

The shipping hosted-controller image `swarmlet-control:5dc77f9` was built on the target server and booted in an isolated container. Its actual endpoints returned:

```text
PASS: shipping image public UI/health/admin/inference authentication 200,200,401,200,200
```

Earlier evidence remains intact: the first matrix suffered an operator Python import collision and a missing model registration; a subsequent functional 8/8 run exposed the missing replica caps and was not accepted as enforcement proof. An earlier full-suite run also had a supervisor timing failure; the unchanged isolated retry and subsequent complete suites passed. No assertions were weakened to obtain a pass. A truncated Linux package transfer in the final install attempt was rejected by extraction; the completed artifact was retransferred and both installations subsequently verified.

Private raw measurements: `~/.swarmlet/backups/resource-acceptance-20260910-03/result.json`. Earlier runs are in the sibling original and `-02` directories. Release audits are under `~/.swarmlet/backups/production-percentages-20260910/`; Windows release-5 audit and native screenshot are `/tmp/swarmlet-release5-windows-audit.json` and `/tmp/swarmlet-native-release5-windows.png`. Test logs are `/tmp/swarmlet-replica-limits-tests.log` and `/tmp/swarmlet-resource-acceptance-03.log`.

## Review

The resource-limit diff passed correctness, contracts, data safety, time, concurrency, security, test and simplicity review. Existing offers, process enforcement and recipe builders are reused; no new wire schema or policy store was introduced. The local API and startup validator remain the offer consumers. No unresolved source-review finding remains in that diff.

The completed hosted phase below verifies controller-key preservation, node identity/offer preservation, authenticated administration, real inference and a higher signed release.


## Hosted controller and public update qualification

The controller is deployed on the existing `the-shop` server at `46.225.53.158` as the separate `swarmlet-control` container, image `swarmlet-control:5dc77f9`. Its source is `/root/projects/swarmlet-control/releases/5dc77f9`; persistent data is `/root/projects/swarmlet-control/data`. Existing server applications retained their prior uptime and healthy states.

The old Mac controller and tunnel were stopped and disabled before the final SQLite/config/key copy. A complete copy-on-write backup, original node configurations and LaunchAgent definitions are saved under `~/.swarmlet/backups/host-cutover-20260910/`. The old local controller port remains closed. The signing key, admin credential, node IDs, offers and deployment records were preserved. Each node rejoined the public HTTPS/WSS address with its existing identity; subsequent checks compared the actual saved configurations and signing pins against the pre-cutover copies.

Actual public checks:

- `/health`: HTTP 200; container healthy.
- Anonymous `/api/nodes` and `/api/join-codes`: HTTP 401.
- Valid login: HTTP 303 with Secure, HttpOnly, SameSite=Strict cookie flags.
- Restored distributed 2B API request: `HOSTED_OK`.
- Browser chat: `HOSTED_BROWSER_OK`, attributed to the Mac and both Linux workers; 9.4 server-reported tok/s and 4,889 ms to first token for that five-token reply. A fresh authenticated reload had no console errors. The initial unauthenticated request correctly produced a 401.

Release **2026091006** was signed and published inside the hosted container. It intentionally contains the same payload bytes as release 5, with a new signed sequence, to prove public delivery and activation. All four nodes downloaded/verified/activated it through the normal updater without a forced update or service restart. The runtime audit verified every file and the actual executable path, followed by preserved-configuration checks and real requests through all four local gateways:

```text
PASS: 4/4 hosted release6 activations, signed inventories, stable identities/pins/offers, and gateway replies
```

The four `HOSTED_FLEET_OK` requests took 4.15 s (Mac), 2.81 s (Windows), 3.01 s (Linux 1), and 4.94 s (Linux 2). Release-6 inventories, replies and public node snapshots are in the cutover backup directory. Public browser screenshots are `/tmp/swarmlet-hosted-nodes.png` and `/tmp/swarmlet-hosted-chat.png`.

Cloudflare rejected the operator's default Python user-agent with error 1010; the normal Bun client and explicit `Swarmlet/0.1` user-agent returned HTTP 200. The operator was corrected without changing Cloudflare security settings. The existing idle guard now accepts `--control-url` so guarded operations query the hosted router. Its ten tests passed, including busy refusal and cleanup behavior; a real hosted `--allow-stopped --check` returned known zero counters. The local URL remains the default.

## Flash-Next recovery after cutover

The Mac later had 77,772 MiB free after stopping the 2B fallback. The existing `flashnext-mesh` deployment passed its unchanged runtime fit gate and loaded in approximately **91.8 seconds** from the first placement sample to READY. It uses the original `[1,1,46]` layer placement on the two Linux GPUs and Mac, context 1024, one parallel slot, no speculative chain, and relay transport through the hosted controller.

Two public requests returned `FLASH_RECOVERED` in **3.54 s** and **1.67 s**. Peak sampled Mac process RSS during loading was **59,961 MiB**; unified GPU allocation is not represented completely by process RSS. Then every node gateway returned `FLASH_FLEET_OK`: Mac 3.34 s, Windows 1.90 s, Linux 1 1.94 s, Linux 2 2.09 s.

```text
PASS: existing Flash-Next deployment restored over the hosted controller; 2B fallback remains stopped
PASS: Flash-Next answers through all four node gateways on hosted release6
```

The Flash-Next deployment remains running. The stopped 2B deployment is retained for fallback. No resource offers, model placement, OS reserve, or unrelated Docker configuration were changed for this recovery. Raw load samples and replies are under `~/.swarmlet/backups/hosted-flash-recovery-20260910/`.

The final hosted browser chat returned `FLASH_BROWSER_OK` with the correct three-node processing view, 5.3 server-reported tok/s and 3,116 ms to first token for that four-token reply. The browser console had no errors. Screenshot: `/tmp/swarmlet-hosted-flash-chat.png`.
