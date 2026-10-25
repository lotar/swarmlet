# Control test portability follow-up

PR #6 started at `f066a1d91f14ea174a968617d31570f6b8d4f4ad`; the main baseline is
`d3825ee0bb326ebb1f38b0656db9cc6f3aac8c9b`.
Command: `git rev-parse HEAD origin/main` before editing returned those two hashes.

## Baseline method and results

Fresh tracked archives of main and the original PR were extracted into separate task-owned
folders. Heavy work ran only through these commands:

```sh
ssh legion2 /home/lotar/locks/run-heavy.sh /home/lotar/swctl_verify1025/matrix.sh
ssh m1 /Users/lotar/locks/run-heavy.sh /Users/lotar/swctl_verify1025/matrix.sh
```

Each Linux cell used `bun install --frozen-lockfile`, `bun run typecheck`, and exactly
`bun test control node-agent protocol tools`. The native Mac cells used the original
`bun test --timeout 30000 control node-agent protocol tools`, with the same private Bun binary.
`bun --version` returned `1.4.4` in every cell. Main's current Dockerfile already says
`FROM oven/bun:1.4.4-slim`; we nevertheless tested both that tag and the PR digest separately.
The digest is `sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4`.
Targeted `docker image inspect <tag> <digest> --format '{{.Id}} {{.Architecture}}'` returned
that same image ID twice per host, with `amd64` on legion2 and `arm64` on M1.

The exact test-summary output (pass / skip / fail) was:

| Platform | main, current pin | main, PR digest/runtime | original PR |
| --- | --- | --- | --- |
| Linux amd64, legion2 | 502 / 9 / 9 | 502 / 9 / 9 | 501 / 9 / 10 |
| Linux arm64, M1 Docker | 502 / 9 / 9 | 502 / 9 / 9 | 502 / 9 / 9 |
| Native Mac arm64 | 518 / 1 / 1 | 518 / 1 / 1 | 518 / 1 / 1 |

Each cell reported `Ran 520 tests across 70 files.` Typecheck exited zero throughout.

Failure names were normalized by removing timing suffixes and deduplicating Bun's repeated
summary entries. A Python set comparison and independently `awk | sort -u` plus `cmp` agreed:

```text
m1 linux EXACT_FAILURE_SET_MATCH=True
m1 linux BRANCH_ONLY_FAILURES=[]
m1 native EXACT_FAILURE_SET_MATCH=True
m1 native BRANCH_ONLY_FAILURES=[]
legion2 linux EXACT_FAILURE_SET_MATCH=False
legion2 linux BRANCH_ONLY_FAILURES=['both age and allocated disk limits rotate oldest shards, including after restart and without new traffic']
```

The common Linux failure set was:

- NatMapper > advertises the mapped endpoint, with the listener port as the internal target
- NatMapper > never advertises a port the router did not accept
- NatMapper > stop() deletes the mapping and stops advertising it
- enforcement > linux wraps in a systemd-run scope with MemoryMax/CPUQuota; darwin returns a watchdog
- engine failure evidence survives cleanup and agent recreation
- live probes on this machine > probeMetrics reports rss of this process, free RAM and cpu
- loaded native identity mismatch never reports ready and stops the child
- matching native health from a wrong PID fails readiness
- stage assignment supervises a real CPU subprocess, keeps raw workers out of inference and clears capsule directory

Native Mac failed only the first NAT test. The historical empty RSS stop reason did not
reproduce in these baseline cells. It is not being described as fixed or assigned a speculative cause.

## Mechanisms and scope

`git diff origin/main -- swarmlet` was empty before editing. The original PR changed the
Docker digest and documentation, not the failing test code. The test import chains are:
`nat.test.ts -> nat.ts`, `recipes.test.ts -> enforce/index.ts`,
`stage-lifecycle.test.ts/assignment-logs.test.ts -> assignments.ts -> enforce/index.ts`, and
`probe.test.ts -> probe/index.ts -> host.ts`. Production enters NAT through
`node-agent/main.ts -> new NatMapper(...)`; there is no duplicate implementation.

NAT fixtures supplied an `en0` route but still read the real host interface. On Linux that
interface is absent; on Mac its actual address differs from the literal expectation. Add
`interfaceIpv4` to the existing dependency object and inject the interface/address in the
fixtures. Keep the exact endpoint/address assertions, add two injected-address cases, and cover
an interface with no IPv4 address. Production still uses the original lookup by default.

Host-tool guards use `Bun.which`: only absent executables cause skips, with an explicit reason
in the test name. Installed but broken tools still fail. Five managed-process tests require
`systemd-run` on Linux; the real RSS probe requires `ps` on POSIX (`tasklist` on Windows).
The fail-closed missing-systemd test and parser/unit tests still execute.

The additional amd64 telemetry failure said:

```text
(fail) both age and allocated disk limits rotate oldest shards, including after restart and without new traffic [5264.99ms]
  ^ this test timed out after 5000ms.
```

