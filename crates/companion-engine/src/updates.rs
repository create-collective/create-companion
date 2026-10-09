//! The weekly update check, when the user said yes to it in the configuration
//! window. The engine only looks: it fetches the release manifest, remembers the
//! newest version it named, and the tray offers it. Installing is the window's
//! job (Tauri's updater, which also verifies the download's signature).

use companion_core::updates::{check_due, is_newer, manifest_url};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CURRENT: &str = env!("CARGO_PKG_VERSION");
/// How often the thread wakes to see whether a check is due and whether the
/// setting changed.
const TICK: Duration = Duration::from_secs(60 * 60);
/// The first request waits this long after the engine starts, out of the way
/// of everything else that runs at login.
const FIRST_DELAY: Duration = Duration::from_secs(2 * 60);

/// What the last check found, kept next to the configuration so a restart
/// does not ask again before the week is over.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    /// Unix seconds of the last successful check.
    pub last_check: Option<u64>,
    /// The version the manifest named then.
    pub latest: Option<String>,
}

pub fn state_file() -> PathBuf {
    crate::paths::config_dir().join("update-check.json")
}

fn load_state(path: &Path) -> State {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(path: &Path, state: &State) {
    let tmp = path.with_extension("json.tmp");
    let written = serde_json::to_string_pretty(state)
        .map_err(anyhow::Error::from)
        .and_then(|t| Ok(std::fs::write(&tmp, t)?))
        .and_then(|()| Ok(std::fs::rename(&tmp, path)?));
    if let Err(e) = written {
        tracing::warn!("could not save {}: {e:#}", path.display());
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
}

/// One request for the manifest; the version it names.
fn fetch_latest(url: &str) -> anyhow::Result<String> {
    Ok(serde_json::from_str::<Manifest>(&get(url)?)?.version)
}

/// A GET that follows GitHub's redirect to its download host.
fn get(url: &str) -> anyhow::Result<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .user_agent(concat!("create-companion/", env!("CARGO_PKG_VERSION")))
        .build()
        .into();
    let mut response = agent.get(url).call()?;
    Ok(response.body_mut().read_to_string()?)
}

/// A newer version than this engine, if the last check named one.
fn pending(state: &State) -> Option<String> {
    state
        .latest
        .as_deref()
        .filter(|v| is_newer(v, CURRENT))
        .map(str::to_string)
}

/// Start the checker thread. `enabled` reads the setting afresh each time (the
/// window edits the configuration file); `show` gets the version the tray
/// should offer, or `None`, whenever that changes, starting with what the
/// previous check found.
pub fn spawn(
    enabled: impl Fn() -> bool + Send + 'static,
    show: impl Fn(Option<String>) + Send + 'static,
) {
    let spawned = std::thread::Builder::new()
        .name("cc-updates".into())
        .spawn(move || {
            let path = state_file();
            let mut state = load_state(&path);
            let mut shown: Option<String> = None;
            let mut report = |offer: Option<String>| {
                if offer != shown {
                    shown = offer.clone();
                    show(offer);
                }
            };
            report(enabled().then(|| pending(&state)).flatten());
            std::thread::sleep(FIRST_DELAY);
            loop {
                let on = enabled();
                if on && check_due(state.last_check, now()) {
                    match fetch_latest(&manifest_url()) {
                        Ok(latest) => {
                            tracing::info!(latest = %latest, current = CURRENT, "checked for updates");
                            state = State {
                                last_check: Some(now()),
                                latest: Some(latest),
                            };
                            save_state(&path, &state);
                        }
                        // Offline, or GitHub unreachable: quietly try again next tick.
                        Err(e) => tracing::info!("update check failed, will retry: {e:#}"),
                    }
                }
                report(on.then(|| pending(&state)).flatten());
                std::thread::sleep(TICK);
            }
        });
    if let Err(e) = spawned {
        tracing::warn!("update checker not started: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_only_for_a_newer_version() {
        let at = |v: &str| State {
            last_check: Some(1),
            latest: Some(v.into()),
        };
        assert_eq!(pending(&at("999.0.0")), Some("999.0.0".into()));
        assert_eq!(pending(&at(CURRENT)), None);
        assert_eq!(pending(&at("0.0.1")), None);
        assert_eq!(pending(&State::default()), None);
    }

    /// HTTPS and the redirect a release download goes through, against a real
    /// asset: `cargo test -p create-companion -- --ignored`.
    #[test]
    #[ignore = "network"]
    fn release_download_over_https() {
        let body = get("https://github.com/create-collective/create-companion/releases/download/v0.4.0/Create.Companion_0.4.0_x64-setup.exe.sha256").unwrap();
        assert!(body.contains("Create"), "{body}");
    }

    #[test]
    fn manifest_version_is_read() {
        let body =
            r#"{"version":"1.0.1","notes":"x","pub_date":"2026-10-09T00:00:00Z","platforms":{}}"#;
        assert_eq!(
            serde_json::from_str::<Manifest>(body).unwrap().version,
            "1.0.1"
        );
    }
}
