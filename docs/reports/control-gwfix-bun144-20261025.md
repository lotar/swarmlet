# Control image provenance and Bun pin, 2026-10-25

Main at inspection: `d3825ee0bb326ebb1f38b0656db9cc6f3aac8c9b`.
The only product change in this PR is the digest pin in `deploy/control/Dockerfile`.
There is no missing gateway patch to port: the shipped gateway implementation is already in main.

## Live inventory (read-only)

Command: `ssh shop 'docker ps --filter name=swarmlet-control --format "{{.Names}} {{.Image}} {{.Ports}}"'`

```text
swarmlet-control swarmlet-control:2026091902-gwfix 47900/tcp
```

Targeted `docker inspect` formats (never the environment, command, or complete inspect output) returned:

```text
image=sha256:ade420dccad44d1356d375dce9ccb4562a3759329d878fd8fd4b5f2b77452830
workdir=/root/projects/swarmlet-control/build
compose=/root/projects/swarmlet-control/build/compose.control.prod.yml
service=control
health=healthy network_mode=traefik-public
```

The Compose project is `swarmlet-control`; container name is `swarmlet-control`.
The only mount is the writable bind `/root/projects/swarmlet-control/data:/data`.
`47900/tcp` is exposed internally, with no host port binding. Traefik routes `app.swarmlet.ai`
to that port on `traefik-public`; the site's Compose project is separate.
The build directory has no Git metadata. Historical bundles are in
`/root/projects/swarmlet-control/releases/{3cb0a1c,407b9c2,5dc77f9,6a4128e,786a2d7,8f194b1,af70456}`.
None is a proven source archive for the custom `gwfix` image.

Commands: image inspect restricted to ID/created/revision/version/workdir; `docker exec swarmlet-control bun --version`.

```text
created=2026-09-19T13:01:55.924199233Z revision=2026091902-gwfix version=1.3.14-slim workdir=/app
1.3.14
```

Environment **names only**, read by splitting `/proc/<container-pid>/environ` entries before `=`
and printing only the left-hand side (no environment values were emitted):

```text
BUN_INSTALL_BIN BUN_RUNTIME_TRANSPILER_CACHE_PATH HOME HOSTNAME PATH
SWARMLET_ADMIN_TRUST_LOOPBACK SWARMLET_CONTROL_DIR SWARMLET_CONTROL_HOST
SWARMLET_CONTROL_PORT SWARMLET_CONTROL_URL SWARMLET_LAN_AUTO_ENROLL SWARMLET_PUBLIC_WEB
```

The Compose file references deployment substitutions `SWARMLET_REVISION` and `SWARMLET_CONTROL_DATA`
which are not container environment entries. Its environment keys are the seven `SWARMLET_*` names above.

## Extraction and provenance

Source was streamed from the existing build directory over SSH, with no writes on shop:

```sh
ssh shop 'tar -czf - -C /root/projects/swarmlet-control/build --exclude="._*" --exclude=".env*" --exclude=config.ini --exclude="*.pem" --exclude="*.key" --exclude=node_modules --exclude=.git swarmlet deploy sin-harness site .dockerignore compose.control.prod.yml' > live-build.tar.gz
mkdir live
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -xzf live-build.tar.gz -C live
find live -name '._*' -delete
```

No `docker cp`, image extraction, server temporary copy, state download or production mutation was used.
A separate read-only hash check establishes which disk files are still the image's source:

```sh
ssh shop 'docker exec swarmlet-control sh -c "cd /app && find swarmlet/control swarmlet/protocol swarmlet/shared swarmlet/node-agent sin-harness -type f -exec sha256sum {} +"'
```

Comparing those hashes with the extracted disk files returned:

```text
IMAGE_VS_BUILD_SHA256 matched 105 different 2
DIFFERENT_PATHS ['swarmlet/control/publish-release.ts', 'swarmlet/protocol/desktop.ts']
```

The two old image hashes match `git show 95c762d:<path>` exactly:

```text
publish-release.ts 5262fdb64d7eddf044bc55823a82a7c6eb0bbc56919ea807cae6f66094fcf921
desktop.ts         01d4f318e96c648c4854cfb9be64ad61ec089733425351b013da792a08da5817
```

The disk tree also contains the later macOS publisher gate and tests, absent from the image.
Thus the present build directory alone is not an exact image source snapshot.

For each image source path, compare its SHA-256 with `git show <ref>:<path>`;
use `git ls-tree -r --name-only <ref>` restricted to the Dockerfile COPY sources to check completeness.
The comparison gave:

