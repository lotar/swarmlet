//! Swarmlet Node desktop shell.
//!
//! A normal desktop app (dock icon + window) that shows the node UI the agent serves on
//! http://127.0.0.1:47800, plus a tray / menu-bar icon with the master switch and the
//! start-at-login toggle. The shell never re-implements agent features: it only supervises the
//! agent process and talks to its loopback JSON API.
//!
//! Agent supervision:
//! * If /api/status already answers, an agent is running (user service or another instance):
//!   nothing is spawned.
//! * If the user service is installed (launchd plist / systemd --user unit written by
//!   `swarmlet-node install`) the shell waits for it and never spawns a competing process.
//! * Otherwise the bundled sidecar `swarmlet-node run` is spawned with SWARMLET_ENGINE pointing at
//!   the bundled engine resources; it is stopped (SIGTERM, then kill) when the shell quits.

use std::{
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry,
};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const AGENT_PORT: u16 = 47800;
const AGENT_URL: &str = "http://127.0.0.1:47800/";
const SIDECAR_NAME: &str = "swarmlet-node";
const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main";
const STARTUP_WAIT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const STOP_GRACE: Duration = Duration::from_secs(8);
const MAX_SIDECAR_RESTARTS: u32 = 20;
const SIDECAR_LOG_CAP: u64 = 5 * 1024 * 1024;

// ---------- state ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
enum Page {
    #[default]
    Splash,
    Agent,
}

#[derive(Default)]
struct ShellState {
    /// Sidecar we spawned (None when a service / another instance serves the port, or after exit).
    sidecar: Mutex<Option<CommandChild>>,
    owns_sidecar: AtomicBool,
    sidecar_exited: AtomicBool,
    sidecar_restarts: AtomicU32,
    quitting: AtomicBool,
    status_failures: AtomicU32,
    page: Mutex<Page>,
    splash_url: Mutex<Option<Url>>,
    engine_dir: Mutex<Option<PathBuf>>,
    log_dir: Mutex<Option<PathBuf>>,
    shell_log: Mutex<Option<File>>,
    sidecar_log: Mutex<Option<File>>,
    tray: OnceLock<TrayItems>,
}

struct TrayItems {
    status: MenuItem<Wry>,
    enabled: CheckMenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
}

/// The subset of GET /api/status the shell displays.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    #[serde(default)]
    connected: bool,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    hostname: String,
    #[serde(default)]
    control_url: Option<String>,
    #[serde(default)]
    assignments: Vec<serde_json::Value>,
    #[serde(default)]
    offer_errors: Vec<String>,
}

impl AgentStatus {
    fn summary(&self) -> String {
        let link = if self.connected {
            "connected"
        } else if self.control_url.is_none() {
            "not joined"
        } else {
            "disconnected"
        };
        let n = self.assignments.len();
        let mut s = format!("{link} · {n} assignment{}", if n == 1 { "" } else { "s" });
        if !self.enabled {
            s.push_str(" · disabled");
        } else if !self.offer_errors.is_empty() {
            s.push_str(" · offer invalid");
        }
        s
    }
}

// ---------- entry ----------

pub fn run() {
    let start_hidden = std::env::args().skip(1).any(|a| a == "--minimized" || a == "--hidden");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin({
            let autostart = tauri_plugin_autostart::Builder::new().args(["--minimized"]);
            #[cfg(target_os = "macos")]
            let autostart = autostart.macos_launcher(MacosLauncher::LaunchAgent);
            autostart.build()
        })
        .manage(ShellState::default())
        .setup(move |app| {
            let handle = app.handle().clone();
            init_logs(&handle);
            let engine = engine_dir(&handle);
            match &engine {
                Some(d) => logln(&handle, format!("bundled engine: {}", d.display())),
                None => logln(&handle, "no bundled engine resources found; the agent will use its own default engine path"),
            }
            *handle.state::<ShellState>().engine_dir.lock().unwrap() = engine;
            if let Err(e) = build_tray(&handle) {
                logln(&handle, format!("tray icon unavailable: {e}"));
            }
            let win = build_window(&handle, !start_hidden)?;
            if let Ok(url) = win.url() {
                *handle.state::<ShellState>().splash_url.lock().unwrap() = Some(url);
            }
            supervise(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Swarmlet Node shell");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows, .. } => {
            if !has_visible_windows {
                show_main(app);
            }
        }
        RunEvent::Exit => {
            app.state::<ShellState>().quitting.store(true, Ordering::SeqCst);
            stop_sidecar(app);
        }
        _ => {}
    });
}

