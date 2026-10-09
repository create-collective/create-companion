//! On-disk configuration (TOML). Versioned from day one; see `docs/PLAN.md` §6.
//!
//! Transport mapping, semantic events, application matching and actions are
//! kept as separate concepts (scope §14).

use crate::accel::AccelSettings;
use crate::event::SemanticEvent;
use crate::profile::{Profile, ProfileResolver};
use crate::transport::{TransportCode, TransportError, TransportTable};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Schema history:
/// - 1: initial (transport, default_profile "Default", profiles).
/// - 2 (2026-09-05): fallback profile named "System"; `god_mode` profile;
///   `system_position`; profile `enabled`; binding `name`, `follow`,
///   `multiplier`, `hold_ms`; input `follow`; engine `namespace_window_ms`,
///   `stream_gap_ms`, `[engine.accel]`. Every v2 field has a default, so a v1
///   file parses as-is; migration renames the fallback profile and stamps the
///   new version so the file is rewritten in the current shape.
///   Later optional v2 fields: engine `check_for_updates` (2026-10-09).
pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Engine-level settings that are not about mappings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct EngineSettings {
    /// Register the engine to start at login (HKCU Run key / LaunchAgent).
    pub start_at_login: bool,
    /// `error` | `warn` | `info` | `debug` | `trace`. `RUST_LOG` overrides.
    pub log_level: String,
    /// A modifier counts as part of a module's key only if it went down within
    /// this many milliseconds before the F-key; a modifier held longer is the
    /// user's and is ignored for decoding. Read at engine start.
    pub namespace_window_ms: u32,
    /// For a streamed gesture that is not set to follow, keys arriving within
    /// this many milliseconds of the previous one belong to the same swipe and
    /// are dropped (the first key already fired). Slow swipes pause up to
    /// ~200 ms between keys, so keep this above that.
    pub stream_gap_ms: u32,
    /// Look for a new release once a week (see `updates.rs`). Absent until the
    /// user has answered the question the configuration window asks once;
    /// nothing is checked before a yes. Written before `accel`: TOML wants the
    /// plain values of a table ahead of its sub-tables.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check_for_updates: Option<bool>,
    /// Dial acceleration curves and the repeat cap (`[engine.accel]`).
    pub accel: AccelSettings,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            start_at_login: false,
            log_level: "info".into(),
            namespace_window_ms: 100,
            stream_gap_ms: 300,
            check_for_updates: None,
            accel: AccelSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "current_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub engine: EngineSettings,
    /// Wire code -> semantic event. Keyed by event so each gesture appears
    /// once; duplicate codes are caught when building the table.
    #[serde(default)]
    pub transport: BTreeMap<SemanticEvent, InputEntry>,
    /// The fallback profile ("System"): used when no app profile binds an event.
    #[serde(default)]
    pub default_profile: Profile,
    /// The override profile ("God Mode"): its bindings win everywhere, whatever
    /// is in the foreground. Meant for gestures reserved for system-wide use.
    #[serde(default = "god_mode_default")]
    pub god_mode: Profile,
    #[serde(default)]
    pub profiles: Vec<Profile>,
    /// Where the System row sits in the UI's Active list: the number of
    /// enabled app profiles listed above it. Display order only; resolution
    /// does not depend on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_position: Option<u32>,
}

pub const GOD_MODE_NAME: &str = "God Mode";
pub const SYSTEM_PROFILE_NAME: &str = "System";

fn god_mode_default() -> Profile {
    Profile {
        name: GOD_MODE_NAME.to_string(),
        ..Profile::default()
    }
}

fn current_version() -> u32 {
    CURRENT_SCHEMA_VERSION
}

/// One configured input: the wire code plus per-input options.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputEntry {
    #[serde(flatten)]
    pub code: TransportCode,
    /// For gestures the module streams (see `SemanticEvent::streams`): send
    /// every key of the run so the action follows the swipe's length. Off
    /// (the default) collapses a run into one event. A binding may override
    /// this per profile.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub follow: bool,
}

