//! System tray icon and menu (scope §15).
//!
//! ```text
//! Create Companion
//! Active: Photoshop          (disabled, informational)
//! Last: TUNE_CW -> ]         (disabled, informational)
//! ---
//! Open configuration...        (launches create-companion-ui)
//! Edit configuration file
//! Open configuration folder
//! Reload configuration
//! [ ] Pause companion
//! [ ] Start at login
//! Check for updates...         ("Update to 1.0.1..." once a check found one)
//! ---
//! Quit
//! ```

use crate::pipeline::Status;
use anyhow::{Context, Result};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuId, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    OpenUi,
    OpenConfigFile,
    OpenConfigFolder,
    Reload,
    SetPaused(bool),
    SetAutostart(bool),
    /// Open the configuration window on its Updates panel.
    Updates,
    Quit,
}

const CHECK_FOR_UPDATES: &str = "Check for updates...";

pub struct Tray {
    icon: TrayIcon,
    active: MenuItem,
    last: MenuItem,
    pause: CheckMenuItem,
    autostart: CheckMenuItem,
    updates: MenuItem,
    /// The version the last update check offered, for the tooltip.
    offered: std::cell::RefCell<Option<String>>,
    ids: Ids,
}

struct Ids {
    open_ui: MenuId,
    open_file: MenuId,
    open_folder: MenuId,
    reload: MenuId,
    pause: MenuId,
    autostart: MenuId,
    updates: MenuId,
    quit: MenuId,
}

/// 32x32 RGBA of the Track glyph (assets/icon.png), pre-rendered by
/// tools/make_icons.py so no image decoder is needed at runtime.
fn make_icon() -> Result<Icon> {
    const N: u32 = 32;
    const RGBA: &[u8] = include_bytes!("../../../assets/tray-32.rgba");
    Icon::from_rgba(RGBA.to_vec(), N, N).context("building tray icon")
}

impl Tray {
    pub fn new(autostart_enabled: bool) -> Result<Self> {
        let active = MenuItem::new("Active: —", false, None);
        let last = MenuItem::new("Last: —", false, None);
        let open_ui = MenuItem::new("Open configuration...", true, None);
        let open_file = MenuItem::new("Edit configuration file", true, None);
        let open_folder = MenuItem::new("Open configuration folder", true, None);
        let reload = MenuItem::new("Reload configuration", true, None);
        let pause = CheckMenuItem::new("Pause companion", true, false, None);
        let autostart = CheckMenuItem::new("Start at login", true, autostart_enabled, None);
        let updates = MenuItem::new(CHECK_FOR_UPDATES, true, None);
        let quit = MenuItem::new("Quit", true, None);

        let menu = Menu::new();
        menu.append_items(&[
            &active,
            &last,
            &PredefinedMenuItem::separator(),
            &open_ui,
            &open_file,
            &open_folder,
            &reload,
            &pause,
            &autostart,
            &updates,
            &PredefinedMenuItem::separator(),
            &quit,
        ])
        .context("building tray menu")?;

        let icon = TrayIconBuilder::new()
            .with_menu(Box::new(menu))
            .with_tooltip("Create Companion")
            .with_icon(make_icon()?)
            .build()
            .context("creating tray icon")?;

        Ok(Self {
            icon,
            ids: Ids {
                open_ui: open_ui.id().clone(),
                open_file: open_file.id().clone(),
                open_folder: open_folder.id().clone(),
                reload: reload.id().clone(),
                pause: pause.id().clone(),
                autostart: autostart.id().clone(),
                updates: updates.id().clone(),
                quit: quit.id().clone(),
            },
            active,
            last,
            pause,
            autostart,
            updates,
            offered: std::cell::RefCell::new(None),
        })
    }

    pub fn set_status(&self, s: &Status) {
        let state = if s.paused { " (paused)" } else { "" };
        self.active
            .set_text(format!("Active: {}{state}", s.profile));
        self.last.set_text(match (&s.last_event, &s.last_action) {
            (Some(ev), Some(act)) => format!("Last: {ev} \u{2192} {act}"),
            _ => "Last: —".to_string(),
        });
        self.pause.set_checked(s.paused);
        let update = match self.offered.borrow().as_deref() {
            Some(v) => format!("\nUpdate available: {v}"),
            None => String::new(),
        };
        let _ = self.icon.set_tooltip(Some(format!(
            "Create Companion\nProfile: {}{state}{update}",
            s.profile
        )));
    }

    /// The version a check found (the item then installs it), or `None` for the
    /// plain "Check for updates...". The tooltip follows on the next status.
    pub fn set_update(&self, version: Option<&str>) {
        self.updates.set_text(match version {
            Some(v) => format!("Update to {v}..."),
            None => CHECK_FOR_UPDATES.to_string(),
        });
        *self.offered.borrow_mut() = version.map(str::to_string);
    }

    pub fn set_autostart(&self, enabled: bool) {
        self.autostart.set_checked(enabled);
    }

    /// Drain pending menu clicks. Call from the message loop.
    pub fn poll(&self) -> Vec<TrayAction> {
        MenuEvent::receiver()
            .try_iter()
            .filter_map(|ev| {
                let id = ev.id();
                Some(if *id == self.ids.open_ui {
                    TrayAction::OpenUi
                } else if *id == self.ids.open_file {
                    TrayAction::OpenConfigFile
                } else if *id == self.ids.open_folder {
                    TrayAction::OpenConfigFolder
                } else if *id == self.ids.reload {
                    TrayAction::Reload
                } else if *id == self.ids.pause {
                    TrayAction::SetPaused(self.pause.is_checked())
                } else if *id == self.ids.autostart {
                    TrayAction::SetAutostart(self.autostart.is_checked())
                } else if *id == self.ids.updates {
                    TrayAction::Updates
                } else if *id == self.ids.quit {
                    TrayAction::Quit
                } else {
                    return None;
                })
            })
            .collect()
    }
}
