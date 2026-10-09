//! Create Companion background engine.
//!
//! ```text
//! create-companion                     # tray + engine, config in the user's config folder
//! create-companion --config path.toml  # use another config file (still hot-reloaded)
//! create-companion --no-tray           # console mode, Ctrl+C to quit
//! create-companion --print-config      # dump the bundled default config as TOML and exit
//! create-companion --allow-injected    # also treat synthetic F-keys as transport (testing)
//! ```
//!
//! Logs go to stderr (debug builds / console) and to the log folder (see
//! `paths`). `RUST_LOG` overrides the config's level.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config_store;
mod ipc;
mod paths;
mod pipeline;
#[cfg(any(windows, target_os = "macos"))]
mod tray;
#[cfg(any(windows, target_os = "macos"))]
mod updates;

use anyhow::{Context, Result};
use companion_core::presets::DEFAULT_CONFIG_TOML;
use std::path::PathBuf;

#[cfg(target_os = "macos")]
use companion_platform::macos as plat;
#[cfg(windows)]
use companion_platform::windows as plat;

struct Args {
    config: Option<PathBuf>,
    print_config: bool,
    allow_injected: bool,
    no_tray: bool,
}

fn parse_args() -> Result<Args> {
    let mut args = Args {
        config: None,
        print_config: false,
        allow_injected: false,
        no_tray: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--config" => args.config = Some(it.next().context("--config needs a path")?.into()),
            "--print-config" => args.print_config = true,
            "--allow-injected" => args.allow_injected = true,
            "--no-tray" => args.no_tray = true,
            "-h" | "--help" => {
                println!(
                    "create-companion [--config <file.toml>] [--no-tray] [--print-config] [--allow-injected]"
                );
                std::process::exit(0);
            }
            other => anyhow::bail!("unknown argument `{other}`"),
        }
    }
    Ok(args)
}

fn init_logging(level: &str) -> Result<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));
    let log_dir = paths::log_dir();
    std::fs::create_dir_all(&log_dir).with_context(|| format!("creating {}", log_dir.display()))?;
    let file = tracing_appender::rolling::daily(&log_dir, "companion.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file);

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false).with_writer(std::io::stderr))
        .with(
            fmt::layer()
                .with_target(false)
                .with_ansi(false)
                .with_writer(file_writer),
        )
        .init();
    Ok(guard)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn main() -> Result<()> {
    anyhow::bail!("Create Companion supports Windows and macOS")
}

