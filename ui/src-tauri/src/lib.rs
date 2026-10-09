//! Tauri backend for the configuration window.
//!
//! The window edits the same TOML the engine hot-reloads, through the shared
//! `companion-core` types, so both sides agree on the schema. Live status and
//! "detect input" come from the engine's named pipe (see the engine's `ipc.rs`),
//! re-emitted to the webview as the `engine` event.

use companion_core::presets::DEFAULT_CONFIG_TOML;
use companion_core::Config;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const ACTIONS_CATALOG: &str = include_str!("../../../presets/actions.json");
const APPS_CATALOG: &str = include_str!("../../../presets/apps.json");

/// Per-application catalog: match rules, the app's own shortcuts, defaults.
#[tauri::command]
fn app_catalog() -> Result<serde_json::Value, String> {
    serde_json::from_str(APPS_CATALOG).map_err(err)
}
const SOCKET_NAME: &str = "CreateCompanion.sock";

/// Mirrors the engine's `ipc::socket_name`: a named pipe on Windows, a
/// socket file in the configuration folder elsewhere.
fn socket_name() -> Result<interprocess::local_socket::Name<'static>, String> {
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        SOCKET_NAME.to_ns_name::<GenericNamespaced>().map_err(err)
    }
    #[cfg(not(windows))]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        let dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("CreateCompanion");
        dir.join(SOCKET_NAME)
            .to_fs_name::<GenericFilePath>()
            .map_err(err)
    }
}

/// File name of the engine next to this executable.
#[cfg(windows)]
const ENGINE_EXE: &str = "create-companion.exe";
#[cfg(not(windows))]
const ENGINE_EXE: &str = "create-companion";

/// Last known engine state, so a webview that subscribes after the pipe
/// connected can catch up (`engine_state` command).
#[derive(Default, Clone, Serialize)]
struct EngineState {
    connected: bool,
    hello: Option<serde_json::Value>,
    status: Option<serde_json::Value>,
}

static ENGINE_STATE: Mutex<EngineState> = Mutex::new(EngineState {
    connected: false,
    hello: None,
    status: None,
});

fn remember(v: &serde_json::Value) {
    if let Ok(mut st) = ENGINE_STATE.lock() {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("connected") => st.connected = true,
            Some("disconnected") => {
                st.connected = false;
                st.status = None;
            }
            Some("hello") => {
                st.connected = true;
                st.hello = Some(v.clone());
            }
            Some("status") => st.status = Some(v.clone()),
            _ => {}
        }
    }
}

#[tauri::command]
fn engine_state() -> EngineState {
    ENGINE_STATE.lock().map(|s| s.clone()).unwrap_or_default()
}

/// Write half of the engine pipe, while connected.
static ENGINE_TX: Mutex<Option<Box<dyn std::io::Write + Send>>> = Mutex::new(None);

/// Send one command object to the engine (`{"cmd":"learn","on":true}`).
#[tauri::command]
fn engine_send(command: serde_json::Value) -> Result<(), String> {
    let mut guard = ENGINE_TX.lock().map_err(|_| "engine link poisoned")?;
    let Some(tx) = guard.as_mut() else {
        return Err("engine not connected".into());
    };
    let line = serde_json::to_string(&command).map_err(err)? + "\n";
    tx.write_all(line.as_bytes()).map_err(err)?;
    tx.flush().map_err(err)
}

/// Start the engine (`create-companion.exe` next to this executable) if it is
/// not connected. The engine's single-instance guard makes a duplicate exit.
#[tauri::command]
fn start_engine() -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(err)?
        .parent()
        .map(|d| d.join(ENGINE_EXE))
        .ok_or("no parent directory")?;
    if !exe.exists() {
        return Err(format!("{} not found", exe.display()));
    }
    std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap())
        .spawn()
        .map(|_| ())
        .map_err(err)
}

/// Write a text file chosen through the save dialog (exports).
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(err)
}

