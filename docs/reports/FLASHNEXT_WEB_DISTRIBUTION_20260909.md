# Flash-Next web distribution — September 9, 2026

## Requirements and scope

| Requirement | Owner | Decision |
|---|---|---|
| Serve Qwen3.8 Flash-Next across the current nodes and web chat | Lotar | Keep; existing model files/profile are present but no ready Flash-Next route |
| Edit and persist layer distribution from the web | Lotar | Keep; extend existing exact workerLayers and deployment lifecycle |
| Keep saved changes separate from applying a model reload | Lotar (default pending optional preference) | Keep; saving should preserve an active conversation |
| Full model copies on each 4 GB Legion | UNOWNED | Delete; RPC workers receive the tensors for their assigned layers |
| Arbitrary fractional compute within a layer or noncontiguous layer placement | UNOWNED | Delete; the engine uses contiguous transformer blocks |
| New scheduler, generic model manager, or native-stage port for Flash-Next | UNOWNED | Delete; existing split execution supports this model |

Simplify by reusing the planner, persistent deployment registry, existing web styling,
and start/stop lifecycle. Store only a saved distribution beside the active spec;
validate again before applying. Accelerate by testing with the small existing model
before loading Flash-Next. Automate only the validated save/apply and guarded setup.

## Current state and plan

Verified via live /api/nodes, /api/deployments and /api/deployments/plan-preview:
three nodes online, 2B baseline READY, external Flash-Next not serving. Mac inventory
contains all five verified Flash-Next GGUF parts and MTP head. Installed profile has
48 layers and a measured one-layer-per-worker envelope. Explicit 1/1/46 at context
1024, parallel 1, chain 0 passes with engine weights 1/1/47 (output slot included).
Legions receive worker tensors rather than storing a full model they cannot host.

1. Persist saved layer distributions and validate/apply through the existing manager.
   Verify registry reopen, unchanged running spec on save, invalid-plan rejection,
   and ordered stop/update/start using Bun control tests.
2. Add a web distribution editor, exact range preview, Save and Apply controls.
   Verify real browser save/reload/read-back, fit errors and persisted settings.
3. Restart the updated controller inside the existing idle guard; activate a managed
   Flash-Next three-node deployment, leaving it serving on success. Verify actual
   native engine block allocation, all three assignments READY, and routed chat.
4. Verify the complete deployed web flow and document endpoint, distribution and limits.

Risks: Flash-Next is large and cannot coexist with its standalone production owner;
use the existing maintenance guard and preserve restoration on failed setup. Never
widen measured memory envelopes. Applying requires a reload and can take time.
Saved settings must not alter recovery of an active deployment until applied.
A controller crash during apply may leave the deployment stopped with its saved
layout intact; retrying Apply must remain possible. No speedup is assumed.

## Diff review

VERDICT: merge after physical/browser acceptance. One confirmed race was fixed:
an explicit Stop during Apply now cancels the pending restart using the existing
lifecycle generation. A regression test proves no new assignments are started.

FINDINGS: resolved Stop/Apply race in `swarmlet/control/deployments.ts`.

| Lens | Result |
|---|---|
| Correctness | Clean after cancellation fix; exact positive integer counts, coordinator remainder and profile fit reuse the planner |
| Contracts | Clean; `control/server.ts` consumes manager results, `control/ui/app.js` consumes the new endpoints, `control/registry.ts` round-trips the optional protocol field |
| Data safety | Clean; additive nullable SQLite column is nondestructive, idempotent by column check, and older readers tolerate it. Saved-layout writes intentionally replace only the pending layout; active spec changes only after acknowledged teardown. Private SQLite backup precedes activation |
| Time | Clean; existing ISO timestamp helper reused; no scheduling or timezone changes |
| Staleness/concurrency | Clean after cancellation fix; duplicate Apply and Save during Apply rejected, current offers rechecked, inflight requests prevent teardown, saved settings retained on failure |
| Security | Clean; existing authenticated admin routing covers both endpoints; only placement fields accepted; DOM text uses textContent |
| Tests | Clean; persistence, route preservation, invalid input, real control restart, real agent wire, failed teardown and Stop cancellation covered; no assertion weakened |
| Simplicity | Clean; duplicate search for saveDistribution/applyDistribution/saved_distribution found only the new persistence/API/UI path and tests; existing planner/start/stop reused |