Native Linux main reproduced that timeout at `[5021.83ms]`; its full command returned
`507 pass`, `9 skip`, `4 fail` (telemetry plus three NAT tests). The first fixed native run
returned `511 pass`, `9 skip`, `1 fail`, with only telemetry timing out at `[5309.72ms]`.
The test performs real synchronous SQLite writes; it checks retention, not throughput.
The discriminating command `bun test --timeout 30000 control/test/telemetry.test.ts -t
'both age and allocated disk limits'` preserved every assertion and returned `1 pass`, `0 fail`
on main and the original branch in both the container and native Linux. Main container took
`[5254.42ms]`, branch container `[5175.21ms]`, and main native `[5106.66ms]`, all beyond the
old budget. Set an explicit 30-second budget on this one disk-backed retention test, matching
the native Mac command's budget. No retention assertions or fixture writes were removed.

## Recovery fixture race found during final verification

A subsequent arm64 Linux full run returned `505 pass`, `15 skip`, `1 fail`. The failure was:

```text
(fail) reconnected nodes cannot keep recovery loading forever without stop acknowledgements [43.94ms]
Expected: "failed"
Received: "loading"
```

The unchanged test used a fixed 25 ms sleep before one reconciliation tick. The real
`DeploymentManager.reconcile()` deliberately returns while teardown holds the deployment operation;
stop acknowledgements are awaited sequentially. `git diff origin/main --
swarmlet/control/deployments.ts swarmlet/control/test/recovery.test.ts` was empty before the fix.

The discriminating command was:

```sh
bun test --preload /src/delayed-timers.ts control/test/recovery.test.ts -t 'reconnected nodes cannot keep recovery loading forever'
```

The diagnostic preload delays only 5 ms `setTimeout` callbacks to 50 ms, simulating scheduler delay.
Both original main and original PR returned `0 pass`, `1 fail`, with the same expected/received
states. After the test-only correction, the identical diagnostic returned:

```text
(pass) reconnected nodes cannot keep recovery loading forever without stop acknowledgements [174.39ms]
1 pass
0 fail
RECOVERY_REGRESSION_FIXED_EXIT=0
```

Reuse the existing bounded polling helper with an async predicate that drives the real reconciler.
All failure-state, cleanup-reason, ownership, no-new-start and routing assertions remain intact.
The preload is only a diagnostic harness artifact; it is not part of production or the normal suite.

## Regression proof

In a separate extraction of origin/main, overlay only the new NAT test, retaining main's
implementation. Run the identical command against that tree and the fixed branch:

```sh
bun test node-agent/test/nat.test.ts -t 'uses the injected default interface address'
```

```text
REGRESSION_MAIN_EXIT=1
(fail) NatMapper > uses the injected default interface address instead of host interfaces
0 pass
1 fail
REGRESSION_FIXED_EXIT=0
(pass) NatMapper > uses the injected default interface address instead of host interfaces
1 pass
0 fail
```

This exercises the actual NatMapper implementation, not a reimplementation of it.

## Verification status

Final commands (after the recovery fixture correction):

```sh
ssh legion2 /home/lotar/locks/run-heavy.sh /home/lotar/swctl_verify1025/recovery-diagnose.sh
ssh m1 /Users/lotar/locks/run-heavy.sh /Users/lotar/swctl_verify1025/recovery-diagnose.sh
```

The scripts first ran the controlled recovery negative checks, then applied the same reviewed
test patch in the task-owned source tree and executed the following complete validations:

| Environment | Exact suite command | Output |
| --- | --- | --- |
| legion2 Linux amd64 pinned image | `bun test control node-agent protocol tools` | `506 pass`, `15 skip`, `0 fail` |
| M1 Linux arm64 pinned image | `bun test control node-agent protocol tools` | `506 pass`, `15 skip`, `0 fail` |
| legion2 native Linux, real systemd user scopes and ps | `bun test control node-agent protocol tools` | `512 pass`, `9 skip`, `0 fail` |
| M1 native Mac | `bun test --timeout 30000 control node-agent protocol tools` | `520 pass`, `1 skip`, `0 fail` |

Each reported `Ran 521 tests across 70 files.` `bun run typecheck` exited zero in all environments.
The slim-image skips include explicit absence reasons for five systemd-run tests and one ps test;
these same tests execute on native Linux, where `systemd-run --user --scope --quiet -- true`
returned `LINUX_SYSTEMD_SCOPE_EXIT=0`. Other Linux skips are the pre-existing Mac-only tests,
soft-watchdog test and shipped-engine probe. Native Mac skips only the unavailable shipped-engine probe.
No full-suite failures remain, and no assertions were removed (`REMOVED_ASSERTION_LINES=0`
from examining removed lines in `git diff --cached -U0 -- swarmlet`).

The new NAT regression returned `REGRESSION_MAIN_EXIT=1` / `0 pass` / `1 fail` and
`REGRESSION_FIXED_EXIT=0` / `1 pass` / `0 fail` in the final runs on both architectures.
The delayed recovery test also passed in the patched tree on both architectures.