fn config_file() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("CreateCompanion");
    // Same one-time rename the engine performs (see companion-engine paths.rs).
    let legacy = base.join("NayaCompanion");
    if legacy.is_dir() && !dir.exists() {
        let _ = std::fs::rename(&legacy, &dir);
    }
    dir.join("config.toml")
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
struct Loaded {
    path: String,
    config: serde_json::Value,
    created: bool,
}

/// Read the config (creating the bundled default on first run), as JSON.
#[tauri::command]
fn load_config() -> Result<Loaded, String> {
    let path = config_file();
    let mut created = false;
    if !path.exists() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        std::fs::write(&path, DEFAULT_CONFIG_TOML).map_err(err)?;
        created = true;
    }
    let text = std::fs::read_to_string(&path).map_err(err)?;
    let mut cfg = Config::from_toml(&text).map_err(|e| format!("{e:#}"))?;
    backfill_names(&mut cfg);
    Ok(Loaded {
        path: path.display().to_string(),
        config: serde_json::to_value(&cfg).map_err(err)?,
        created,
    })
}

/// Configs written before bindings had a `name` get the bundled default's
/// label wherever the action is still the default one.
fn backfill_names(cfg: &mut Config) {
    let Ok(defaults) = Config::from_toml(DEFAULT_CONFIG_TOML) else {
        return;
    };
    let fill = |p: &mut companion_core::profile::Profile, d: &companion_core::profile::Profile| {
        for (ev, b) in p.bindings.iter_mut() {
            if b.name.is_none() {
                if let Some(db) = d.bindings.get(ev) {
                    if db.action == b.action {
                        b.name = db.name.clone();
                    }
                }
            }
        }
    };
    fill(&mut cfg.default_profile, &defaults.default_profile);
    for p in cfg.profiles.iter_mut() {
        // Same name, or (older configs) a shared executable / bundle id with
        // the same kind of title rule -- "Photoshop" vs "Adobe Photoshop".
        let by_name = defaults
            .profiles
            .iter()
            .find(|d| d.name.eq_ignore_ascii_case(&p.name));
        let by_app = defaults.profiles.iter().find(|d| {
            d.app_match.has_title_rule() == p.app_match.has_title_rule()
                && (d.app_match.windows_exe.iter().any(|e| {
                    p.app_match
                        .windows_exe
                        .iter()
                        .any(|x| x.eq_ignore_ascii_case(e))
                }) || d
                    .app_match
                    .macos_bundle
                    .iter()
                    .any(|b| p.app_match.macos_bundle.contains(b)))
        });
        if let Some(d) = by_name.or(by_app) {
            fill(p, d);
        }
    }
}

/// Validate and write the config atomically. The engine's watcher applies it.
#[tauri::command]
fn save_config(config: serde_json::Value) -> Result<(), String> {
    let cfg: Config = serde_json::from_value(config).map_err(|e| format!("invalid config: {e}"))?;
    cfg.transport_table().map_err(|e| e.to_string())?;
    for p in std::iter::once(&cfg.default_profile)
        .chain(std::iter::once(&cfg.god_mode))
        .chain(cfg.profiles.iter())
    {
        for (ev, b) in &p.bindings {
            if let companion_core::action::Action::Keys { chord, .. } = &b.action {
                chord
                    .0
                    .parse::<companion_core::keys::ParsedChord>()
                    .map_err(|e| format!("{} / {ev}: {e}", p.name))?;
            }
        }
    }
    let text = cfg.to_toml().map_err(|e| e.to_string())?;
    let path = config_file();
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, text).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)?;
    Ok(())
}

/// The bundled default config as JSON (for "reset profile to defaults").
#[tauri::command]
fn default_config() -> Result<serde_json::Value, String> {
    let cfg = Config::from_toml(DEFAULT_CONFIG_TOML).map_err(|e| format!("{e:#}"))?;
    serde_json::to_value(&cfg).map_err(err)
}

/// The action catalog generated from the bundled reference data.
#[tauri::command]
fn action_catalog() -> Result<serde_json::Value, String> {
    serde_json::from_str(ACTIONS_CATALOG).map_err(err)
}

#[derive(Serialize)]
struct WindowInfo {
    exe: String,
    title: String,
}

