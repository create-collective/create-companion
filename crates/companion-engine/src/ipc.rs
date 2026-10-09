//! Local IPC for the configuration UI: a named pipe (`\\.\pipe\CreateCompanion.sock`
//! on Windows, a Unix socket elsewhere) carrying newline-delimited JSON.
//!
//! Engine -> UI (broadcast to every client):
//!
//! ```json
//! {"type":"hello","version":"0.1.0","config":"C:\\...\\config.toml"}
//! {"type":"status","profile":"Browser","paused":false}
//! {"type":"event","event":"TUNE_CW","profile":"Browser","action":"Ctrl+Tab","repeat":1}
//! {"type":"config_applied"}
//! {"type":"config_rejected","error":"..."}
//! {"type":"learned","key":"F20","mods":"shift"}
//! ```
//!
//! UI -> engine (one JSON object per line):
//!
//! ```json
//! {"cmd":"learn","on":true}
//! {"cmd":"quit"}                  (the window restarts the engine after an update)
//! ```
//!
//! Config edits never go over the pipe; the UI writes the file and the
//! engine's watcher applies it.

use crate::pipeline::Control;
use anyhow::{Context, Result};
use companion_core::transport::{FunctionKey, Modifiers};
use crossbeam_channel::{Receiver, Sender};
use interprocess::local_socket::{prelude::*, ListenerOptions, Name};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};

pub const SOCKET_NAME: &str = "CreateCompanion.sock";

/// Where the socket lives: a named pipe on Windows, a socket file in the
/// configuration folder elsewhere (macOS has no abstract namespace).
pub fn socket_name() -> Result<Name<'static>> {
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        SOCKET_NAME
            .to_ns_name::<GenericNamespaced>()
            .context("socket name")
    }
    #[cfg(not(windows))]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        let path = crate::paths::config_dir().join(SOCKET_NAME);
        // A stale file from a crashed engine would block the bind.
        let _ = std::fs::remove_file(&path);
        path.to_fs_name::<GenericFilePath>().context("socket path")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcMessage {
    Hello {
        version: String,
        config: String,
    },
    Status {
        profile: String,
        paused: bool,
    },
    Event {
        event: String,
        profile: String,
        action: String,
        repeat: u32,
    },
    ConfigApplied,
    ConfigRejected {
        error: String,
    },
    Learned {
        key: FunctionKey,
        mods: Modifiers,
    },
    /// An F13-F24 press (with its modifier namespace) that no input uses.
    Unassigned {
        key: FunctionKey,
        mods: Modifiers,
    },
    /// A recognised gesture that has no binding in the active profile or Default.
    Unbound {
        event: String,
        profile: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum IpcCommand {
    Learn { on: bool },
    Quit,
}

type Clients = Arc<Mutex<Vec<Sender<String>>>>;
/// The most recent `status` line, replayed to every new client after `hello`.
type LastStatus = Arc<Mutex<Option<String>>>;

/// Start the server. Every message received on `rx` is fanned out to all
/// connected clients; `hello` is sent to each client on connect. Commands
/// from clients are translated into [`Control`] messages on `ctrl`; `quit`
/// also calls `on_quit`, which ends the main thread's loop.
pub fn start(
    rx: Receiver<IpcMessage>,
    hello: IpcMessage,
    ctrl: Sender<Control>,
    on_quit: impl Fn() + Clone + Send + 'static,
) -> Result<()> {
    let name = socket_name()?;
    let listener = ListenerOptions::new()
        .name(name)
        .create_sync()
        .context("creating IPC listener")?;
    let clients: Clients = Arc::new(Mutex::new(Vec::new()));
    let hello_line = serde_json::to_string(&hello)? + "\n";
    let last_status: LastStatus = Arc::new(Mutex::new(None));

    // Accept loop: one writer thread and one reader thread per client.
    {
        let clients = Arc::clone(&clients);
        let last_status = Arc::clone(&last_status);
        std::thread::Builder::new()
            .name("cc-ipc-accept".into())
            .spawn(move || {
                for conn in listener.incoming() {
                    let stream = match conn {
                        Ok(s) => s,
                        Err(e) => {
                            tracing::debug!("ipc accept error: {e}");
                            continue;
                        }
                    };
                    let (recv, mut send) = stream.split();
                    if send.write_all(hello_line.as_bytes()).is_err() {
                        continue;
                    }
                    let replay = last_status.lock().ok().and_then(|s| s.clone());
                    if let Some(line) = replay {
                        if send.write_all(line.as_bytes()).is_err() {
                            continue;
                        }
                    }
                    let (tx, rx) = crossbeam_channel::unbounded::<String>();
                    if let Ok(mut c) = clients.lock() {
                        c.push(tx);
                    }
                    std::thread::Builder::new()
                        .name("cc-ipc-client-w".into())
                        .spawn(move || {
                            for line in rx.iter() {
                                if send.write_all(line.as_bytes()).is_err() {
                                    break;
                                }
                            }
                        })
                        .ok();
                    let ctrl = ctrl.clone();
                    let on_quit = on_quit.clone();
                    std::thread::Builder::new()
                        .name("cc-ipc-client-r".into())
                        .spawn(move || {
                            for line in BufReader::new(recv).lines() {
                                let Ok(line) = line else { break };
                                match serde_json::from_str::<IpcCommand>(&line) {
                                    Ok(IpcCommand::Learn { on }) => {
                                        if ctrl.send(Control::SetLearn(on)).is_err() {
                                            break;
                                        }
                                    }
                                    Ok(IpcCommand::Quit) => {
                                        tracing::info!(
                                            "quit requested by the configuration window"
                                        );
                                        let _ = ctrl.send(Control::Quit);
                                        on_quit();
                                        break;
                                    }
                                    Err(e) => tracing::debug!("ipc: ignoring {line:?}: {e}"),
                                }
                            }
                            // A client that goes away never leaves learn mode armed.
                            let _ = ctrl.send(Control::SetLearn(false));
                        })
                        .ok();
                    tracing::debug!("ipc client connected");
                }
            })
            .context("spawning IPC accept thread")?;
    }

    // Fan-out loop.
    std::thread::Builder::new()
        .name("cc-ipc-broadcast".into())
        .spawn(move || {
            for msg in rx.iter() {
                let Ok(mut line) = serde_json::to_string(&msg) else {
                    continue;
                };
                line.push('\n');
                if matches!(msg, IpcMessage::Status { .. }) {
                    if let Ok(mut s) = last_status.lock() {
                        *s = Some(line.clone());
                    }
                }
                if let Ok(mut c) = clients.lock() {
                    c.retain(|tx| tx.send(line.clone()).is_ok());
                }
            }
        })
        .context("spawning IPC broadcast thread")?;
    Ok(())
}
