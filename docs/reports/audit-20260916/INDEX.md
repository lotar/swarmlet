# Night audit + fixes, 2026-09-16 (10 audit lanes, 4 fixes, 1 new harness)

Read this first: it is the map. Everything below links to a report in this directory
(`docs/reports/audit-20260916/L*.md`, 8 of 10 lanes) and to commits in this repo.

## TL;DR for the morning

1. **The live deployment was restarting its engine ~102 times a day and nobody could see it.** A peer node
   (`MBP-od-Veimir`) flaps and reconnects every ~15 minutes; every reconnect made the control re-decide the
   placement of `mesh-auto` (`dep-4bcfade6e039`) and **restart a perfectly good 27B engine to reach the
   placement it was already running** - the control's own event log has the arrow with the same value on both
   sides 144 times. Each restart is 1-5 minutes of no service for whoever is mid-request. Fixed in `1170231`
   (see below); the fix is **committed but not deployed** - the control plane does not run on this Mac.
2. **Nothing could be released before tonight**: the release gate runs the full swarmlet suite, and it was
   212 pass / 19 fail, all 18 failures in `planner.test.ts` asserting envelope values the shipped profiles no
   longer have. Now **467 pass / 0 fail** (`bbdd979`).
3. **A harness now exists for the class of failure in (1)**: `swarmlet/tools/engine-churn.mjs`, wired into the
   release gate (`cadaf04`). Run it any time: `cd ~/projects/ai-mesh/swarmlet && bun tools/engine-churn.mjs --since -24h`.
4. **I disturbed the live mesh once, and it was my brief's fault, not the agent's**: an auditor ran
   `bash site/install.sh` as a "usage check"; the no-args guard only fires on a box that is *not* enrolled, so
   on this (enrolled) Mac it silently took the upgrade path, rewrote the launchd plist and restarted the node.
   Cost: one dropped generation, ~60 s. Repro and the fix are in L8 (`L8.md` §1.0/§3 D1); the installer fix
   itself is still OPEN (see "Open decisions").
5. **Nothing to stop, nothing left running that I started**: the local-llm rig (`:8099` flashnext) was already
   stopped and stayed stopped. The only engine resident is the mesh one on `:47800`/`:8100`, which serves other
   people - I did not touch it beyond read-only checks (and one fixed bug in the control that was restarting it).

## The live incident, measured

`bun tools/engine-churn.mjs --since -24h` (before the fix shipped):

```
engine spawns   102   (4.28/h, threshold 1/h)
exits           101  = 77 graceful + 8 ungraceful
restart spacing median 920.6s, max 2459.3s
UNGRACEFUL 2026-09-16T08:31:22Z coordinator code=134 signal=SIGABRT
UNGRACEFUL 2026-09-16T08:46:43Z coordinator code=134 signal=SIGABRT
```

Over the log's full span the harness finds a day with **27-63 restarts per hour** and an **18-hour** window
with no engine running at all. The two SIGABRTs are the RPC split: `coordinator-as-... --rpc 127.0.0.1:59293,... --tensor-split 5,5,5,49`,
aborting inside `ggml_backend_rpc_add_server` / `server_context_impl::load_model`. The planner kept choosing it
because a transient memory reading made the whole-model replica look unplaceable.

Independent confirmation, from a different agent in a different lane (`L6.md`):

> "the replica↔split oscillation (22 `automatic model choice is now` events)" ... "the 69 triggers from one
> broken peer" ... "the 65 no-ops (**76 %** of all moves)".

## Fixes landed tonight

