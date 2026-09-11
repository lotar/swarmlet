# Windows desktop node

Owner: Lotar. Scope: a Windows laptop (`laptop-ppn32fp0`, 192.168.1.188 on the home WiFi) joins the mesh as a full node with the same desktop app the Mac has: window, tray, start at login, agent as sidecar or service. The app must look and feel like the macOS glass shell, and the node must be validated end to end in a live mesh (enroll, deployment, routed chat reply, quit and restart, service install).

Requirements kept (all from Lotar's request): one desktop node per OS from one code base; Windows look matches the Mac glass shell; the node is proven in a mesh, not only built. Deleted: a second UI, a Windows service wrapper program (NSSM, WinSW), an installer that needs administrator rights, OpenSSL on Windows. Simplified: the agent learns `process.platform === "win32"` in one place (`node-agent/platform.ts`) and every OS-specific tool call sits behind an existing probe function; the shell re-uses `macos.css` by re-targeting its selector at build time and adds only what Windows needs. Accelerated: the agent cross-compiles for Windows from the Mac (Bun), so the laptop only has to build the engine (llama.cpp with MSVC) and the shell. Automated: unit tests for every new parser and for the generated service files, a TLS handshake test for the WebCrypto certificate, `cargo check` for `x86_64-pc-windows-msvc` on the Mac.

## What changed

Protocol: `Capabilities.os` accepts `"win32"`; the default RAM reserve for a Windows node is 6 GiB (`protocol/validate.ts`). The planner already treats every non-darwin node the same way (GPU offered: layers on the GPU; no GPU: layers in host RAM on the CPU backend), so a CPU-only Windows node plans like a Linux node without a GPU. The dashboard prints the raw OS string (`win32 x64`), as it does for `darwin arm64`.

Agent (`swarmlet/node-agent`):

- `platform.ts`: `IS_WINDOWS`, `platformOf`, `exeName` (`llama-server` becomes `llama-server.exe`), `engineDistName` (`engine/dist/windows`). Used by `config.ts`, `probe/engine.ts`, `roles/recipes.ts`, `roles/stage.ts`.
- `probe/win32.ts`: CPU percent from two `os.cpus()` samples, free RAM from `os.freemem()`, RSS of a pid list from `tasklist /FO CSV` (locale-safe number parsing), free disk from `Get-CimInstance Win32_LogicalDisk`, process identity (creation time plus command line) from `Win32_Process`. `probe/host.ts` and `probe/index.ts` switch on the platform; `nvidia-smi` is the GPU fallback on Windows as on Linux.
- `enforce/index.ts`: Windows has no cgroups; RAM is the same soft cap as on macOS, using the shared `rssMiB` probe (`ps` on darwin, `tasklist` on Windows).
- `roles/identity.ts`: Windows recovery identity from CIM (100 ns creation time).
- `install.ts`: `swarmlet-node install` registers a hidden Task Scheduler logon task `Swarmlet Node` (`schtasks /Create /XML`, UTF-16 with BOM) that runs `%LOCALAPPDATA%\Swarmlet\swarmlet-node-service.ps1`; the launcher sets `SWARMLET_HOME`, starts `swarmlet-node.exe run` and appends both streams to `~\.swarmlet\logs\agent.log`. `uninstall` ends and deletes the task and stops any `swarmlet-node.exe run` left behind. The task XML path is the "service installed" marker the shell checks.
- `identity.ts` plus new `selfsigned.ts`: the node's TLS certificate is a self-signed ECDSA P-256 certificate built with WebCrypto and a small DER encoder (no `openssl` binary on any OS). Verified: `openssl x509` parses it (ecdsa-with-SHA256, CA:FALSE, key usage), `openssl verify` accepts the self-signature, and a Bun TLS server and client each present it and see the expected SHA-256 fingerprint on the other side.
- `localapi.ts` and `main.ts`: `POST /api/shutdown` stops engines and exits (answers first, then stops); the Windows shell uses it because there is no SIGTERM. `swarmlet-node ui` opens the browser with `cmd /c start`. `install` from source detects `bun.exe`.
- `sin-harness/core/sign.ts`, `protocol/sign.ts`, `probe/models.ts`: `node:path` (`isAbsolute`, `join`, `basename`) instead of `startsWith("/")` and manual slash handling.
- `build.ts`: target `windows` (`bun-windows-x64`, `swarmlet-node.exe`); the icon is stamped only when compiling on Windows (Bun limitation). Cross-compiled from the Mac: `dist/agent/windows/swarmlet-node.exe`, PE32+ x86-64, 98.6 MB, sha256 recorded in `agent-build.json`.

Shell (`swarmlet/node-shell`):

- `lib.rs`, Windows configuration: frameless, transparent, shadowed window with `Theme::Light`; backdrop `MicaLight` on Windows 11 (build 22000 or later, read with a hidden `cmd /c ver`), `Acrylic` on Windows 10, none when the build cannot be read (the stylesheet then keeps the sidebar opaque). Sidecar stop is `POST /api/shutdown` then kill after 8 s; `pid_alive` uses `tasklist`; the service marker is `%LOCALAPPDATA%\Swarmlet\swarmlet-node.task.xml`; engine detection looks for `.exe` names. Console tools run with `CREATE_NO_WINDOW`.
- `frontend/windows.js`: same trusted-origin rule as the Mac script (exact `http://127.0.0.1:47800` origin, or the bundled splash at `http://tauri.localhost`), injects the stylesheet, a drag strip (`data-tauri-drag-region`; double-click maximizes, the Windows convention) and the three Windows 11 caption buttons (46 x 32, Segoe Fluent Icons glyphs E921, E922/E923, E8BB) that call `plugin:window|minimize`, `internal_toggle_maximize` and `close` (close hides to the tray, as on the Mac). The brand line reads "On this PC".
- `frontend/windows.css`: Segoe UI Variable, 8 px corners, 32 px drag height, Mica through the sidebar at 72 % light, opaque fallback when `data-native-backdrop='none'` or reduced transparency is requested; everything else comes from `macos.css` with its selector rewritten to `data-native-shell='windows'` at compile time, so both shells keep one layout.
- `capabilities/windows-chrome.json`: the four window commands for the `main` window, local pages and `http://127.0.0.1:47800/*` only, Windows only.
- `tauri.conf.json`: `nsis` target, per-user install (`installMode: currentUser`), installer icon.
- `scripts/build-release.ps1`: compiles the agent (or `-ReuseAgent`), checks the recorded hash and the engine manifest, stages `binaries/swarmlet-node-x86_64-pc-windows-msvc.exe` plus engine, runs `cargo tauri build --bundles nsis` (or the prebuilt CLI through `bunx`), publishes `dist/shell/windows/swarmlet-node_<version>_x64-setup.exe`.

Engine: `engine/build.ps1` is the Windows twin of `build.sh`: upstream llama.cpp at `patches/UPSTREAM_REF` with `core.autocrlf false`, the mesh patch, MSVC static build (Visual Studio 2022 x64 generator), CPU by default, `-Cuda` and `-Vulkan` optional, `sha256.txt` in shasum format with `.exe` names and `engine.json`. The Visual Studio generator discovers the compiler and SDK in an ordinary SSH session; Ninja would require an initialized MSVC developer environment. The agent reports the stage worker under the OS-neutral key `mesh-stage-worker` so the planner match does not depend on the file name.

## Models the Windows node must support (go-live 2026-09-10)

The three shipped profiles are `qwen35-2b-q8` (Qwen3.5-2B Q8_0, model name `qwen3.5-2b`), `qwen36-35b-a3b-q4km` (Qwen3.6-35B-A3B Q4_K_M) and `flash-next-ud-q4kxl` (Qwen3.8 Flash-Next, model name `qwen3.8-flash-next`). Nothing in the controller or the agent is model-specific per OS: the planner places a `win32` node by the same rules as a Linux node (worker layers against the GPU offer, host side against RAM, CPU when no GPU is offered), the engine on Windows is built from the same upstream ref and mesh patch as on the Mac and the Legions, so it reads the same GGUF architectures, and the recipes only change the executable name (`llama-server.exe`, `ggml-rpc-server.exe`). Pinned by `control/test/planner.test.ts` ("windows node placement (all shipped profiles)", 5 tests).

What the laptop needs per role:

| profile | worker (RPC slab) | replica or coordinator (holds the model) |
|---|---|---|
| `qwen35-2b-q8` | GPU offer of at least 752 MiB (3 layers x 80 + 512 margin); no model file | `Qwen3.5-2B-Q8_0.gguf` (1.87 GiB, sha256 `1b04acba824817554f4ce23639bc8495ff70453b8fcb047900c731521021f2c1`) in `%USERPROFILE%\.swarmlet\models`; GPU: 1920 MiB; CPU only: 2944 MiB of RAM offered |
| `qwen36-35b-a3b-q4km` | GPU offer of at least 3072 MiB (4 x 512 + 1024); no model file | `Qwen3.6-35B-A3B-Q4_K_M.gguf` (19 GiB) plus 24.5 GiB RAM on the CPU path; not planned for the laptop |
| `flash-next-ud-q4kxl` | GPU offer of at least 3144 MiB (1 x 1608 + 1536); no model file | 5 shards, 104 GB, 79 GiB of memory; impossible on a laptop, the M5 stays the coordinator |

Plan for the laptop: worker role for all three profiles if it has an NVIDIA GPU with 4 GB or more (`nvidia-smi` is the GPU probe on Windows, same as Linux); replica and coordinator role for the 2B in every case (GPU or CPU). The 2B file is copied from the Mac (`~/.swarmlet/models/Qwen3.5-2B-Q8_0.gguf`) with `scp`, then `Get-FileHash -Algorithm SHA256` on the laptop must print the hash above before the offer is enabled. Not available on Windows: resident native execution of the 2B (`nativeExecution`, `mesh-stage-worker`), whose admission records are pinned to the qualified Metal and CUDA binaries in `control/profiles/qwen35-native.ts`; a Windows binary needs its own proof run first. Split and replica execution do not depend on that.

Go-live checklist, in order, each with evidence:

1. `keep-awake.ps1 -Verify` on the laptop: every row `ok`, running on AC.
2. `swarmlet-node.exe probe` shows `os: win32`, the GPU (or none) and the models directory with the 2B file and its hash.
3. Enrolled and online on `http://192.168.1.53:47900` with the offer enabled (roles by the table above).
4. Replica deployment of `qwen35-2b-q8` pinned to the Windows node: READY, `/v1/models` lists `qwen3.5-2b`, one chat completion answered by the laptop's `llama-server.exe`.
5. Split deployment of `qwen35-2b-q8` with the laptop as a worker (GPU only): READY, chat completion answered.
6. Flash-Next split with the laptop as one 1-layer worker (GPU only): planned by the controller (plan preview), deployed only if the current `flashnext-mesh` deployment is stopped first, since the M5 cannot serve both.
7. Quit from the tray and relaunch; `swarmlet-node install`; the shell attaches to the service; the node stays online for 30 minutes with the lid closed.

## Power and lock on the laptop

The node is only useful while the laptop is awake, so `keep-awake.ps1` (served with the other scripts, and the same settings run as step 7 of `setup-ssh-for-claude-code.ps1` unless `-SkipPower`) sets, for AC power only: display never dims or turns off, adaptive brightness off, no sleep, no hibernate, no unattended sleep after an automatic wake, lid close does nothing, no password on wake, network connectivity kept in standby, Wi-Fi adapter may not be powered down by Windows; for the signed-in user: screen saver off (including the logon-screen-on-resume flag) and dynamic lock off; machine wide: `InactivityTimeoutSecs = 0` so the session never locks on idle. Battery values are untouched, so the laptop must stay plugged in. `keep-awake.ps1 -Verify` prints every value next to its target and exits 2 if any differ. Win+L still works; only the automatic paths are removed.

## Checks on the Mac (2026-09-09)

- `bun run typecheck`: clean. `bun test` in `swarmlet`: 276 pass, 0 fail (before the new files), plus `node-agent/test/win32.test.ts` (6), `node-agent/test/selfsigned.test.ts` (2), `node-shell/test/windows.test.ts` (3), the unchanged `macos.test.ts` (2) and the 5 Windows placement tests in `control/test/planner.test.ts` (48 pass in that file).
- `cargo check` for the shell on `aarch64-apple-darwin` and on `x86_64-pc-windows-msvc` (Homebrew `llvm-rc` for the resource compiler): no errors, no warnings.
- `bun run node-agent/build.ts windows` on the Mac: `dist/agent/windows/swarmlet-node.exe` (PE32+), manifest written.
- PowerShell scripts parse cleanly in `pwsh` (`Parser::ParseFile`).

## Laptop procedure

Access model: key-only SSH from the Mac (`~/.ssh/id_ed25519_winbox`, `Host winbox` in `~/.ssh/config`, `HostKeyAlias winbox`), port 22 open to the local subnet on Private networks only. The Mac serves the setup scripts on `http://192.168.1.53:8765/` (`~/Desktop/winbox-ssh`).

1. On the laptop, elevated PowerShell: download and run `setup-ssh-for-claude-code.ps1 -PublicKey "<Mac key>" -SetNetworkPrivate`. It installs and hardens sshd, applies the power and lock settings above, and prints the account name, the LAN IP, the host key fingerprint and a `known_hosts` line keyed to `winbox`. A red `NOT REACHABLE YET` banner means the WiFi is still Public and every inbound packet is dropped.
2. From the Mac: seed `~/.ssh/known_hosts` with that line, `ssh winbox whoami`, then `keep-awake.ps1 -Verify` over SSH.
3. `bootstrap-toolchain.ps1` over SSH: Git, Bun, CMake, rustup (MSVC toolchain), Visual Studio 2022 Build Tools with the C++ workload. `nvidia-smi -L` decides CPU or `-Cuda` for the engine build (CUDA toolkit needed for `-Cuda`).
4. Transfer the source tree, then `engine\build.ps1` (CPU, or `-Cuda`), `node-shell\scripts\build-release.ps1`.
5. Stage the 2B model: `scp ~/.swarmlet/models/Qwen3.5-2B-Q8_0.gguf winbox:.swarmlet/models/` (follow the symlink; 1.87 GiB), then `Get-FileHash` on the laptop equals `1b04acba...f2c1`.
6. Install the NSIS package in the interactive session, launch, screenshot, enroll with a join code from the Mac control plane (`http://192.168.1.53:47900`), then run the go-live checklist above (replica 2B, split 2B, Flash-Next plan preview, tray quit and relaunch, service install).

## CPU-only compute rule (2026-09-11)

Owner rule: a node may offer CPU-only compute (a worker, coordinator or replica role with no GPU memory in the offer) only when it has no usable GPU. A usable GPU is a device the engine can see whose backend is not `cpu` and whose memory is above zero (`usableGpus` in `protocol/validate.ts`). Free GPU memory does not matter; only whether a usable device exists. The rule is enforced in three places:

- `validateOffer` refuses a CPU-only compute offer on a machine with a usable GPU and names the device (`cpuOnlyRefusal`).
- `placeResident` in the planner refuses to place a coordinator or replica on the CPU of a node that has a usable GPU but offers none of it; the error asks for GPU memory or a different node.
- The fleet allocator no longer hides a node's GPU to try a CPU-only replica.

The laptop (`LAPTOP-PPN32FP0`, Intel UHD graphics only, no CUDA device, `caps.gpus = []`) qualifies. Two node-agent changes were needed for it to hold the 2B model:

- The Windows RAM reserve is no longer a fixed 6 GiB. `defaultRamReserveMiB` keeps 6 GiB on large machines and scales down to 35% of total RAM, never below 2 GiB. On the 7857 MiB laptop the reserve is 2750 MiB, so the largest offer is 5107 MiB (the 2B replica needs 24 x 80 + 1024 = 2944 MiB).
- The replica recipe maps the planner's `CPU` device to `--device none -ngl 0`. llama-server has no device named `CPU` and exited with usage text (the first start attempt failed this way; release 2026091106 carries the fix).

## Status (2026-09-11)

Windows acceptance of the CPU-only replica path is DONE end to end on the hosted control plane (`https://app.swarmlet.ai`, image `swarmlet-control:6a4128e`).

- Access: key-only SSH to `winbox` works; PowerShell runs through `-EncodedCommand`.
- Releases: signed win32-x64 releases 2026091105 (`0.1.0-cpuonly.20260911.5`, reserve change) and 2026091106 (`0.1.0-cpuonly.20260911.6`, replica recipe fix, exe sha256 `bac68cef0c43...900e32`) were published for the Windows feed only. The laptop supervisor activated each within 5 minutes with no manual step (`state\updates.json` active sequence 2026091106). Mac and Linux nodes were not restarted.
- Model: `C:\Users\lotar\.swarmlet\models\Qwen3.5-2B-Q8_0.gguf`, sha256 `1b04acba...f2c1`, listed by the controller.
- Offer: enabled, roles replica only, `gpu: []`, `ramMiB 3584`, `cpuCores 6`; accepted with no warnings; the local API reports `ramMaxMiB 5107`.
- Deployment `dep-4fe6dbe93f1a` (`win-2b-cpu`, profile `qwen35-2b-q8`, kind replica, ctx 2048, parallel 1): plan preview places 24 of 24 layers on CPU, state `ready`, RSS watchdog cap 3.5 GiB, llama-server RSS about 2.2 GiB, laptop free RAM about 1.3 GiB while serving.
- Routed reply: `POST /v1/chat/completions` with `x-swarmlet-deployment: dep-4fe6dbe93f1a` returned `x-swarmlet-node: 01f78366eb893349` and the text "Mercury is the planet closest to the Sun." (17 tokens per second generation, 32 tokens per second prompt). With thinking left on, a 40-token budget is spent in `reasoning_content` and `content` stays empty; that is the model's thinking mode, not a routing fault. Pass `chat_template_kwargs.enable_thinking=false` or a larger `max_tokens` for a visible answer.
- Routing: `qwen3.5-2b` is now served by two deployments, this replica and the 3-node internet split `mesh-2b-internet` (`dep-65bedf5278d1`, still `ready`, 5 tokens per second on the same prompt). The router picks the lowest inflight, then the lowest RTT, so unpinned 2B requests currently land on the laptop (30 ms RTT against 41 ms). Stop the replica with `POST /api/deployments/dep-4fe6dbe93f1a/stop` if that is not wanted.
- Tests: `bun test` in `swarmlet`: 394 pass, 0 fail; `tsc --noEmit` clean.

Fleet-wide (2026-09-11, later the same day): the same code now runs on every node, not only Windows. Releases 2026091107 and 2026091109 (`0.1.0-linkwatch.20260911.9`, `main` at `b5bf420`) were published on all three feeds; all four nodes activated 2026091109 on their own within 6 minutes and the hosted e2e check passed on every node (Windows CPU-only replica, Mac plus both Legions serving the 2B split on their GPUs, plan preview never placing a replica on the CPU of a GPU node). 2026091109 also adds the agent link watchdog after Legion 1 sat on a half-open control link for 16 minutes during the 2026091107 rollout. Repo e2e tests now cover the CPU-only path with a GPU-less fake engine (`e2e/mesh.test.ts`). Details: `docs/reports/CPUONLY_FLEET_RELEASE_20260911.md`.

Flash-Next routing (2026-09-11, 18:55): selecting `qwen3.8-flash-next` on the Windows node now lands on the split `flashnext-mesh` (`dep-0867eec8aa93`: Mac coordinator with 46 layers, one layer on each Legion GPU) instead of the standalone Mac server on 8099, which is stopped while the split runs. Two layers per Legion was requested and refused by the planner (no envelope row; 4752 MiB needed against a 3600 MiB GPU offer). The 2B split `mesh-2b-internet` is stopped because the Legion GPUs cannot hold both; `qwen3.5-2b` is served by this laptop's CPU replica. Details and reversal: `docs/reports/FLASHNEXT_SPLIT_LIVE_20260911.md`.

Not done: the split-coordinator path on a CPU-only node still emits `--device ...,CPU`, which llama-server would also reject; the laptop offers only the replica role, so this is not reachable today. The go-live checklist items above that were not part of this run (2B split with the laptop as worker, Flash-Next plan preview from the laptop, tray quit and relaunch, service install) are unchanged from their earlier state.
