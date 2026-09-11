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
