//! Platform-independent core of Create Companion.
//!
//! Pipeline (see `docs/scope.md` §7 and §23):
//!
//! ```text
//! TransportCode (F24, Shift+F19, ...)      -- transport.rs
//!        -> SemanticEvent (TUNE_CW, ...)   -- event.rs
//!        -> Profile for the foreground app -- profile.rs
//!        -> Action (key chord, media, ...) -- action.rs
//! ```
//!
//! Nothing in this crate touches an OS API. Everything is unit-testable on any host.

pub mod accel;
pub mod action;
pub mod config;
pub mod event;
pub mod keys;
pub mod presets;
pub mod profile;
pub mod transport;
pub mod updates;

pub use action::Action;
pub use config::{Config, EngineSettings};
pub use event::SemanticEvent;
pub use keys::{Key, ModifierSet, ParsedChord};
pub use profile::{AppIdentity, Profile, ProfileResolver};
pub use transport::{FunctionKey, Modifiers, TransportCode, TransportTable};
