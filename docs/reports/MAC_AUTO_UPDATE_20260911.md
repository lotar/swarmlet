# Mac app automatic update verification — 2026-09-11

The signed node feed previously updated the background agent and engine, while the installed Mac app bundle remained old. An already-open WebView also retained its old JavaScript. Both paths now update through the existing signed release flow.

## Implementation

- `3543b8c`: content-version polling refreshes open node UI pages. Active streams, unsaved resource settings, and failed draft persistence defer reload. Chat history and drafts survive refresh.
- `18bae79`: Mac packaging includes a descriptor and the signed app's files in the existing release inventory. The active node re-verifies the pinned release, reconstructs and verifies the app, then atomically swaps directories. The previous app is retained. Pending trial releases cannot install desktop apps.
- `1ce3f6d`: converts the installed release number to text before rendering the status row. Native-window acceptance caught the numeric DOM-child error in the first release; the corrected release also exercises automatic refresh of that open window.

The Mac installer updates an existing app at `~/Applications/Swarmlet Node.app` or `/Applications/Swarmlet Node.app`. It does not create GUI installations on headless nodes. Windows and Linux continue to use the existing agent updater and share the UI refresh behavior.

## Acceptance evidence

Release `2026091101` automatically activated on all four nodes. Before any operator relaunch, the Mac node reported `desktopUpdate.state=installed`; all 15 installed bundle files matched the release inventory, `codesign --verify --deep --strict` passed, and `.Swarmlet Node.previous.app` existed. The installed build metadata matched the canonical release build. No operator copied the app into place.

An isolated acceptance check also reconstructed the actual signed production bundle under a temporary test release key, using the default Apple signature checks and atomic rename implementation. It verified retained backup and idempotence. No production signing key was exported.

The old native window had to be reopened once to acquire the update watcher. Its empty composer was visually verified beforehand; saved chat history reappeared with Markdown rendered. This exposed the numeric status-row bug described above. The corrected source passed the real browser fixture against live status containing numeric release sequence `2026091101`.

Browser fixture checks additionally covered deferred refresh during streaming, complete reply retention, unsaved settings, storage failure, and draft/history preservation.

`bun test swarmlet` after the correction: **336 pass, 0 fail, 4021 assertions**, across 47 files, including the fake-engine mesh end-to-end recovery suite. An initial broad run conflicted with the UI fixture on port 47820 (`EADDRINUSE`); stopping that owned fixture and rerunning the full suite resolved all five cascading failures without changing tests.

Release `2026091102` then automatically installed the corrected Mac bundle. All 15 destination files matched the signed inventory again, the code signature passed, and the predecessor was retained. The native process remained PID `88024` and its window remained `96597` across this second update: no operator reload or relaunch. Targeted screenshots showed the error disappear, the connection return, and the saved Markdown conversation remain.

A separate real browser window stayed open across the same production update. Its in-memory marker disappeared, its UI content hash changed from `e827c8b2169a7fa42bb680704323d16a615225e41e1bec027212422bd5fe41c3` to `7c3d3fef8b87f782f1cd41bba9e343d27ee478a75e87697a9f8eeb4fcda38bf3`, and the unsent test draft survived. The status rows showed `2026091102` and `Up to date · 0.1.0-auto-app.20260911.2`. The test draft was cleared afterwards.

At 05:35 UTC, all four nodes were connected on release `2026091102`, with no pending activation. Independent on-host audits matched every manifest file and the actual running executable path: Mac 16 release files, each Linux node 7 files, Windows 6 files. The Mac app additionally contained 15 verified bundle files.

Final verification commands included `python3 /tmp/swarmlet-auto-app2-installed-audit.py` → `PASS: Mac app automatically installed; all 15 bundle files match signed release; codesign valid; previous app retained`, plus the four-node readiness check → `PASS: all four nodes activated release 2026091102; Mac node automatically installed the matching app bundle`.

## Model state

Before this task, 2B and Flash had failed deployment states. The live 2B deployment recovered and was ready after the final four-node rollout; the native app showed it selected with the composer enabled. Flash remained admission-limited: its recorded failure was `58322 MiB free, need 76016`. Resource offers, placement, and memory checks were preserved.

Raw audit evidence is retained locally under `~/.swarmlet/backups/ui-auto-update-20260911/`; screenshots contain local chat history and are not committed.