```text
95c762d image_matched 98 changed 6 image_only 3
6cdc91a image_matched 98 changed 7 image_only 2
d9be0e0 image_matched 99 changed 6 image_only 2
4cb58b6 image_matched 99 changed 6 image_only 2
dd2d041 image_matched 100 changed 5 image_only 2
ebef756 image_matched 102 changed 3 image_only 2
ee5df1b image_matched 107 changed 0 image_only 0
e0af329 image_matched 107 changed 0 image_only 0
origin/main image_matched 100 changed 6 image_only 1
COPY_SCOPE 95c762d tracked_files 104 missing_from_image []
COPY_SCOPE ee5df1b tracked_files 107 missing_from_image []
COPY_SCOPE origin/main tracked_files 108 missing_from_image ['swarmlet/control/macos-release-check.ts', 'swarmlet/control/test/macos-release-check.test.ts']
```

**Confirmed:** the complete source copied into the running image is byte-identical to the
Dockerfile copy scope at `ee5df1b469ca2999ac77ae182304384c1d8f3bec` (also at `e0af329`).
**UNVERIFIED:** the original checkout/base SHA used before hand-patching. `95c762d` is a useful
historical comparison point, not a verified build label. The custom revision label and non-Git
mixed build tree do not establish ancestry. The whole build context, especially node-agent files
not copied into this image, is not equivalent to any of those clean commits.

## Every changed/extra extracted file versus the historical baseline

Classification: (a) real change already in main, including an equivalent implementation;
(b) real fix absent from main; (c) deployment artifact, local partial-copy/stale source, or configuration.
Calling an older file (c) does not assert that its author deliberately removed functionality.
Unchanged files need no port. **Category (b) is empty.**

| Path(s), relative to repository root | Live/disk difference from `95c762d` | Class and decision |
| --- | --- | --- |
| `swarmlet/control/router.ts` | External alias rewrite and JSON/SSE completions-to-chat translation | (a), identical to main; history `6cdc91a`, `4cb58b6`, `ee5df1b` |
| `swarmlet/control/deployments.ts` | Carry `upstreamModel` on routing rows and external replica assignments | (a), identical to main; `d9be0e0`, `ee5df1b` |
| `swarmlet/protocol/types.ts` | External `upstreamModel`; envelope `maxFit` | (a), identical to main; `6cdc91a`, `dd2d041`, `ee5df1b` |
| `swarmlet/protocol/completions-compat.ts`, `swarmlet/protocol/test/completions-compat.test.ts` | Added translation helper and tests | (a), identical to main; `ee5df1b` |
| `swarmlet/control/test/external-alias.test.ts` | Added external-only alias guard test | (a), identical to main; `6cdc91a` |
| `swarmlet/control/planner.ts`, `swarmlet/control/profiles/flash-next-ud-q4kxl.json` | Max-fit envelope bounded by GPU and RAM | (a), identical to main; `dd2d041`, `ebef756` |
| `swarmlet/control/test/planner.test.ts` | Max-fit regression tests | (a), present in main; main additionally removes retired Bonsai from profile expectations |
| `swarmlet/protocol/desktop.ts`, `swarmlet/control/publish-release.ts` | Later disk-only carrier cleanup and macOS signature publication gate | (a), identical to main; `231f6d0`; not in the September image |
| `swarmlet/control/macos-release-check.ts`, `swarmlet/control/test/macos-release-check.test.ts` | Later disk-only gate and tests added | (a), identical to main; `231f6d0`; absent from the image |
| `swarmlet/node-agent/main.ts` | Missing benchmark import, capabilities attachment, pre-join measurement and `bench` command | (c), stale partial-copy source; keep main's `95c762d` behavior. This file is not copied into the control image |
| `swarmlet/node-agent/assignments.ts`, `swarmlet/node-agent/test/metrics.test.ts` | Missing prefill counters and their test | (c), stale partial-copy source; keep main's `4fb0d62` changes. Not copied into the control image |
| `site/agent/latest.tar.gz`, `site/agent/latest.tar.gz.sha256` | Untracked installer artifact and checksum | (c), local artifact; not copied into control and not ported |

Independent equality check: `git diff --no-index --exit-code live/<path> repo/<path>` returned `0`
for router, deployments, planner, protocol types, completions helper and external-alias test.

## Complete disk-versus-main differences

The following lists every changed or extra extracted path relative to inspected main, including
upstream improvements missing on disk. Unchanged files are omitted; source omitted from the build
context is not treated as a deliberate deletion from the repository.

