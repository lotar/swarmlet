> Historical work log. See [final fleet and hosted acceptance](FLEET_ACCEPTANCE_20260910.md) for the current deployed state.

# Windows takeover and mesh recovery — 2026-09-10

Status: partial. Lotar transferred Pi's paused Windows work to Codex. The existing
three-node 2B mesh is serving again. Windows access and Flash-Next recovery remain
blocked as described below; native Windows acceptance is not claimed.

## Requirements

| Requirement | Owner | Keep/drop and reason |
|---|---|---|
| Take over Windows setup, desktop shell, power settings and mesh acceptance | Lotar | Keep; the Windows node has never completed live acceptance |
| Recover usable mesh chat and Flash-Next | Lotar | Keep; initially neither managed deployment served requests |
| Use Ninja for the Windows engine build | UNOWNED | Drop; it requires a developer environment absent from ordinary SSH sessions |
| Duplicate UI or service implementation | UNOWNED | Drop; reuse Pi's existing cross-platform implementation |
| Restart unrelated Docker jobs without coordination | UNOWNED | Drop; a Docker restart would interrupt active benchmark jobs and other apps |

Deleted: Ninja selection and its bootstrap installation. It can be reconsidered
if measured Windows build times justify managing a developer environment.
Simplified: use the Visual Studio 2022 x64 generator, matching the toolchain
bootstrap. Accelerated: check configuration and script parsing without waiting
for laptop access. Automated: existing component tests and guarded inference
checks only; deployment automation waits for working access.

Scope: complete the existing Windows node and restore mesh inference. No new
model architecture, UI, service manager or relaxed memory admission is added.

## Current state and plan

The controller API initially showed three online nodes (Mac and two Legions), no
Windows node, failed `flashnext-mesh`, and stopped `mesh-2b-internet`.
`laptop-ppn32fp0.home` resolves to `192.168.1.188`. TCP probes of ports 22, 3389,
445, 5985, 5986, 5900, 47800 and 47801 all timed out. These observations cannot
establish the Windows firewall profile, service state or whether it is asleep.
The LAN bootstrap URL returns HTTP 200 and matches the local script's SHA-256.

1. Establish Windows access: run the existing elevated `go.ps1` bootstrap on the
   laptop, then verify `ssh winbox whoami` and `keep-awake.ps1 -Verify`.
2. Build the engine and shell: run `engine/build.ps1` and
   `node-shell/scripts/build-release.ps1`, then verify executable hashes.
3. Enroll Windows and stage the 2B model: verify `probe`, controller node status,
   and the model SHA-256 listed in the Windows node document.
4. Verify Windows replica/split inference, shell behavior and service restart
   using the existing go-live checklist. A compiler or planner check alone is
   insufficient.
5. Recover Flash-Next once host RAM fits: stop the temporary 2B fallback, start
   the saved Flash deployment, and verify a routed API request and web chat.

Risk/pre-mortem: starting Flash while below the fit requirement would repeat the
failure; bypassing admission could force swapping. Restarting Docker would
interrupt other projects. Both Windows remote access and a Docker maintenance
decision were requested from Lotar while independent work continued.

## Symptoms and discriminating evidence

| Hypothesis | Check | Result |
|---|---|---|
| Windows is available through another management service | Probe SSH, RDP, SMB, WinRM, VNC and Swarmlet ports; inspect Tailscale peers | No reachable management endpoint; no Windows Tailscale peer |
| Flash failed solely because workers remain offline | Query node states and deployment events | All three nodes online; latest retry failed RAM admission |
| The current relay/controller cannot serve any model | Start the existing 2B deployment and issue routed API and browser requests | Both returned `mesh ready` |
| Docker cache release alone returns enough RAM to macOS | Drop clean guest caches once, then compare guest free memory and VM physical footprint | Guest free memory rose from about 5.5 to 20 GiB; VM footprint remained 28.3 GiB, host fit remained below 76,016 MiB |
| Ninja can be selected merely because its command exists | Execute the build script's generator selection in PowerShell with Ninja present and no MSVC developer environment | Before: `-G Ninja`; configuration precondition probe failed |

Flash timeline: a Legion disconnect at 16:38 UTC on September 9 recovered to
READY at 16:41:22. A Mac disconnect at 16:46:33 triggered another recovery cycle;
subsequent RAM admission failures exhausted the retry budget. The final recorded
failure was `66012 MiB free, need 76016; no external service to stop`. These events
identify the load blocker, not the underlying reason for every disconnect.

## Applied changes and proof

`swarmlet/engine/build.ps1` now selects `-G "Visual Studio 17 2022" -A x64`.
The served `~/Desktop/winbox-ssh/bootstrap-toolchain.ps1` no longer installs or
reports Ninja. This is the canonical engine configuration path; the shell build
continues to consume its existing `bin/Release` output and manifests.

The same PowerShell configuration probe after the change printed:

```text
Selected generator arguments: -G Visual Studio 17 2022 -A x64
MSVC developer environment loaded: False
GENERATOR_CHECK_OK
```

All six PowerShell scripts parsed successfully. This probe exercises generator
selection; it does not compile native code. CMake documents that command-line
generators require a configured compiler environment, while Visual Studio
generators discover the installed toolchain:
[generator documentation](https://cmake.org/cmake/help/latest/manual/cmake-generators.7.html),
[Visual Studio 2022](https://cmake.org/cmake/help/latest/generator/Visual%20Studio%2017%202022.html).

`bun run typecheck` passed. The selected Windows, TLS and planner checks printed
`59 pass`, `0 fail`, `442 expect() calls`.

The existing 2B deployment was started under `idle-window.py --allow-stopped`
after 60 seconds of observed quiet, holding the shared mesh operation lock. All
three assignments became ready/listening. A request to `/v1/chat/completions`
pinned to `dep-65bedf5278d1` returned `mesh ready` with the expected deployment and
Mac coordinator response headers. The web chat independently returned the same
text, selected the three-node deployment, and recorded no console exceptions.
The 2B deployment remains running as the usable fallback.

The one-time guest cache operation stopped no containers, changed no Docker
memory setting, and did not solve host RAM admission. A snapshot of the current
Docker memory setting and running-container identities was prepared for a
possible coordinated restart; that restart has not been approved or performed.

Private evidence and the pre-change bootstrap copy are under
`~/.swarmlet/backups/windows-takeover-20260910/`.

## Review

Verdict: configuration correction is ready; native Windows release acceptance
remains pending. No claim that the Windows node is operational.

| Lens | Result |
|---|---|
| Correctness | Clean: generator and x64 target match the installed-toolchain recipe and Windows agent target |
| Contracts | Clean: deliverable names/manifests unchanged; `build-release.ps1` consumes them, and engine build already collects `bin/Release` |
| Data safety | Clean: no data deletion; bootstrap copy backed up; settings unchanged; repeat cache release is nondestructive but not scheduled |
| Time | Clean: no scheduling or timestamp behavior changed |
| Staleness/concurrency | Clean within changed scope: Pi paused; an existing Ninja CMake cache would fail visibly instead of being silently deleted |
| Security | Clean: no auth, firewall or key-policy relaxation; temporary browser login material removed after the check |
| Tests | Configuration probe and parsing pass; native MSVC/CUDA compilation and Windows runtime explicitly unverified |
| Simplicity | Clean: removed generator branching and one installation dependency; no new build abstraction or duplicate UI |

Remaining checks: Windows bootstrap/SSH, actual Windows engine and shell build,
model hash, enrollment, inference and restart acceptance; enough Mac RAM followed
by successful Flash-Next API and web-chat requests.