/// Visible top-level windows, for the "add application" picker.
#[tauri::command]
fn running_windows() -> Vec<WindowInfo> {
    #[cfg(windows)]
    {
        let mut v: Vec<WindowInfo> = companion_platform::windows::visible_windows()
            .into_iter()
            .filter(|w| !w.exe.eq_ignore_ascii_case("create-companion-ui.exe"))
            .map(|w| WindowInfo {
                exe: w.exe,
                title: w.title,
            })
            .collect();
        v.sort_by(|a, b| a.exe.to_lowercase().cmp(&b.exe.to_lowercase()));
        v
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Validate a chord string as typed / recorded in the UI.
#[tauri::command]
fn validate_chord(chord: String) -> Result<String, String> {
    chord
        .parse::<companion_core::keys::ParsedChord>()
        .map(|c| c.to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_config_folder() -> Result<(), String> {
    let dir = config_file()
        .parent()
        .map(Path::to_path_buf)
        .ok_or("no config dir")?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(err)
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        Err("unsupported".into())
    }
}

/// Connect to the engine's pipe and forward every JSON line to the webview
/// as the `engine` event. Reconnects while the window is open.
fn spawn_engine_listener(app: AppHandle) {
    let emit = move |v: serde_json::Value| {
        remember(&v);
        let _ = app.emit("engine", v);
    };
    std::thread::Builder::new()
        .name("ui-engine-listener".into())
        .spawn(move || {
            use interprocess::local_socket::{prelude::*, Stream};
            loop {
                let Ok(name) = socket_name() else {
                    return;
                };
                match Stream::connect(name) {
                    Ok(stream) => {
                        let (recv, send) = stream.split();
                        if let Ok(mut g) = ENGINE_TX.lock() {
                            *g = Some(Box::new(send));
                        }
                        emit(serde_json::json!({"type": "connected"}));
                        let reader = BufReader::new(recv);
                        for line in reader.lines() {
                            let Ok(line) = line else { break };
                            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                                emit(v);
                            }
                        }
                        if let Ok(mut g) = ENGINE_TX.lock() {
                            *g = None;
                        }
                        emit(serde_json::json!({"type": "disconnected"}));
                    }
                    Err(_) => emit(serde_json::json!({"type": "disconnected"})),
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        })
        .ok();
}

// ---- Updates ---------------------------------------------------------------
//
// The engine does the weekly look (when the user said yes); installing happens
// here, through Tauri's updater, which refuses a download whose signature does
// not match the public key in tauri.conf.json. On Windows the installer takes
// over and this process exits (the installer's hooks stop and restart the
// engine); on macOS the app bundle is swapped in place and the engine is
// restarted from it below.

/// The update the last check found, held for the install that follows.
struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
struct UpdateOffer {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

/// One line in the log folder's `update.log`, so a failed update can be read
/// after the fact (the window is gone by then, or never shown with --update-now).
fn update_log(msg: &str) {
    use std::io::Write;
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("update.log"))
    {
        let _ = writeln!(f, "{secs} {msg}");
    }
}

/// The engine's log folder (companion-engine paths.rs).
fn log_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            return home.join("Library/Logs/CreateCompanion");
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("CreateCompanion")
        .join("logs")
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let url = companion_core::updates::manifest_url()
        .parse()
        .map_err(err)?;
    let handle = app.clone();
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(err)?
        // Windows: the last thing before the installer takes over. Replacing the
        // hook drops the plugin's own cleanup, so it is called here too.
        .on_before_exit(move || {
            update_log("handing over to the installer");
            handle.cleanup_before_exit();
        })
        .build()
        .map_err(err)
}

async fn find_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let found = updater(app)?.check().await.map_err(err);
    match &found {
        Ok(Some(u)) => update_log(&format!(
            "check: {} available (running {})",
            u.version, u.current_version
        )),
        Ok(None) => update_log("check: up to date"),
        Err(e) => update_log(&format!("check failed: {e}")),
    }
    found
}

/// Ask the release manifest whether there is something newer than this build.
#[tauri::command]
async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateOffer>, String> {
    let found = find_update(&app).await?;
    let offer = found.as_ref().map(|u| UpdateOffer {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *pending.0.lock().map_err(|_| "update state poisoned")? = found;
    Ok(offer)
}

/// Install what `update_check` found, reporting progress as `update-progress`
/// events. Windows: does not return (the installer replaces this program and
/// starts it again). macOS: restarts the engine and then this window.
#[tauri::command]
async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "update state poisoned")?
        .take()
        .ok_or("no update to install; check again")?;
    install(&app, update).await?;
    app.restart();
}

async fn install(app: &AppHandle, update: Update) -> Result<(), String> {
    update_log(&format!(
        "installing {} over {}",
        update.version, update.current_version
    ));
    let progress = app.clone();
    let mut received: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk, total| {
                received += chunk as u64;
                let _ = progress.emit(
                    "update-progress",
                    serde_json::json!({ "received": received, "total": total }),
                );
            },
            || update_log("downloaded, signature verified"),
        )
        .await;
    if let Err(e) = result {
        update_log(&format!("install failed: {e}"));
        return Err(e.to_string());
    }
    // Only macOS gets here: the bundle holds the new engine, the old one still runs.
    restart_engine();
    update_log("installed");
    Ok(())
}

/// Ask the running engine to quit, wait for it to let go of its single-instance
/// guard, and start the one now next to this executable.
fn restart_engine() {
    if engine_state().connected {
        let _ = engine_send(serde_json::json!({ "cmd": "quit" }));
        for _ in 0..50 {
            std::thread::sleep(Duration::from_millis(100));
            if !engine_state().connected {
                break;
            }
        }
        #[cfg(unix)]
        if engine_state().connected {
            update_log("engine did not quit when asked; stopping it");
            let _ = std::process::Command::new("pkill")
                .args(["-x", ENGINE_EXE])
                .status();
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    match start_engine() {
        Ok(()) => update_log("engine started from the updated app"),
        Err(e) => update_log(&format!("engine restart failed: {e}")),
    }
}

/// `--update-now`: check and install without a window, then exit. For the
/// updater test and for scripted installs; the window path is the same code.
async fn update_now(app: &AppHandle) -> Result<(), String> {
    match find_update(app).await? {
        // No window to bring back: the installer's hook starts the engine.
        Some(update) => install(app, update.restart_after_install(false)).await,
        None => Ok(()),
    }
}

/// How the window was launched: `--updates` (the tray's "Check for updates...")
/// opens it on the Updates panel.
#[tauri::command]
fn launch_flags() -> serde_json::Value {
    serde_json::json!({ "updates": std::env::args().any(|a| a == "--updates") })
}

/// This build's version, the one the updater compares against.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// A newer version the engine's weekly check already found, read from the file
/// it keeps next to the configuration, so opening the window costs no request.
/// `None` when checks are off or nothing newer is known.
#[tauri::command]
fn update_known(app: AppHandle) -> Option<String> {
    let path = config_file();
    let cfg = Config::from_toml(&std::fs::read_to_string(&path).ok()?).ok()?;
    if cfg.engine.check_for_updates != Some(true) {
        return None;
    }
    let state = std::fs::read_to_string(path.parent()?.join("update-check.json")).ok()?;
    let latest = serde_json::from_str::<serde_json::Value>(&state)
        .ok()?
        .get("latest")?
        .as_str()?
        .to_string();
    let current = app.package_info().version.to_string();
    companion_core::updates::is_newer(&latest, &current).then_some(latest)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            default_config,
            action_catalog,
            app_catalog,
            running_windows,
            validate_chord,
            open_config_folder,
            engine_state,
            engine_send,
            write_text_file,
            start_engine,
            update_check,
            update_install,
            launch_flags,
            app_version,
            update_known,
        ])
        .setup(|app| {
            spawn_engine_listener(app.handle().clone());
            if std::env::args().any(|a| a == "--update-now") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let code = match update_now(&handle).await {
                        Ok(()) => 0,
                        Err(_) => 1,
                    };
                    handle.exit(code);
                });
                return Ok(());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Create Companion UI");
}