| Path(s) | Classification / why main is retained |
| --- | --- |
| `swarmlet/bun.lock`, `swarmlet/package.json`, `deploy/control/Dockerfile` | (c) old runtime/type pins. Main already selects Bun 1.4.4; this PR adds its immutable image digest |
| `swarmlet/node-agent/main.ts` | (c) stale benchmark omissions described above |
| `swarmlet/node-agent/assignments.ts` | (c) stale prefill omissions and missing upstream model in inference targets; main has `ee5df1b` |
| `swarmlet/node-agent/inference.ts`, `swarmlet/node-agent/test/inference.test.ts` | (a) gateway behavior has a newer implementation in main: `ee5df1b`, `e0af329`; preserve it |
| `swarmlet/node-agent/build.ts` | (a) main removes stale desktop carriers before rebuilding; `231f6d0` |
| `swarmlet/control/server.ts` | (c) comment-only reference to retired Bonsai; **no live-only server behavior** |
| `swarmlet/control/test/catalog.test.ts`, `swarmlet/control/test/planner.test.ts`, `swarmlet/control/profiles/bonsai-2-27b-q2.json` | (c) stale profile and count expectations, intentionally removed in `e7d8464`; do not resurrect |
| `swarmlet/control/test/control.test.ts` | (a) main handles Bun >=1.4 rejection when cancelling an aborted reader; retain it |
| `swarmlet/node-shell/scripts/package-macos.ts` | (a) local inline cleanup replaced in main by shared `removeDesktopCarrier`; `231f6d0` |
| `swarmlet/node-shell/scripts/build-release.sh` | (a) main generates macOS codesign proof; `231f6d0` |
| `swarmlet/node-agent/test/metrics.test.ts` | (c) stale prefill test omission |
| `swarmlet/node-agent/test/supervisor-disconnected.test.ts`, `swarmlet/node-agent/test/supervisor.test.ts` | (a) main passes the test-only Mac verification override for synthetic binaries; retain it |
| `swarmlet/node-agent/roles/process.ts` | (a) main normalizes Bun's signal code to the existing string/null contract; retain it |
| `site/agent/latest.tar.gz`, `site/agent/latest.tar.gz.sha256` | (c) generated local installer artifact; keep it out of the PR |

The production Compose file and `.dockerignore` are identical to main.
The image-to-main differences are all covered above, plus the old publisher/desktop versions and
missing gate files; main contains the newer gate. No production configuration or node release is changed.

## Bun and security

Command: `ssh legion2 'docker buildx imagetools inspect oven/bun:1.4.4-slim'`:

```text
Digest: sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
linux/amd64 sha256:13b43f8bb2c63f5d89c56205c4279b85620363296a00ada33ff7ad568f3688e7
linux/arm64 sha256:b0d169a695f779087d0fe8c08b5b17f0d3a927dceac2a087c87a1351340c6565
```

The Dockerfile uses that multi-platform index as `oven/bun:1.4.4-slim@sha256:...`.
`git log -- deploy/control/Dockerfile` identifies main's prior version upgrade as `2c5f5b8`.