#[cfg(any(windows, target_os = "macos"))]
#[allow(clippy::default_constructed_unit_structs)] // Sink is a unit struct on Windows only
fn main() -> Result<()> {
    use companion_platform::InputHook;
    use pipeline::{Control, SharedStatus, Status};
    use plat::{
        autostart, foreground_app, foreground_title, hook, instance, message_loop, KeyboardHook,
        Sink,
    };
    use std::sync::{Arc, Mutex};
    use tray::{Tray, TrayAction};

    let args = parse_args()?;
    if args.print_config {
        print!("{DEFAULT_CONFIG_TOML}");
        return Ok(());
    }

    paths::migrate_legacy();
    let _instance = match instance::acquire("CreateCompanion.Engine")? {
        Some(guard) => guard,
        None => {
            eprintln!("create-companion is already running (see the tray icon).");
            return Ok(());
        }
    };

    let config_path = args.config.clone().unwrap_or_else(paths::config_file);
    let config_store::Loaded {
        cfg,
        created,
        migrated_from,
    } = config_store::load_or_create(&config_path)?;
    let _log_guard = init_logging(&cfg.engine.log_level)?;
    tracing::info!(
        config = %config_path.display(),
        version = env!("CARGO_PKG_VERSION"),
        "create-companion starting"
    );
    if created {
        tracing::info!("wrote default configuration (first run)");
    }
    if let Some(v) = migrated_from {
        tracing::info!(
            from = v,
            to = companion_core::config::CURRENT_SCHEMA_VERSION,
            "migrated configuration schema (backup kept next to the file)"
        );
    }

    #[cfg(target_os = "macos")]
    {
        use plat::permissions;
        if !permissions::input_monitoring() {
            tracing::warn!(
                "Input Monitoring is not granted: the keyboard cannot be read. \
                 Allow Create Companion under System Settings > Privacy & Security > Input Monitoring, then restart."
            );
            permissions::request_input_monitoring();
        }
        for (ev, entry) in &cfg.transport {
            if entry.code.key.macos_keycode().is_none() {
                tracing::warn!(
                    input = %ev,
                    key = ?entry.code.key,
                    "macOS never delivers this key; move the input to F13-F20 under Inputs, or delete config.toml to get the macOS defaults"
                );
            }
        }
        if !permissions::accessibility() {
            tracing::warn!(
                "Accessibility is not granted: actions cannot be sent and window titles cannot be read. \
                 Allow Create Companion under System Settings > Privacy & Security > Accessibility."
            );
            permissions::open_settings(permissions::Pane::Accessibility);
        }
    }

    if let Err(e) = autostart::set_enabled(cfg.engine.start_at_login) {
        tracing::warn!("could not apply start_at_login: {e}");
    }

    // Channels: hook -> worker (bounded, hook never blocks), tray/watcher -> worker,
    // worker -> IPC clients (the configuration UI).
    let (ev_tx, ev_rx) = crossbeam_channel::bounded(64);
    let (ctrl_tx, ctrl_rx) = crossbeam_channel::unbounded::<Control>();
    let (ipc_tx, ipc_rx) = crossbeam_channel::unbounded::<ipc::IpcMessage>();

    hook::set_allow_injected(args.allow_injected);
    hook::set_namespace_window_ms(cfg.engine.namespace_window_ms);
    let mut kb_hook = KeyboardHook::new(ev_tx);
    kb_hook.start().context("installing keyboard hook")?;

    let status: SharedStatus = Arc::new(Mutex::new(Status {
        profile: cfg.default_profile.name.clone(),
        ..Default::default()
    }));

    // The main-thread loop and its waker come first: on macOS this also sets
    // up the application object the tray needs.
    let waker = message_loop::Waker::for_current_thread();
    let tray = if args.no_tray {
        None
    } else {
        Some(Tray::new(autostart::is_enabled().unwrap_or(false)).context("creating tray")?)
    };

    if let Err(e) = ipc::start(
        ipc_rx,
        ipc::IpcMessage::Hello {
            version: env!("CARGO_PKG_VERSION").into(),
            config: config_path.display().to_string(),
        },
        ctrl_tx.clone(),
        move || waker.quit(),
    ) {
        tracing::warn!(
            "IPC server unavailable, the configuration UI will not see live status: {e:#}"
        );
    }

    // What the weekly update check offers, handed from its thread to the tray.
    let offered: Arc<Mutex<Option<Option<String>>>> = Arc::new(Mutex::new(None));
    if tray.is_some() {
        let offered = Arc::clone(&offered);
        let config_path = config_path.clone();
        updates::spawn(
            move || {
                config_store::load(&config_path)
                    .map(|c| c.engine.check_for_updates == Some(true))
                    .unwrap_or(false)
            },
            move |version| {
                if let Ok(mut o) = offered.lock() {
                    *o = Some(version);
                }
                waker.wake();
            },
        );
    }

    let worker = {
        let status = Arc::clone(&status);
        let on_status = move || waker.wake();
        std::thread::Builder::new()
            .name("cc-pipeline".into())
            .spawn(move || {
                pipeline::run(
                    cfg,
                    ev_rx,
                    ctrl_rx,
                    status,
                    on_status,
                    foreground_app,
                    foreground_title,
                    hook::set_reserved,
                    hook::set_learn,
                    ipc_tx,
                    Sink::default(),
                )
            })
            .context("spawning pipeline thread")?
    };

    let _watcher = config_store::watch(config_path.clone(), ctrl_tx.clone())?;

    {
        let ctrl_tx = ctrl_tx.clone();
        ctrlc::set_handler(move || {
            tracing::info!("shutting down");
            let _ = ctrl_tx.send(Control::Quit);
            waker.quit();
            // In --no-tray mode there is no message loop to observe the quit.
            std::thread::sleep(std::time::Duration::from_millis(200));
            std::process::exit(0);
        })
        .context("installing Ctrl+C handler")?;
    }

    tracing::info!(tray = tray.is_some(), "create-companion running");

    match tray {
        None => {
            let _ = worker.join();
        }
        Some(tray) => {
            if let Ok(s) = status.lock() {
                tray.set_status(&s);
            }
            message_loop::run(|| {
                for action in tray.poll() {
                    match action {
                        TrayAction::OpenUi => open_ui(&config_path, &[]),
                        TrayAction::Updates => open_ui(&config_path, &["--updates"]),
                        TrayAction::OpenConfigFile => open_path(&config_path),
                        TrayAction::OpenConfigFolder => {
                            if let Some(dir) = config_path.parent() {
                                open_path(dir);
                            }
                        }
                        TrayAction::Reload => match config_store::load(&config_path) {
                            Ok(c) => {
                                let _ = ctrl_tx.send(Control::Reload(Box::new(c)));
                            }
                            Err(e) => tracing::warn!("reload failed: {e:#}"),
                        },
                        TrayAction::SetPaused(p) => {
                            let _ = ctrl_tx.send(Control::SetPaused(p));
                        }
                        TrayAction::SetAutostart(enabled) => {
                            match autostart::set_enabled(enabled) {
                                Ok(()) => {
                                    tray.set_autostart(enabled);
                                    // Persist so the setting survives; the watcher
                                    // will reload, which is harmless.
                                    match config_store::load(&config_path) {
                                        Ok(mut c) => {
                                            c.engine.start_at_login = enabled;
                                            if let Err(e) = config_store::save(&config_path, &c) {
                                                tracing::warn!("could not save config: {e:#}");
                                            }
                                        }
                                        Err(e) => tracing::warn!("could not read config: {e:#}"),
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("autostart change failed: {e}");
                                    tray.set_autostart(!enabled);
                                }
                            }
                        }
                        TrayAction::Quit => {
                            let _ = ctrl_tx.send(Control::Quit);
                            waker.quit();
                        }
                    }
                }
                if let Some(version) = offered.lock().ok().and_then(|mut o| o.take()) {
                    tray.set_update(version.as_deref());
                }
                if let Ok(s) = status.lock() {
                    tray.set_status(&s);
                }
            });
            let _ = worker.join();
        }
    }

    kb_hook.stop();
    tracing::info!("create-companion stopped");
    Ok(())
}

/// File name of the configuration UI next to this binary.
#[cfg(windows)]
const UI_EXE: &str = "create-companion-ui.exe";
#[cfg(target_os = "macos")]
const UI_EXE: &str = "create-companion-ui";

/// Launch the configuration UI (next to this binary) with `args`. Falls back to
/// opening the config file when the UI is not installed.
#[cfg(any(windows, target_os = "macos"))]
fn open_ui(config_path: &std::path::Path, args: &[&str]) {
    let ui = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join(UI_EXE)));
    match ui {
        Some(exe) if exe.exists() => {
            if let Err(e) = std::process::Command::new(&exe).args(args).spawn() {
                tracing::warn!("could not start {}: {e}", exe.display());
            }
        }
        _ => {
            tracing::info!(
                "configuration UI not found next to the engine; opening the config file"
            );
            open_path(config_path);
        }
    }
}

#[cfg(windows)]
fn open_path(path: &std::path::Path) {
    // `explorer` opens folders directly and files with their default handler.
    if let Err(e) = std::process::Command::new("explorer").arg(path).spawn() {
        tracing::warn!("could not open {}: {e}", path.display());
    }
}

#[cfg(target_os = "macos")]
fn open_path(path: &std::path::Path) {
    if let Err(e) = std::process::Command::new("open").arg(path).spawn() {
        tracing::warn!("could not open {}: {e}", path.display());
    }
}