QUESTIONS: none remaining in source review. Physical model and browser acceptance
are recorded below when complete. Existing seven-test wire suite passed before the
cancellation fix; the fresh 255-test component suite includes that fix.

## Activation failure investigation

First live Apply failed: `maintenance stop refused (1)`. Browser save/reload/invalid
layout/apply and desktop/mobile checks had passed before the load attempt.

| Hypothesis | Distinct prediction | Discriminating check |
|---|---|---|
| Wrong setup ownership: stopExternal enabled for an already stopped service | Maintenance stop sees no loaded owner; failure cleanup nevertheless starts it | idle-window verified owner unloaded/8099 absent; coordinator log reports maintenance refusal; assignments.ts persists restore obligation before calling stop |
| Worker/model format failure | Native model loader or worker reports format/allocation failure | Both workers reached listening; coordinator failed in fitGate before native loader spawn |

The requested deployment incorrectly opted into stopping another owner despite the
operator already owning the stopped state. Correct the deployment spec to omit
stopExternal, restore the originally stopped standalone state through its canonical
maintenance script after a quiet window, then remeasure fit. Do not weaken the gate.
The generic external lifecycle remains unchanged; this setup does not need it.

## Large tensor relay repair plan

The corrected request passed fit and native allocation (49/49 engine slots), but
stalled while sending weights. Native `sample` shows `rpc_buffer_set_tensor` waiting
for a reply, sender queues empty, worker TCP queues empty, CPU idle, relay bytes zero.
A separate local Bun reproduction sends 67,108,864 bytes with the existing direct
ws.send pattern: received 18,087,936; 748 frames dropped; complete=false.

| Hypothesis | Prediction | Check / result |
|---|---|---|
| Relay ignores server WebSocket backpressure | Large bursts silently lose frames and RPC waits forever for missing bytes | Local 64 MiB reproduction loses bytes; channel.ts calls ws.send without checking its result; no drain handler |
| Worker still computing or doing file I/O | Worker CPU/I/O activity, or queued socket data, eventually advances | Both workers idle in socket wait, empty TCP queues, no relay traffic; native coordinator waits for response |

Canonical path: server.ts imports AgentChannel; channel.ts constructs every server
StreamMux sender using ws.send. Bun's installed serve.d.ts and official documentation
say send=-1 is queued, send=0 is dropped; default backpressure limit is 16 MiB and
closeOnBackpressureLimit defaults false. Reference:
https://bun.sh/docs/runtime/http/websockets#backpressure

REQUIREMENTS / owner: lossless large Flash-Next tensor transfer — Lotar, keep because
model cannot load without it; preserve internet relay — Lotar's standing setup,
keep; arbitrary unbounded buffering — UNOWNED, drop. New wire credit protocol and
agent rebuild — UNOWNED, delete from this fix; consider only if bounded buffering
cannot serve the current qualified model. Largest expert tensor has 512 × 640 × 2560
values; retain a finite 1 GiB outbound queue per connection to cover its quantized
payload. Exceeding that bound or send=0 must disconnect instead of silently corrupting
the byte stream. Simplify with one ordered sender shared by text and binary call sites.
Accelerate with a real 64 MiB socket reproduction before another expensive model load.
Automate existing guarded activation only after byte integrity passes.

GOAL / DONE-WHEN: exact byte delivery through the existing controller sender under
backpressure, then Flash-Next ready and successful real browser/API chat.
CURRENT STATE / PREMISE: a real transport defect blocks setup; the model/profile and
layer editor are not the cause. Both native stack and isolated socket reproduction
provide independent evidence before edits.
STEPS: add ordered bounded socket outbox → unit tests for queued, dropped and overflow;
wire all controller sends plus drain/close → real socket test compares byte count and
content/order; component suite + typecheck; repeat guarded live activation and chat.
RISKS / NON-GOALS: preserve message order, do not resend a -1 frame, copy retained
binary memory, release queues on close. No node protocol/agent/runtime changes and no
LAN fallback. The 1 GiB queue bound is explicit; above it, fail closed and recover.
BLOCKING QUESTIONS: none. PRE-MORTEM: replaying -1 duplicates bytes or dropping queued
text loses Stop; all traffic uses the same outbox and tests assert exact order.