// ---------- window ----------

fn build_window(app: &AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("Swarmlet Node")
        .inner_size(1100.0, 760.0)
        .min_inner_size(720.0, 480.0)
        .visible(visible)
        .center();
    #[cfg(target_os = "macos")]
    let builder = {
        let css = serde_json::to_string(include_str!("../../frontend/macos.css"))
            .expect("static Mac stylesheet serializes");
        let init = include_str!("../../frontend/macos.js").replace("__SWARMLET_NATIVE_CSS__", &css);
        builder
            .decorations(false)
            .theme(Some(tauri::Theme::Light))
            .transparent(true)
            .shadow(true)
            .initialization_script(init)
    };
    let win = builder.build()?;
    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        win.set_effects(
            EffectsBuilder::new()
                .effect(Effect::Sidebar)
                .state(EffectState::FollowsWindowActiveState)
                .radius(20.0)
                .build(),
        )?;
        logln(app, format!("macOS glass window: decorated={}, native Sidebar vibrancy, drag surface enabled", win.is_decorated()?));
    }
    // Closing the window only hides it; the app keeps running in the tray. Quit is in the tray menu.
    let w = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w.hide();
        }
    });
    Ok(win)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Update the message on the splash page (no-op while the agent UI is shown).
fn splash_msg(app: &AppHandle, msg: &str, error: bool) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let text = serde_json::to_string(msg).unwrap_or_else(|_| "\"\"".into());
        let _ = w.eval(format!("window.__setMsg && window.__setMsg({text}, {error});"));
    }
}

/// Switch the window between the bundled splash page and the agent's UI.
fn show_page(app: &AppHandle, page: Page) {
    let state = app.state::<ShellState>();
    {
        let mut cur = state.page.lock().unwrap();
        if *cur == page {
            return;
        }
        *cur = page;
    }
    let Some(w) = app.get_webview_window(MAIN_WINDOW) else { return };
    let url = match page {
        Page::Agent => Url::parse(AGENT_URL).ok(),
        Page::Splash => state.splash_url.lock().unwrap().clone().and_then(|mut u| {
            u.set_fragment(Some("down"));
            Some(u)
        }),
    };
    match url {
        Some(u) => {
            logln(app, format!("window -> {u}"));
            if let Err(e) = w.navigate(u) {
                logln(app, format!("navigate failed: {e}"));
            }
        }
        None => logln(app, "no URL for page switch"),
    }
}

// ---------- tray ----------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Starting the node agent…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Swarmlet Node", true, None::<&str>)?;
    // Disabled until the first status read tells us the real value.
    let enabled = CheckMenuItem::with_id(app, "enabled", "Enabled", false, false, None::<&str>)?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Swarmlet Node", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &enabled,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Swarmlet Node · starting")
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu_event);
    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::include_image!("icons/tray-template@2x.png"))
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.icon(tauri::include_image!("icons/128x128.png"));
    builder.build(app)?;

    let _ = app.state::<ShellState>().tray.set(TrayItems { status, enabled, autostart });
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().0.as_str() {
        "open" => show_main(app),
        "quit" => quit(app),
        "enabled" => {
            // The check item already toggled itself; push the new value to the agent off the UI thread.
            let app = app.clone();
            thread::spawn(move || {
                let state = app.state::<ShellState>();
                let Some(items) = state.tray.get() else { return };
                let want = items.enabled.is_checked().unwrap_or(false);
                match set_enabled(want) {
                    Ok(()) => logln(&app, format!("master switch -> {want}")),
                    Err(e) => {
                        logln(&app, format!("could not set enabled={want}: {e}"));
                        let _ = items.enabled.set_checked(!want);
                    }
                }
                refresh_status(&app);
            });
        }
        "autostart" => {
            let state = app.state::<ShellState>();
            if let Some(items) = state.tray.get() {
                let want = items.autostart.is_checked().unwrap_or(false);
                let r = if want { app.autolaunch().enable() } else { app.autolaunch().disable() };
                match r {
                    Ok(()) => logln(app, format!("start at login -> {want}")),
                    Err(e) => {
                        logln(app, format!("could not change start at login: {e}"));
                        let _ = items.autostart.set_checked(!want);
                    }
                }
            }
        }
        _ => {}
    }
}