`bun test node-agent/test/enforce-rss.test.ts` repeated five times on native Mac returned
`1 pass`, `0 fail` each time. The original real-process assertion remains unchanged. A separate
RSS sampler ran the actual watchdog against both the original and actively touched allocation
fixtures and returned `rss 138 MiB exceeds cap 132 MiB` and
`rss 143 MiB exceeds cap 137 MiB`. The historical empty-reason failure and its cause are still
UNVERIFIED because they did not reproduce; this report does not claim to have fixed that symptom.

### Real-container and browser E2E

The scripts built `deploy/control/Dockerfile`, started the actual control service with disposable
state, and ran:

```sh
docker compose -p swctlverify1025e2e -f e2e-compose.yml run --rm browser
# Browser container command:
npx playwright test browser.spec.cjs --workers=1 --reporter=line
```

Final output was `1 passed (2.1s)` on amd64 and `1 passed (1.4s)` on arm64. The browser exercised
wrong-token rejection, successful login using the test container's privately read token,
authenticated API access, Routing navigation and logout. Page-error assertions also passed.
No token was printed. Both actual control containers returned Bun `1.4.4`.

```sh
docker compose -p swctlverify1025e2e -f e2e-compose.yml logs --no-color control > control-docker.log
# Scan this private file for error/fatal/panic/uncaught/exception/segfault/OOM patterns.
```

Both runs returned `DOCKER_ERROR_SCAN=0 matches` and `E2E_EXIT=0`. The full suites also passed
the existing signed agent enrollment, two-agent connection and bit-exact relay integration tests.

Every task Compose project was torn down with `down -v --remove-orphans`. The final scripts
reported `CONTAINERS=0 VOLUMES=0 NETWORKS=0` for the matrix, fixed, E2E, native and telemetry
projects; the outer recovery project was removed by its exit trap. Test image tags were removed.

The initial harness attempts are not hidden: an unquoted tmpfs YAML value failed before startup;
a browser check incorrectly called native Fetch's `status` property as a function; an initial
native cleanup used a relative Compose path after changing directories. Those harness defects
were corrected, and the final E2E, suites and cleanup above passed.

A SHA-256 manifest over the repository's runtime/test source verifies that both tested trees
match the local code being committed:
`python3 check-source.py fixed code-manifest.json` returned
`CODE_MANIFEST_FILES=334` and `CODE_MANIFEST_MATCH=True` on each host.

### Shop runbook inspection and limitations

Read-only commands on shop returned:

```text
bun --version: 1.3.14
loopback fetch /health: HEALTH_STATUS=200
uname -m: x86_64
restricted docker inspect: health=healthy restart_count=0
project=swarmlet-control service=control networks=traefik-public
image=sha256:ade420dccad44d1356d375dce9ccb4562a3759329d878fd8fd4b5f2b77452830
mount=/root/projects/swarmlet-control/data:/data
compose=/root/projects/swarmlet-control/build/compose.control.prod.yml
```

Authenticated GETs, without printing the token or identities, confirmed `NODES_ARRAY=true
ONLINE_FIELD=true` and `ROUTING_MODELS_ARRAY=true DEPLOYMENTS_ARRAY=true` for the runbook's
snapshot comparisons. The updated [shop deploy/rollback runbook](../CONTROL_DEPLOY_BUN144.md)
builds on guarded legion2, preserves the old image, requires an offline restorable state backup,
replaces only control, checks identities/routes/health/logs and documents image/state rollback.
Extracting its shell blocks and running `bash -n` returned `RUNBOOK_BASH_N_EXIT=0`.

Production deployment, rollback, state restoration, fleet reconnection after replacement and
real inference remain UNVERIFIED and were not executed. No production mutation or PR merge occurred.

## Review

Command: `git diff --cached --check` returned no output (exit 0). The staged-diff scan
`git diff --cached --binary | gitleaks stdin --redact --no-banner` returned `no leaks found`.
The diff and the downstream `node-agent/main.ts` constructor call were reviewed with these lenses:

| Lens | Result |
| --- | --- |
| Correctness | Clean: default NAT lookup unchanged; absent address stays fail-soft. |
| Contracts | Clean: the production caller supplies only options and retains default dependencies. |
| Data safety | Clean: no executed migration/deletion; future runbook requires stopped backup, restore comparison and preservation of failed state. |
| Time | Clean: disk test budget and recovery fixture synchronization change; retention clock, stop budgets and all assertions stay unchanged. |
| Concurrency | Clean: no new global mocks or production timer/lifecycle changes. |
| Security | Clean: missing-tool tests still fail closed; no credentials added; runbook avoids printing secret state. |
| Tests | Clean: all existing assertions retained; absent-tool skips are explicit; real Linux host exercises those paths. |
| Simplicity | Clean: one existing NAT seam extended, one shared test-only availability helper. |

Search: `rg -n 'new NatMapper|interfaceIpv4|testWithTools|managedProcessTest|rssProbeTest'
swarmlet/node-agent` found the canonical NAT implementation, its main.ts consumer and the
expected tests; no parallel production implementation was introduced.