Bun's advisories identify 1.4.4 as the fixed version for
[QPACK amplification](https://github.com/oven-sh/bun/security/advisories/GHSA-cf8x-9m69-3gg3),
[brotli decoding](https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p), and
[compromised eMudhra CA keys](https://github.com/oven-sh/bun/security/advisories/GHSA-26q8-h657-pf84).
The first specifically concerns enabled HTTP/3, not all HTTP traffic. This audit did not exploit
production or establish exploitability of each code path. Updating this control image does not
update already-compiled node agents; they remain outside this PR's deployment scope.

## Read-only production baseline

Commands: `curl --max-time 20 -sS -o /dev/null -w '%{http_code}' <url>` on shop;
`docker exec swarmlet-control bun -e` fetching loopback `/health` and printing only status/health JSON.

```text
HTTP_STATUS https://swarmlet.ai/ 200 exit 0
HTTP_STATUS https://app.swarmlet.ai/ 200 exit 0
HTTP_STATUS https://app.swarmlet.ai/health 200 exit 0
LOOPBACK_HEALTH 200 {"status":"ok","nodes":5}
```

These are a time-stamped baseline, not deployment results. Recapture the actual connected node IDs
privately before deployment; a count alone cannot prove that the same agents reconnected.

## Validation

Commands, run in the dedicated `swctl1025` lane through each host's documented guard:

```sh
ssh legion2 '/home/lotar/locks/run-heavy.sh /home/lotar/swctl1025/run.sh'
ssh m1 '/Users/lotar/locks/run-heavy.sh /Users/lotar/swctl1025/run.sh'
```

The script ran `bun install --frozen-lockfile`, `bun run typecheck`, and
`bun test control node-agent protocol tools` in the pinned Bun slim image, then built the real
control Dockerfile and started it with read-only rootfs, dropped capabilities, resource limits,
isolated networking, and disposable state. Both linux/amd64 and linux/arm64 returned:

```text
TYPECHECK_EXIT=0
TEST_EXIT=1
502 pass
9 skip
9 fail
4690 expect() calls
Ran 520 tests across 70 files.
```

The same nine failures occurred on both architectures. The full suite was not narrowed and
no assertions were weakened. All control tests executed successfully except its existing macOS-only
codesign skip. The passing agent-handshake evidence includes:

```text
(pass) control core > public agent WebSocket still requires a registered signed identity
(pass) control core > enrollment refuses unknown, expired and reused codes, and bad signatures
(pass) control core > two agents enroll, authenticate, and appear online with offer and capabilities
(pass) control core > 10 MB relay alpha -> control -> beta -> local TCP echo comes back bit-exact
```

Failures are in the unchanged node-agent tests: three stage-lifecycle assertions, enforcement
recipe and assignment-log tests hit `systemd-run is required for Linux resource enforcement`;
three NAT tests hard-code interface `en0` and address `192.168.1.181` while `nat.ts` reads real
interfaces; the RSS probe test needs `ps`, which is absent from the slim image. Evidence:
`node-agent/enforce/index.ts:31`, `node-agent/test/nat.test.ts:59`, `node-agent/nat.ts:252`,
`node-agent/probe/host.ts:97`; `git diff origin/main -- swarmlet` produced no output.
These environment-dependent failures are disclosed, not converted into passes.

Both image builds and startup/status smokes succeeded:

```text
1.4.4
IMAGE_HTTP /health 200
IMAGE_HEALTH {"status":"ok","nodes":0}
IMAGE_HTTP / 200
IMAGE_HTTP /api/nodes 401
IMAGE_HTTP /v1/models 401
```

Build image IDs (revision label `d3825ee-gwfix-bun144-validation`):

```text
linux/amd64 sha256:2c11921eb2f42508def20e819815bea428257fe63401c907652b833574a38c22
linux/arm64 sha256:9d87d353b7966b0bfc210fc07cf063f2d9047983b93fa4c38ea6fb088f11f466
```

Each script executed `docker compose -p swctl1025 -f compose.yml down -v --remove-orphans`
and removed its test image. Verification returned zero lane containers, volumes and networks.
Overall `VALIDATION_EXIT=1` preserves the suite failures despite the successful smoke.

A native M1 rerun with an isolated, checksum-verified Bun 1.4.4 is recorded separately below.
GitHub release asset SHA-256: `c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510`.
The host's existing Bun installation is not changed.

Native command: `ssh m1 '/Users/lotar/locks/run-heavy.sh /Users/lotar/swctl1025/run-native-m1.sh'`.
The isolated runtime printed `1.4.4`; `bun run typecheck` returned `NATIVE_TYPECHECK_EXIT=0`.
The unmodified default-timeout suite returned:

```text
512 pass
1 skip
2 fail
4729 expect() calls
Ran 515 tests across 70 files. [86.29s]
```

The fan helper's Swift compilation hit the existing 5000 ms hook timeout. The remaining NAT
assertion expected `192.168.1.181`, received `192.168.1.160`; an independent
`ssh m1 'ipconfig getifaddr en0'` returned `192.168.1.160`. No real NAT mapping is performed by
that test: its route/IGD/SOAP dependencies are test doubles, but its interface lookup is real.
A full rerun with `bun test --timeout 30000 control node-agent protocol tools` accommodates
Swift compilation without changing source, assertions, or the set of requested test directories.

Final native command:
`ssh m1 '/Users/lotar/locks/run-heavy.sh /Users/lotar/swctl1025/run-native-m1-final.sh'`,
executing `bun run typecheck` and `bun test --timeout 30000 control node-agent protocol tools`:

```text
NATIVE_TYPECHECK_EXIT=0
NATIVE_TEST_EXIT=1
517 pass
1 skip
2 fail
4741 expect() calls
Ran 520 tests across 70 files. [93.69s]
```

The Swift fixture and all its tests passed with the longer timeout. The final failures were:

```text
(fail) soft RSS cap stops a real engine process before a 10% allowance can consume the OS reserve
Expected to contain: "exceeds cap 132 MiB"
Received: ""
(fail) NatMapper > advertises the mapped endpoint, with the listener port as the internal target
Expected internal: "192.168.1.181"
Received internal: "192.168.1.160"
```

The RSS test passed in the earlier native run and failed in the final full run; its cause is
**UNVERIFIED**, not attributed to Bun or the pin. NAT's literal-address dependence is reproduced.
All control tests, including native macOS signature checks and the agent handshake/relay tests,
passed in the final run. The one native skip is the shipped-engine capability probe; no engine distribution was supplied.
This is **not a green full-suite result**. Keep the PR draft and resolve or explicitly review these
existing test failures before a deployment decision; no application or test sources were changed.

Runbook syntax: extracted shell blocks checked with `bash -n evidence/runbook-shell.sh`, exit 0.
Production rollout, state restore and real fleet reconnection remain UNVERIFIED and were not executed.

## Deployment

See [the Claude runbook](../CONTROL_DEPLOY_BUN144.md). It is a future procedure requiring separate
deployment authorization after merge. This task makes no production changes and never merges the PR.