fn quit(app: &AppHandle) {
    app.state::<ShellState>().quitting.store(true, Ordering::SeqCst);
    let app = app.clone();
    // Stop the sidecar off the UI thread (up to STOP_GRACE), then exit.
    thread::spawn(move || {
        stop_sidecar(&app);
        app.exit(0);
    });
}

fn set_tray_status(app: &AppHandle, text: &str, enabled: Option<bool>) {
    let state = app.state::<ShellState>();
    if let Some(items) = state.tray.get() {
        let _ = items.status.set_text(text);
        match enabled {
            Some(v) => {
                let _ = items.enabled.set_enabled(true);
                let _ = items.enabled.set_checked(v);
            }
            None => {
                let _ = items.enabled.set_enabled(false);
            }
        }
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("Swarmlet Node · {text}")));
    }
}

// ---------- agent supervision ----------

fn supervise(app: AppHandle) {
    thread::spawn(move || {
        if fetch_status().is_ok() {
            logln(&app, "agent already answering on 127.0.0.1:47800 (service or another instance); not spawning a sidecar");
        } else if service_installed(&app) {
            logln(&app, "user service is installed; waiting for it instead of spawning a sidecar");
            splash_msg(&app, "Waiting for the Swarmlet service to start…", false);
            if !wait_for_agent(STARTUP_WAIT) {
                splash_msg(
                    &app,
                    "The Swarmlet service is installed but not answering on 127.0.0.1:47800.\nCheck ~/.swarmlet/logs, or remove it with `swarmlet-node uninstall` and reopen this app.",
                    true,
                );
            }
        } else {
            start_owned_sidecar(&app);
        }
        let state = app.state::<ShellState>();
        while !state.quitting.load(Ordering::SeqCst) {
            refresh_status(&app);
            thread::sleep(POLL_INTERVAL);
        }
    });
}

fn start_owned_sidecar(app: &AppHandle) -> bool {
    splash_msg(app, "Starting the node agent…", false);
    match spawn_sidecar(app) {
        Ok(pid) => logln(app, format!("spawned sidecar `{SIDECAR_NAME} run` (pid {pid})")),
        Err(e) => {
            logln(app, format!("could not spawn sidecar: {e}"));
            splash_msg(app, &format!("Could not start the bundled node agent:\n{e}"), true);
            return false;
        }
    }
    if wait_for_agent(STARTUP_WAIT) {
        return true;
    }
    let log = sidecar_log_path(app);
    splash_msg(
        app,
        &format!("The node agent did not answer on 127.0.0.1:47800 within 20 s.\nSee {log}"),
        true,
    );
    false
}

