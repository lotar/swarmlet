# Telemetry release — 2026-09-11

Owner: Lotar. Requested outcome: publish and validate a new node/controller release with detailed anonymous operational history, a web viewer, and oldest-first retention capped at three days or 2 GB.

## Scope decisions

- QUESTIONED: “full” means the existing numeric hardware, resource, network, engine and runtime measurements plus inference response timings, byte counts, HTTP status and completion/error/cancellation outcomes. Prompts, replies, model names, raw logs, IP addresses, hostnames, paths and arbitrary diagnostic strings are excluded.
- DELETED: no new collector service, vendor, endpoint on the nodes or public telemetry access. Use the authenticated heartbeat and existing admin UI/API.
- SIMPLIFIED: an explicit numeric allowlist; keyed opaque node/deployment IDs; bounded SQLite segments separate from the controller registry. Stable opaque IDs are pseudonymous, not a claim of irreversible anonymity.
- ACCELERATED: exercise privacy, retention, restart, failure and real HTTP/WebSocket integration locally before releasing.
- AUTOMATED: existing heartbeat, signed release feed and controller cleanup timer. No additional release operator framework.
- SCOPE: this release includes the prior committed audit fixes. An installed supervisor refresh is separate from signed child activation.

## Behavior and retention

The admin Telemetry tab shows 1/6/24/72-hour ranges, anonymous node filters, charts, detailed numeric sensor/runtime records, response statistics and actual storage use. First response byte measures response-body arrival from request routing start; it is not time to first generated token. Unavailable measurements remain unknown. Each sample carries measurement ages for inspection; charts aggregate received numeric measurements.

Storage lives in `SWARMLET_CONTROL_DIR/telemetry`. Segments rotate every 15 minutes or near 16 MiB. Oldest segments are removed at 72 hours or before the dedicated directory can exceed 2,000,000,000 bytes; two segment sizes reserve journal/rotation space. Whole-file deletion returns disk space without vacuuming the registry and can remove up to one segment of younger data. Pruning runs on append/read and every minute, so expiration cleanup can lag by one timer interval while idle. Rotation intentionally and irreversibly deletes expired telemetry; it is idempotent and does not touch registry/model/release files. Backups outside this directory are outside its retention policy.

The identity key persists across controller restarts. Only the existing authenticated admin API exposes telemetry. Storage initialization failure disables history while preserving controller/inference availability; failed appends increment the dropped-record counter. HTTP 200 SSE error events count as errors. Response bodies pass through unchanged and are never persisted.

## Source verification

Commands and output are recorded in `/tmp/swarmlet-telemetry-release/` during execution. Checks cover a real enrolled WebSocket client through the authenticated HTTP telemetry endpoint; an isolated real browser with desktop/mobile filters; both rotation limits including restart; privacy sentinels in responses and SQLite bytes; stream cancellation/errors; and a lost storage directory without inference interruption.

A local synthetic 518,400-row history (three days at four nodes / two seconds) used 335,286,304 bytes: 1-hour query 77 ms, 72-hour query 692 ms, each bounded to 361 chart buckets. This is a local synthetic measurement, not a production latency guarantee.

## Review

VERDICT: source suitable for release after validation gates; production acceptance recorded separately after rollout.

FINDINGS: no unresolved source findings. Review corrected invalid non-finite store limits, disambiguated multi-day chart axis dates, and added a storage-failure regression.

| Lens | Assessment |
| --- | --- |
| Correctness | Range/size boundaries, missing fields, streaming completion/error/cancel and storage recovery checked in telemetry tests. |
| Contracts | `protocol/validate.ts` consumes the optional runtime fields from `node-agent/main.ts`; `control/ui/telemetry.js` consumes the new API. Existing router callers keep their optional observation argument. |
| Data safety | Dedicated segment deletion is destructive, intentionally irreversible and idempotent; exact segment filenames constrain it to this store. No registry migration. |
| Time | Controller receipt epoch controls retention and buckets; source timestamp ages remain explicit; multi-day chart labels include dates. |
| Staleness/concurrency | UI generation rejects late filter responses; one pending refresh; missing samples produce gaps; stored samples include measurement age. |
| Security | Admin-only endpoint, SQL parameter binding, strict anonymous ID filter and explicit numeric/string-enum allowlist. No payload content stored. |
| Tests | Original assertions retained; privacy, HTTP auth, restart, both retention limits and storage failure exercised. |
| Simplicity | Existing channel/router/UI extended; no duplicate collector. Search for `telemetry`, `retention` and `anonymousId` confirmed the new store is the sole history implementation. |

