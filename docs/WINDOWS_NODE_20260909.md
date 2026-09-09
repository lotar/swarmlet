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

Engine: `engine/build.ps1` is the Windows twin of `build.sh`: upstream llama.cpp at `patches/UPSTREAM_REF` with `core.autocrlf false`, the mesh patch, MSVC static build (Ninja when present), CPU by default, `-Cuda` and `-Vulkan` optional, `sha256.txt` in shasum format with `.exe` names and `engine.json`. The agent reports the stage worker under the OS-neutral key `mesh-stage-worker` so the planner match does not depend on the file name.

## Checks on the Mac (2026-09-09)

- `bun run typecheck`: clean. `bun test` in `swarmlet`: 276 pass, 0 fail (before the new files), plus `node-agent/test/win32.test.ts` (6), `node-agent/test/selfsigned.test.ts` (2), `node-shell/test/windows.test.ts` (3) and the unchanged `macos.test.ts` (2).
- `cargo check` for the shell on `aarch64-apple-darwin` and on `x86_64-pc-windows-msvc` (Homebrew `llvm-rc` for the resource compiler): no errors, no warnings.
- `bun run node-agent/build.ts windows` on the Mac: `dist/agent/windows/swarmlet-node.exe` (PE32+), manifest written.
- PowerShell scripts parse cleanly in `pwsh` (`Parser::ParseFile`).

## Laptop procedure

Access model: key-only SSH from the Mac (`~/.ssh/id_ed25519_winbox`, `Host winbox` in `~/.ssh/config`, `HostKeyAlias winbox`), port 22 open to the local subnet on Private networks only. The Mac serves the setup scripts on `http://192.168.1.53:8765/` (`~/Desktop/winbox-ssh`).

1. On the laptop, elevated PowerShell: download and run `setup-ssh-for-claude-code.ps1 -PublicKey "<Mac key>" -SetNetworkPrivate`. It prints the account name, the LAN IP, the host key fingerprint and a `known_hosts` line keyed to `winbox`. A red `NOT REACHABLE YET` banner means the WiFi is still Public and every inbound packet is dropped.
2. From the Mac: seed `~/.ssh/known_hosts` with that line, `ssh winbox whoami`.
3. `bootstrap-toolchain.ps1` over SSH: Git, Bun, CMake, Ninja, rustup (MSVC toolchain), Visual Studio 2022 Build Tools with the C++ workload.
4. Transfer the source tree, then `engine\build.ps1` (CPU), `node-shell\scripts\build-release.ps1`.
5. Install the NSIS package in the interactive session, launch, screenshot, enroll with a join code from the Mac control plane (`http://192.168.1.53:47900`), create a replica deployment on the Windows node, send a chat message through the router and confirm the reply came from the Windows node, quit and relaunch from the tray, `swarmlet-node install`, confirm the shell attaches to the service.

## Status

The Mac-side work above is complete and committed. The laptop steps are NOT RUN: at the time of writing the laptop answers ARP but drops every inbound packet, which is the Windows Public-profile firewall state; the setup script has not been executed on it yet (the Mac's file server log shows no download from 192.168.1.188). A watcher on the Mac records the moment port 22 opens (`/tmp/winbox-watch.log`). Rendered appearance of the Windows shell, the Mica effect, drag and caption behavior, the scheduled task and the routed reply remain unverified until then.