| commit | what | evidence |
|---|---|---|
| `1170231` | `redistribute()` no longer restarts a **ready** deployment whose candidate plan is equivalent to the plan running (`samePlacement`), and a plan that crashed **ungracefully** is remembered per deployment (`planFingerprint`, `blockPlacement`, `planFor`) and refused while it is serving. Rest starts at 1 h, each repeat x4 (cap 24 h); an explicit stop clears the memory. | `control/test/redistribution.test.ts` 32 pass / 0 fail (11 new); full suite 224→242 pass |
| `bbdd979` | `planner.test.ts` asserts the **shipped** envelopes (flash: `coordinatorHostMiB 32768`, `maxCtx 262144`, `maxChain 0`; 27B ladder `[5,6,8,10,12,15,20,25,30]`) instead of the ladders they replaced. Chain-dependent rules are now exercised through a chain-capable **clone** of the same profile, which is the only honest way to keep that coverage when the shipped rows allow no chain. | `bun run test` 461 pass / 0 fail, tsc clean |
| `cadaf04` | `tools/engine-churn.mjs`: engine churn/spawn/exit report with signals and reasons, per-hour histogram, longest no-engine window; exit 2 on churn or any ungraceful exit. Plus 6 tests over 4 fixtures (one taken from the real log) and the release gate now runs `tools`. | gate 467 pass / 0 fail; run against the real log finds the 102-restart day |
| (earlier today) `d0fc32a`, `c6c3177`, `5802b38`, … | the audit-visible surface: pruned envelopes, placement UI, build target pin, install.sh served from the app host | see `git log` |

### Two things I checked rather than assumed

- **The 2 failing e2e tests are pre-existing.** `bun test e2e` is 8 pass / 2 fail on the current tree **and
  identically 8 pass / 2 fail on `d0fc32a`** (verified in a throwaway worktree with the same 94 `expect()`
  calls). They are outside the release gate's scope (`bun test protocol control node-agent tools`), but they
  are real: `mesh e2e > relay mesh recovers after actual disconnect` times out at 37 s, and `worker crash fails
  the deployment and cleans up` at 5 s. Recorded in `L6.md`.
- **The live plane is healthy right now**: `/v1/models` on `:47800` serves `qwen3.8-27b`, `local`, `swarmlet`
  (`route: local`), a real generation returns `finish_reason: stop`, and the deployment reports `state=ready`
  with `workers: 0, chain: 0` (a replica, not a split).

## The ten audit lanes

| lane | scope | report | headline |
|---|---|---|---|
| L1 | `local-llm` rig scripts | `L1.md` | every launcher executes (`--dry-run`-style `PRINT=1`), the registry/docs/`models/` agree in the places that matter; dead launchers listed |
| L2 | `local-llm` docs vs reality | `L2.md` | executed the documented commands and diffed the output; the doc claims that failed are listed with commands |
| L3 | gbrain ingest hooks | `L3.md` | all 17 hooks compile; the ingest lanes and the four recently-fixed defects verified in the files; biggest challenge: the "graph janitor" manufactures **23,006 of 27,515 links (83.6 %)** and has **no named owner** |
| L4 | gbrain runtime + the 16 local patches | `L4.md` | broker/floor/heal exercised read-only; apply step 2 to each of the 16 patches |
| L6 | swarmlet control | `L6.md` | the churn, quantified: 69 triggers from one peer, 76 % no-op moves, the replica↔split oscillation; plus the 18 planner failures tabulated for the claim holder |
| L7 | swarmlet node-agent | `L7.md` | 186 pass / 0 fail; **provably dead** config surface (`NodeConfig.advertise`, `IS_WINDOWS`, `ENGINE_BINARIES`); download size-only acceptance flagged |
| L8 | UIs, protocol, profiles, packaging | `L8.md` | Dockerfile COPY sources all resolve; 26/29 control endpoints have a UI caller; **profile-vs-doc-vs-test disagreement tabulated**; the install.sh incident |
| L9 | benchmark evidence estate | `L9.md` | re-derivation of published numbers from raw JSONL; unreferenced harness scripts listed |
| L5, L10 | tests/evals; live system survey | not delivered | both lanes were still running when the night ended; their briefs are in the dispatch script (`/tmp/e2e-audit/dispatch.js`) if you want them re-run |