QUESTIONS: none for source scope. Installed component identity and hosted acceptance are rollout checks, not inferred from local tests.

## Published and accepted

Release `2026091104`, version `0.1.0-telemetry.20260911.4`, was published on the existing signed feeds for darwin-arm64, linux-x64 and win32-x64. Source commit: `8f194b155ccffd44b57b9c36d6d9ae8a65964866`. Hosted controller: `swarmlet-control:8f194b1`, healthy. The registry/config/signing keys were backed up to the controller's `data/backups/telemetry-2026091104` before replacement.

All four nodes activated the release through the existing updater. Each active executable path and every signed inventory file was checked: Mac 16 files, both Linux nodes 7 each, Windows 6. The Mac app automatically installed; all 15 app files match the signed desktop descriptor, `codesign --verify --deep --strict` passes, and the previous app is retained.

The four stable service supervisors were refreshed separately, with old binaries/service definitions saved under each node's `.swarmlet/backups/telemetry-2026091104-supervisor*`. The running service commands and installed bootstrap hashes were checked independently of the child release:

| Platform | Canonical / installed supervisor SHA-256 |
| --- | --- |
| Mac | `568d165d837fc45c03a8d1557d5020fdd82053cc7bd8047edd4cf973e5598f1f` |
| Linux, both nodes | `11bbcf81f5af4753f7dbaa68bc35ff98fede99f2793db43b1d14ae17e25f262d` |
| Windows | `179af00d83b0e519048e4e935fe51d75ef05c4e741aa03f2f9a47bd7679f4d93` |

The installed Mac privileged fan helper already matches the canonical release (`2bc2a4cb871567edab5178d8964b2e4054afd308fd1301a42b6fa0895690c572`). Neither Linux host has a privileged helper at `/usr/local/libexec/swarmlet-fans`; their bundled provider scripts were delivered and verified in the signed inventory. No new privilege configuration was installed.

Operator observations: the first controller attempt stopped at backup-directory permissions, before replacing the controller; an owned backup directory resolved it. The first Mac refresh encountered transient launchd bootstrap EIO, restored its saved bootstrap, and recovered on a delayed native restart. The repeated refresh used a bounded restart retry and successfully installed the intended supervisor. Services were refreshed serially using signed controller maintenance leases; the operator waited for the standing model to recover between affected nodes. The outer idle-window guard preserved the external production service's pre-existing stopped state.

## Executed evidence

- `bun run --cwd swarmlet typecheck` → `$ tsc --noEmit`, exit 0.
- `bun test swarmlet` → `385 pass`, `0 fail`, `4264 expect() calls`, `Ran 385 tests across 56 files.`
- Python operator, Linux fan and numerical verifier suites → `Ran 92 tests`, `Ran 10 tests`, `Ran 3 tests`, each `OK`.
- Telemetry/privacy/HTTP/SSE checks in the actual hosted shipping image with production read-only/memory limits → `16 pass`, `0 fail`, `108 expect() calls`.
- Real hosted Chromium flows → `HOSTED_TELEMETRY_BROWSER_OK charts=true node_filter=true range_filter=true mobile=true private_names_absent=true console_errors=0`.
- Active stored SQLite bytes → `HOSTED_STORAGE_PRIVACY_OK files=2 bytes=2068512 known_identities_absent=true` at the recorded check.
- `/tmp/swarmlet-telemetry-release/hosted-audit.py`, inside the idle maintenance window → `HOSTED_TELEMETRY_OK nodes=4 release=2026091104 privacy=true admin_only=true limits=72h/2000000000B dropped=0 history_growing=true response_recorded=true` and `HOSTED_CHAT_OK marker=TELEMETRY_READY standing_specs_unchanged=true canonical_ui=true`.

The hosted API exposes all four anonymous runtime release numbers, grows between observations, rejects unauthenticated access, and matches the committed UI assets. The live 2B response's count/timing was recorded; its prompt/reply marker was absent from telemetry. Existing deployment specifications were compared before and after and are unchanged. The pre-existing failed FlashNext mesh specification and loading external watch are not asserted healthy by this release.

Final review verdict: merge/released; no unresolved findings in the eight-lens source review above. Retention's 72-hour boundary and size rotation were exercised with an isolated clock/size budget; acceptance does not claim that three actual days have elapsed. No remaining rollout work for this requested release.