fn wait_for_agent(max: Duration) -> bool {
    let deadline = Instant::now() + max;
    while Instant::now() < deadline {
        if fetch_status().is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

/// One poll: update tray + window, and respawn our sidecar if it died.
fn refresh_status(app: &AppHandle) {
    let state = app.state::<ShellState>();
    match fetch_status() {
        Ok(st) => {
            state.status_failures.store(0, Ordering::SeqCst);
            let text = st.summary();
            set_tray_status(app, &text, Some(st.enabled));
            if !st.hostname.is_empty() {
                if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = w.set_title(&format!("Swarmlet Node · {}", st.hostname));
                }
            }
            show_page(app, Page::Agent);
        }
        Err(e) => {
            let n = state.status_failures.fetch_add(1, Ordering::SeqCst) + 1;
            if n == 1 {
                logln(app, format!("status unavailable: {e}"));
            }
            set_tray_status(app, "agent not running", None);
            if n >= 2 {
                show_page(app, Page::Splash);
            }
            let ours_dead = state.owns_sidecar.load(Ordering::SeqCst) && state.sidecar_exited.load(Ordering::SeqCst);
            if ours_dead && !state.quitting.load(Ordering::SeqCst) {
                let restarts = state.sidecar_restarts.fetch_add(1, Ordering::SeqCst) + 1;
                if restarts <= MAX_SIDECAR_RESTARTS {
                    logln(app, format!("restarting sidecar ({restarts}/{MAX_SIDECAR_RESTARTS})"));
                    start_owned_sidecar(app);
                } else if restarts == MAX_SIDECAR_RESTARTS + 1 {
                    logln(app, "sidecar restart limit reached; giving up until the app is relaunched");
                    splash_msg(app, &format!("The node agent keeps exiting. See {}", sidecar_log_path(app)), true);
                }
            }
        }
    }
}

fn spawn_sidecar(app: &AppHandle) -> Result<u32, String> {
    let state = app.state::<ShellState>();
    let mut cmd = app.shell().sidecar(SIDECAR_NAME).map_err(|e| e.to_string())?.args(["run"]);
    if let Some(dir) = state.engine_dir.lock().unwrap().clone() {
        cmd = cmd.env("SWARMLET_ENGINE", dir.to_string_lossy().to_string());
    }
    let (mut rx, child) = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.pid();
    state.sidecar_exited.store(false, Ordering::SeqCst);
    state.owns_sidecar.store(true, Ordering::SeqCst);
    *state.sidecar.lock().unwrap() = Some(child);

    // Drain stdout/stderr into sidecar.log; the plugin's channel is bounded, so this must run.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => sidecar_log(&app, &line),
                CommandEvent::Error(e) => logln(&app, format!("sidecar io error: {e}")),
                CommandEvent::Terminated(p) => {
                    logln(&app, format!("sidecar pid {pid} exited (code {:?}, signal {:?})", p.code, p.signal));
                    let state = app.state::<ShellState>();
                    state.sidecar_exited.store(true, Ordering::SeqCst);
                    state.sidecar.lock().unwrap().take();
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(pid)
}

/// SIGTERM first so the agent can stop its engine processes, then kill after STOP_GRACE.
fn stop_sidecar(app: &AppHandle) {
    let state = app.state::<ShellState>();
    let child = state.sidecar.lock().unwrap().take();
    let Some(child) = child else { return };
    let pid = child.pid();
    logln(app, format!("stopping sidecar pid {pid} (SIGTERM, {}s grace)", STOP_GRACE.as_secs()));
    let _ = std::process::Command::new("kill").args(["-TERM", &pid.to_string()]).status();
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        if state.sidecar_exited.load(Ordering::SeqCst) || !pid_alive(pid) {
            logln(app, format!("sidecar pid {pid} stopped"));
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    logln(app, format!("sidecar pid {pid} still running; killing"));
    let _ = child.kill();
}

fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// `swarmlet-node install` writes one of these; when present the service owns the port.
fn service_installed(app: &AppHandle) -> bool {
    let Ok(home) = app.path().home_dir() else { return false };
    let path = if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents/ai.swarmlet.node.plist")
    } else {
        home.join(".config/systemd/user/swarmlet-node.service")
    };
    path.exists()
}

/// Bundled engine resources (tauri.conf.json bundle.resources maps binaries/engine/* -> engine/).
fn engine_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resolve("engine", BaseDirectory::Resource).ok()?;
    if dir.join("ggml-rpc-server").is_file() || dir.join("llama-server").is_file() {
        Some(dir)
    } else {
        None
    }
}

// ---------- agent HTTP API (loopback, no TLS: a few lines of HTTP/1.1 over std TcpStream) ----------

fn fetch_status() -> Result<AgentStatus, String> {
    let (code, body) = agent_request("GET", "/api/status", None)?;
    if code != 200 {
        return Err(format!("GET /api/status -> {code}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("status json: {e}"))
}

fn set_enabled(enabled: bool) -> Result<(), String> {
    let body = format!("{{\"enabled\":{enabled}}}");
    let (code, resp) = agent_request("POST", "/api/enabled", Some(&body))?;
    if code == 200 {
        Ok(())
    } else {
        Err(format!("POST /api/enabled -> {code}: {}", resp.trim()))
    }
}

fn agent_request(method: &str, path: &str, body: Option<&str>) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], AGENT_PORT));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).map_err(|e| format!("connect: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(4)));

    let body = body.unwrap_or("");
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{AGENT_PORT}\r\nConnection: close\r\nAccept: application/json\r\n");
    if !body.is_empty() {
        req.push_str("Content-Type: application/json\r\n");
    }
    req.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
    stream.write_all(req.as_bytes()).map_err(|e| format!("write: {e}"))?;

    let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
    let mut chunk = [0u8; 16 * 1024];
    let mut header_end: Option<usize> = None;
    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    loop {
        if let Some(he) = header_end {
            match content_length {
                Some(cl) if buf.len() >= he + cl => break,
                None if chunked && buf.ends_with(b"0\r\n\r\n") => break,
                _ => {}
            }
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => break,
            Err(e) => return Err(format!("read: {e}")),
        }
        if header_end.is_none() {
            if let Some(pos) = find(&buf, b"\r\n\r\n") {
                header_end = Some(pos + 4);
                let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                for line in head.lines().skip(1) {
                    if let Some((k, v)) = line.split_once(':') {
                        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
                        if k == "content-length" {
                            content_length = v.parse().ok();
                        } else if k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked") {
                            chunked = true;
                        }
                    }
                }
            }
        }
    }
    let he = header_end.ok_or_else(|| "malformed response: no header terminator".to_string())?;
    let head = String::from_utf8_lossy(&buf[..he]).to_string();
    let code: u16 = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "malformed status line".to_string())?;
    let raw = &buf[he..];
    let body = if chunked { decode_chunked(raw) } else { raw.to_vec() };
    Ok((code, String::from_utf8_lossy(&body).to_string()))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn decode_chunked(mut raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(le) = find(raw, b"\r\n") {
        let size_line = String::from_utf8_lossy(&raw[..le]).to_string();
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("0").trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = le + 2;
        if raw.len() < start + size {
            out.extend_from_slice(&raw[start.min(raw.len())..]);
            break;
        }
        out.extend_from_slice(&raw[start..start + size]);
        raw = &raw[(start + size + 2).min(raw.len())..];
    }
    out
}