impl From<TransportCode> for InputEntry {
    fn from(code: TransportCode) -> Self {
        Self {
            code,
            follow: false,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error(
        "config schema version {0} is newer than this build supports ({CURRENT_SCHEMA_VERSION})"
    )]
    TooNew(u32),
    #[error(transparent)]
    Transport(#[from] TransportError),
    #[error("parse error: {0}")]
    Parse(#[from] toml::de::Error),
    #[error("serialize error: {0}")]
    Serialize(#[from] toml::ser::Error),
}

impl Config {
    /// Parse and migrate to the current schema.
    pub fn from_toml(text: &str) -> Result<Self, ConfigError> {
        Ok(Self::parse(text)?.0)
    }

    /// Parse and migrate; also reports the schema version the file was in
    /// when it was older than the current one (so callers can rewrite it).
    pub fn parse(text: &str) -> Result<(Self, Option<u32>), ConfigError> {
        let mut cfg: Config = toml::from_str(text)?;
        if cfg.schema_version > CURRENT_SCHEMA_VERSION {
            return Err(ConfigError::TooNew(cfg.schema_version));
        }
        let from = (cfg.schema_version < CURRENT_SCHEMA_VERSION).then_some(cfg.schema_version);
        cfg.migrate();
        cfg.transport_table()?; // validate duplicates eagerly
        Ok((cfg, from))
    }

    /// Bring any older-or-equal schema up to the current one. Idempotent.
    fn migrate(&mut self) {
        // v1 -> v2: the fallback profile was called "Default"; God Mode did not exist.
        if self.default_profile.name.is_empty() || self.default_profile.name == "Default" {
            self.default_profile.name = SYSTEM_PROFILE_NAME.to_string();
        }
        if self.god_mode.name.is_empty() {
            self.god_mode.name = GOD_MODE_NAME.to_string();
        }
        self.schema_version = CURRENT_SCHEMA_VERSION;
    }

    pub fn to_toml(&self) -> Result<String, ConfigError> {
        Ok(toml::to_string_pretty(self)?)
    }

    pub fn transport_table(&self) -> Result<TransportTable, TransportError> {
        let mut t = TransportTable::new();
        for (ev, entry) in &self.transport {
            t.insert(entry.code, *ev)?;
        }
        Ok(t)
    }

    /// The input-level default for following a streamed gesture.
    pub fn follow_default(&self, ev: SemanticEvent) -> bool {
        self.transport.get(&ev).is_some_and(|e| e.follow)
    }

    pub fn resolver(&self) -> ProfileResolver {
        ProfileResolver::with_god_mode(
            self.default_profile.clone(),
            self.god_mode.clone(),
            self.profiles.clone(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_for_updates_absent_until_answered() {
        let mut cfg = Config::default();
        let text = cfg.to_toml().unwrap();
        assert!(
            !text.contains("check_for_updates"),
            "unanswered is not written"
        );
        assert_eq!(
            Config::from_toml(&text).unwrap().engine.check_for_updates,
            None
        );

        cfg.engine.check_for_updates = Some(true);
        let text = cfg.to_toml().unwrap();
        assert!(text.contains("check_for_updates = true"));
        assert_eq!(
            Config::from_toml(&text).unwrap().engine.check_for_updates,
            Some(true)
        );
    }

    const SAMPLE: &str = r#"
schema_version = 1

[transport]
TUNE_CW  = { key = "F24" }
TUNE_CCW = { key = "F23" }
TUNE_PRESS = { key = "F22" }
LEFT_TOUCH_SWIPE_LEFT = { key = "F20", mods = "shift" }

[default_profile]
name = "Default"
[default_profile.bindings.TUNE_CW]
action = { type = "media", key = "volume_up" }
accel = "light"
[default_profile.bindings.TUNE_CCW]
action = { type = "media", key = "volume_down" }
accel = "light"
[default_profile.bindings.TUNE_PRESS]
action = { type = "media", key = "mute" }

[[profiles]]
name = "Chrome"
match = { windows_exe = ["chrome.exe", "msedge.exe"], macos_bundle = ["com.google.Chrome"] }
[profiles.bindings.TUNE_CW]
action = { type = "keys", chord = "Ctrl+Tab" }
[profiles.bindings.TUNE_CCW]
action = { type = "keys", chord = "Ctrl+Shift+Tab" }
[profiles.bindings.LEFT_TOUCH_SWIPE_LEFT]
action = { type = "keys", chord = "Alt+Left" }
"#;

    #[test]
    fn parses_sample_and_round_trips() {
        let cfg = Config::from_toml(SAMPLE).unwrap();
        assert_eq!(cfg.transport.len(), 4);
        assert_eq!(cfg.profiles.len(), 1);
        assert_eq!(cfg.default_profile.bindings.len(), 3);

        let table = cfg.transport_table().unwrap();
        assert_eq!(table.len(), 4);

        let text = cfg.to_toml().unwrap();
        let again = Config::from_toml(&text).unwrap();
        assert_eq!(cfg, again);
    }

    #[test]
    fn rejects_duplicate_transport_code() {
        let bad = r#"
[transport]
TUNE_CW  = { key = "F24" }
TUNE_CCW = { key = "F24" }
"#;
        assert!(matches!(
            Config::from_toml(bad),
            Err(ConfigError::Transport(_))
        ));
    }

    #[test]
    fn v1_file_migrates_to_v2() {
        let (cfg, from) = Config::parse(SAMPLE).unwrap();
        assert_eq!(from, Some(1));
        assert_eq!(cfg.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(cfg.default_profile.name, SYSTEM_PROFILE_NAME);
        assert_eq!(cfg.god_mode.name, GOD_MODE_NAME);
        // Rewritten, it is a v2 file that needs no further migration.
        let text = cfg.to_toml().unwrap();
        assert!(text.contains("schema_version = 2"));
        let (again, from2) = Config::parse(&text).unwrap();
        assert_eq!(from2, None);
        assert_eq!(again, cfg);
    }

    #[test]
    fn rejects_future_schema() {
        assert!(matches!(
            Config::from_toml("schema_version = 99"),
            Err(ConfigError::TooNew(99))
        ));
    }
}
