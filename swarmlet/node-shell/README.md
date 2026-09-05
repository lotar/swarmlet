# Swarmlet Node — desktop shell

A small [Tauri v2](https://v2.tauri.app) app around the Swarmlet node agent (`swarmlet/node-agent`).
It is the thing a node owner double-clicks: a normal desktop app with a dock icon and a window,
plus a tray / menu-bar icon, a start-at-login toggle, and a supervisor that runs the agent as a
bundled *sidecar* when no user service is installed.

The shell adds no features of its own. The window is the agent's own web UI served on
`http://127.0.0.1:47800`, and the tray talks to the agent's loopback JSON API
(`GET /api/status`, `POST /api/enabled`). One Rust codebase builds for macOS and Linux.

```
node-shell/
├── frontend/index.html            splash page shown until the agent answers (no framework, no npm)
├── scripts/build-sidecar.sh   copies the canonical service agent and verified engine into src-tauri/binaries
└── src-tauri/
    ├── Cargo.toml             crate swarmlet-node-shell (tauri 2 + tray-icon, plugin-shell, plugin-autostart)
    ├── tauri.conf.json        productName "Swarmlet Node", identifier ai.swarmlet.node, sidecar + engine resources
    ├── capabilities/          core:default for the splash page only; the agent UI (remote origin) gets no IPC
    ├── icons/                 app-icon-1024.png is the source; the rest comes from `cargo tauri icon`
    │                          tray-template*.png are hand-drawn monochrome menu-bar icons (macOS template images)
    ├── src/lib.rs             all behaviour (window, tray, supervisor, HTTP client); main.rs just calls run()
    └── binaries/              (gitignored, produced by scripts/build-sidecar.sh)
        ├── swarmlet-node-<target-triple>   the sidecar (Bun single-file build of node-agent/main.ts)
        └── engine/                         ggml-rpc-server, llama-server, llama-ring-bench, sha256.txt, engine.json
```

## Prerequisites

Everything installs in user space; no `sudo` is needed on macOS.

**Both platforms**

- Rust (stable) via rustup: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal`,
  then `export PATH="$HOME/.cargo/bin:$PATH"`.
- Tauri CLI: `cargo install tauri-cli --version "^2" --locked` (compiles for several minutes).
- Bun 1.3.x (the repo pins `bun` in `swarmlet/package.json`) to compile the sidecar.
- The engine binaries for the platform in `swarmlet/engine/dist/<darwin|linux>/` (built by `engine/build.sh`).
  Release staging refuses missing engines or a checksum mismatch.

**macOS** (Apple silicon; the sidecar target is `aarch64-apple-darwin`)

- Xcode or the Command Line Tools (`xcode-select --install`). Built here with Xcode 26.6 on macOS 26.5.

**Linux** (x86_64; the sidecar target is `x86_64-unknown-linux-gnu`) — Debian/Ubuntu package names:

```
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
                 build-essential pkg-config curl wget file libssl-dev libxdo-dev
```

`libayatana-appindicator3-dev` is what makes the tray icon work (Tauri's `tray-icon` feature).
On Fedora/Arch use the equivalents from the Tauri prerequisites page.

## Build

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cd swarmlet/node-shell
scripts/build-release.sh  # native macOS .app or Linux .deb; never installs or restarts
```

This compiles the agent once via `node-agent/build.ts`, records its SHA-256 in
`dist/agent/<os>/agent-build.json`, and copies the exact binary into the shell. The
canonical binary is also the service-install artifact. Every engine executable must
exist, be executable, and pass `sha256.txt`. The manifest travels inside the GUI package.
Outputs are `swarmlet/dist/shell/darwin/Swarmlet Node.app` and
`swarmlet/dist/shell/linux/swarmlet-node_0.1.0_amd64.deb`.

To compile both agents on the Mac, then package Linux natively, first run
`bun run node-agent/build.ts darwin linux` from `swarmlet/`, transfer
`dist/agent/linux/` with its manifest and Linux engine to the Linux build tree, then
run `scripts/build-release.sh --reuse-agent` there. Reuse checks the agent's checksum;
the operator must ensure this artifact is from the intended final source revision.
`SWARMLET_ENGINE_DIST=/absolute/path` selects a prebuilt engine directory for a
**single OS** build. Do not use it for a multi-OS build.

Builds default to two Cargo jobs. Reuse a native cache with absolute
`CARGO_TARGET_DIR=/path/to/existing/target`; this speeds recompilation but does not
reuse old agent binaries. For the existing rig, the Mac cache is
`/Users/lotar/projects/ai-mesh/swarmlet/node-shell/src-tauri/target`; Legion 1 has its
native tree at `/home/lotar/swarmlet-shell`. Keep machine caches local. The scripts
build `.app` and `.deb` only; DMG/AppImage, signing and auto-update are separate work.

Tauri checks that `binaries/swarmlet-node-<host triple>` exists before bundling.
The release script always stages it first. Regenerate the icon set after changing the mark with
`cargo tauri icon icons/app-icon-1024.png -o icons`.

For a debug run without bundling use `cargo tauri dev` from `src-tauri/` (the sidecar and engine
must still be in `binaries/`). Do not run it on a machine where something else already listens on
127.0.0.1:47800 unless you want the shell to simply attach to that agent.

### The build is unsigned

Nothing is code-signed or notarized. A downloaded `.app`/`.dmg` is quarantined, so on first launch
macOS says the developer cannot be verified. Either **right-click (Control-click) the app → Open →
Open** once, or clear the flag: `xattr -dr com.apple.quarantine "/Applications/Swarmlet Node.app"`.
A locally built bundle has no quarantine flag and opens directly. An ad-hoc signature
(`codesign --force --deep --sign - "Swarmlet Node.app"`) is optional; every binary inside is
already ad-hoc signed by its linker (Bun and clang do that on Apple silicon).

## How it behaves at runtime

Startup (`src-tauri/src/lib.rs`, `supervise`):

1. `GET http://127.0.0.1:47800/api/status`. If it answers, an agent is already running (the user
   service, or a `swarmlet-node run` you started by hand) and the shell just attaches to it.
2. Otherwise, if the user service is installed — `~/Library/LaunchAgents/ai.swarmlet.node.plist`
   on macOS, `~/.config/systemd/user/swarmlet-node.service` on Linux, both written by
   `swarmlet-node install` — the shell waits for it (up to 20 s) and never spawns a second agent,
   because two agents would fight over the port and launchd/systemd would keep restarting the loser.
3. Otherwise it spawns the bundled sidecar `swarmlet-node run` with
   `SWARMLET_ENGINE=<app>/Contents/Resources/engine` (Linux: the deb installs resources under `/usr/lib/<app name>/`, the AppImage
   carries them inside; both are resolved through Tauri's resource path), waits up to 20 s for `/api/status`, and if the sidecar
   exits later it is restarted (at most 20 times per app session).

The window shows `frontend/index.html` (a splash with the current message) until `/api/status`
answers, then navigates to `http://127.0.0.1:47800/`. If the agent stops answering for two polls
the window goes back to the splash, and returns to the UI when the agent is back.

- **Tray menu**: status line (disabled item, e.g. `connected · 2 assignments`), *Open Swarmlet Node*,
  *Enabled* (checkbox bound to the agent's master switch through `POST /api/enabled`),
  *Start at login* (checkbox, `tauri-plugin-autostart`), *Quit Swarmlet Node*.
  The tooltip carries the same status text and is refreshed every 5 s.
- **Closing the window hides it**; the app keeps running in the tray/menu bar. Clicking the dock
  icon (macOS) or the tray's *Open* item brings it back. *Quit* (or ⌘Q) exits.
- **Quit stops the sidecar if the shell started it**: SIGTERM first so the agent can stop its
  engine processes, `kill` after 8 s. An agent run by the service is left alone.
- **Start at login** registers the shell (not the agent) with `--minimized`, so at login it comes
  up tray-only and starts the sidecar (or attaches to the service) without opening the window.
  macOS: a LaunchAgent plist named after the product in `~/Library/LaunchAgents/`;
  Linux: `~/.config/autostart/*.desktop`. This is independent of `swarmlet-node install`, which
  makes the *agent* a service that runs even when the shell is not open.
- **Logs**: `~/Library/Logs/ai.swarmlet.node/shell.log` and `sidecar.log` (macOS),
  `~/.local/share/ai.swarmlet.node/logs/` (Linux). Both are truncated when they pass 5 MB.
  The agent's own state stays in `~/.swarmlet/` (`SWARMLET_HOME` is not changed by the shell).

### Sidecar or service?

| Situation | What runs the agent | Shell behaviour |
|---|---|---|
| Fresh install, nothing else | the bundled sidecar | spawns it at launch, stops it at quit |
| `swarmlet-node install` was run | launchd / systemd --user (always on) | attaches, never spawns |
| Agent started by hand in a terminal | that process | attaches, never spawns |
| Service installed but not answering | nothing | splash explains, keeps polling; does not spawn |

The sidecar path is the "just open the app" experience; the service is for machines that should
serve the mesh with the app closed or before anyone logs in (`loginctl enable-linger` on Linux).

## Known gaps

- macOS arm64 `.app` and Linux x64 `.deb` were exercised on the rig on 2026-09-04.
  AppImage packaging failed in linuxdeploy and is excluded from the native release workflow.
  No Intel macOS build (would need a `bun-darwin-x64` sidecar and an x86_64 engine dist).
- Unsigned and un-notarized (see above). No auto-update.
- If the agent UI's "install as service" is used while the *sidecar* is the running agent, the
  service plist points at the sidecar binary inside the `.app` bundle (moving or deleting the app
  breaks the service), and launchd cannot bind the port until the shell is quit once.
  For always-on nodes, install the canonical artifact in a stable directory and set
  `node.json.enginePath` to its stable engine directory before restarting; see the
  [rig refresh procedure](../../../docs/HOW_TO_NODE_APP.md#7-refreshing-the-three-rig-installations).
- No single-instance guard: launching the app twice on Linux opens two shells (macOS reuses the
  running instance through Launch Services).
- Tray tooltips are not displayed by every Linux desktop; the status menu item carries the text.
- The engine resources (~33 MB) and the Bun runtime inside the sidecar (~60 MB) dominate the bundle size.