## How to ship the control fix (the one thing that needs you)

The control plane is **not** on this Mac - only the HUD containers (`sblC*`), inventory staging and
`gbrain-postgres` are local, so I could not deploy it. The fix is committed on `main` (`1170231`, `bbdd979`,
`cadaf04`). On the site host, per this repo's own release path:

```
cd <checkout of this repo on the site host>
git pull                       # or fetch the release you package
git status --porcelain         # release-check.sh refuses a dirty tree
sin-harness/scripts/release-check.sh
SWARMLET_REVISION=$(git rev-parse --short HEAD) \
SWARMLET_CONTROL_DATA=<the data dir that holds control.json/db> \
  docker compose -f compose.control.prod.yml up -d --build control
curl -fsS https://app.swarmlet.ai/health
```

After that, `bun tools/engine-churn.mjs --since -1h` on this Mac should stop finding restarts: the next time
`MBP-od-Veimir` reconnects, the placement it lands on is the one already running, so nothing restarts. (If you
want to watch it: `--since -3h --json | python3 -m json.tool`.)

## Open decisions

1. **install.sh must not self-upgrade on a no-arg run** (the incident above). Proposed: no args on an enrolled
   box prints usage and exits non-zero; `--upgrade` is explicit; same-release upgrades are a no-op unless
   `--force`; `--help` exists. Touching it needs care - it is the file users curl. NOT DONE.
2. **flash-next `coordinatorHostMiB`**: the profile says 32768, `profiles/README.md` says 2048 and argues 2048
   is deliberate (the PLE n-gram table is mmap-backed and "deliberately NOT part of the fit gate"). The JSON is
   what the planner uses; the arithmetic is load-bearing (a full 48-layer replica is 109952 of 110000 MiB), so
   the README is the thing that is wrong - unless 32768 was a typo. See `L8.md` §1.3.
3. **`qwen36-35b-a3b-q4km` declares `maxChain: 7` with no `mtpPattern`** - the planner refuses chain>0 for a
   profile without a draft head, so that field is unreachable data. Either add the mtpPattern or drop the 7.
4. **L3's graph-janitor challenge** (83.6 % of links synthesised by a requirement nobody owns).
5. **gbrain 0.42.53.0 → 0.50.0.0** would clobber all 16+ local patches; the patch list is now one of the
   questions L4's report answers.
6. **L9**: sin-harness contains one-shot measurement scripts whose number has already been published; archive
   vs keep is a judgement call with an owner (you).

## Local model scheduling (asked for in the handover)

- Nothing needed stopping: `bin/llm-switch.sh status` shows the local-llm rig is **not running** (no `:8099`
  listener). The mesh engine on `:8100` is a different deployment and serves other sessions - left alone.
- If you want the rig up in the morning: `cd ~/projects/local-llm && bin/llm-switch.sh flashnext` (sole
  residency: it will stop the mesh engine if it is on `:8099`; it is not). Nothing here needs the local model.
- Tonight's work used no local model at all - it was code, tests and log analysis.

## Where everything is

- Lane reports: `docs/reports/audit-20260916/L*.md` (in this directory, committed) and the raw originals in
  `/tmp/e2e-audit/L*/REPORT.md` (plus each lane's scratch files next to them).
- The harness: `swarmlet/tools/engine-churn.mjs` + `swarmlet/tools/engine-churn.test.ts` +
  `swarmlet/tools/fixtures/{churny,crashy,clean,midnight}.log`.
- The dispatch that produced the audit: `/tmp/e2e-audit/dispatch.js` (10 lanes) and `/tmp/e2e-audit/retry.js`
  (the three lanes relaunched after pi's Anthropic OAuth refresh token turned out to be expired - worth
  re-logging in pi before the next run that pins an Anthropic model).
- Verification commands I ran for the fixes are in the commit messages; the numbers above are from
  `bun run test` (467/0), `bun test e2e` (8/2, pre-existing), and the harness against the real log.