The first outbox test correctly failed (`received 17/1024 frames`) when sends resumed
synchronously inside Bun 1.3.14's drain callback. A minimal independent socket probe
showed pending bytes remaining without another drain; deferring resume until the
next event-loop turn delivered all 67,108,864 bytes, buffered=0, pending=0. The
canonical outbox now resumes that way. Four tests pass, including exact order and
payload validation for every frame in a real 64 MiB burst, byte-bound overflow,
failed sends, queued buffer ownership, and close cleanup. No assertions were removed.

Review of the additional change: correctness clean (a -1 frame is never resent;
0/throw/overflow closes the channel); contracts clean (all channel.ts sends share
SocketOutbox; server.ts dispatches drain); data safety clean (no persistence changes);
time clean (next-turn scheduling only); concurrency clean (one resume timer,
ordered queue, close cancels timer); security clean (finite per-connection bound,
no silent partial stream); tests clean (real byte integrity, failure and overflow);
simplicity clean (one sender, two existing binary/text consumers, no new wire protocol).

## Final live acceptance

STATUS: done. `flashnext-mesh` (`dep-69d2ac8c0272`) remains READY and serves
`qwen3.8-flash-next` through the controller. Web: http://192.168.1.53:47900/#chat.
OpenAI-compatible base: http://192.168.1.53:47900/v1.

| Node | Assigned transformer layers |
|---|---|
| lotar-legion-2 | 1 (layer 1) |
| lotar-legion | 1 (layer 2) |
| Lotars-MBP.home | 46 (layers 3–48), plus output |

Configuration: UD-Q4_K_XL, context 1024, parallel 1, chain off, internet relay.
Each current 4 GiB Legion is qualified for at most one Flash-Next layer. Exact
placement uses contiguous whole layers; it does not split computation within one
layer. The worker tensors are loaded through RPC; a full model copy on each Legion
is unnecessary. Saved settings match the active layout. The previously running
2B deployment is stopped; standalone :8099 remains in its original stopped state.

Native allocation evidence: actual coordinator assignment weights 1/1/47 and native
metadata n_layer_all=48, offloaded 49/49. The allocation helper verified the engine's
float32 boundary calculation gives 1/1/46. Proof mode is explicitly
`derived-from-assignment-and-native-metadata`, not direct per-layer residency logging.
Native model buffer sizes are 1583.20 MiB and 1616.67 MiB on the RPC workers.

Real browser acceptance passed:
- Model visible on all three nodes; browser chat returned `I am ready to help.`
- Save an alternate one-worker layout; reload and read it back.
- Save while READY leaves active spec and all active assignment IDs unchanged.
- Restore the saved two-worker layout; oversized two-layer worker layout rejected.
- Apply through the real button and confirmation started the managed Flash-Next load.
- Desktop/mobile screenshots inspected; no page errors or horizontal mobile overflow.

Use Deployments → flashnext-mesh → Layer distribution. Edit counts, Check layout,
then Save distribution. Apply saved distribution reloads the model when ready;
Save alone does not interrupt it. Initial cold loading took several minutes.

Evidence: `sin-harness/data/legion-goal/flashnext-web-20260909/` (gitignored), including
`activation-final.log`, `wire-final.log`, `allocation.json`, `startup.json`,
`chat-api.json`, `final.json`, and the desktop/mobile screenshots. Earlier failed
attempts and the transport reproductions are retained alongside successful evidence.

Final operator output:
```
FRESH_WIRE_SUITE_PASS
ALLOCATION_PASS derived-from-assignment-and-native-metadata [1, 1, 46]
REAL_API_CHAT_PASS
BROWSER_MODEL_ON_THREE_NODES_PASS
BROWSER_REAL_CHAT_PASS "I am ready to help."
BROWSER_SAVE_READY_MODEL_UNINTERRUPTED_PASS
BROWSER_NO_PAGE_ERRORS
FLASHNEXT_READY_LEFT_SERVING dep-69d2ac8c0272
```

Component checks after the relay repair: `bun test protocol control node-agent`:
259 pass, 0 fail. Full wire suite: `bun test ./swarmlet/e2e`: 7 pass, 0 fail,
81 assertions, 110.91 seconds. TypeScript typecheck and JavaScript syntax check pass.
Source-review verdict: merge; all eight lenses clean after the documented fixes.
REMAINING: none for the requested setup and saved whole-layer distribution workflow.
No claim of a throughput improvement or a performance qualification is made.