// ---------- logging ----------

fn init_logs(app: &AppHandle) {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = fs::create_dir_all(&dir);
        let open = |name: &str, cap: u64| {
            let p = dir.join(name);
            let truncate = fs::metadata(&p).map(|m| m.len() > cap).unwrap_or(false);
            OpenOptions::new().create(true).append(!truncate).write(true).truncate(truncate).open(&p).ok()
        };
        let state = app.state::<ShellState>();
        *state.shell_log.lock().unwrap() = open("shell.log", SIDECAR_LOG_CAP);
        *state.sidecar_log.lock().unwrap() = open("sidecar.log", SIDECAR_LOG_CAP);
        *state.log_dir.lock().unwrap() = Some(dir);
    }
    logln(app, format!("Swarmlet Node shell {} starting (args: {:?})", env!("CARGO_PKG_VERSION"), std::env::args().skip(1).collect::<Vec<_>>()));
}

fn logln(app: &AppHandle, msg: impl AsRef<str>) {
    let line = format!("{} {}\n", utc_now(), msg.as_ref());
    eprint!("{line}");
    if let Some(f) = app.state::<ShellState>().shell_log.lock().unwrap().as_mut() {
        let _ = f.write_all(line.as_bytes());
    }
}

fn sidecar_log(app: &AppHandle, line: &[u8]) {
    if let Some(f) = app.state::<ShellState>().sidecar_log.lock().unwrap().as_mut() {
        let _ = f.write_all(line);
        if !line.ends_with(b"\n") {
            let _ = f.write_all(b"\n");
        }
    }
}

fn sidecar_log_path(app: &AppHandle) -> String {
    app.state::<ShellState>()
        .log_dir
        .lock()
        .unwrap()
        .as_ref()
        .map(|d| d.join("sidecar.log").display().to_string())
        .unwrap_or_else(|| "the shell log directory".into())
}

/// UTC timestamp without pulling in a date crate (Howard Hinnant's civil-from-days).
fn utc_now() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}
