# Installing Create Companion

## Requirements

- Windows 10 or 11, 64-bit; or macOS 10.15 or later (Intel or Apple Silicon; see [macOS](#macos) below).
- A Naya Create keyboard with a Tune or Touch module, and [OpenFlow](https://github.com/create-collective/openflow)
  to flash the module once.
- No administrator rights needed: the installer is per-user.

## Install

1. Download `Create Companion_<version>_x64-setup.exe` from the
   [Releases page](https://github.com/create-collective/create-companion/releases). The `.sha256` file
   next to it holds the checksum if you want to verify the download:

   ```powershell
   Get-FileHash ".\Create Companion_0.1.0_x64-setup.exe" -Algorithm SHA256
   ```

2. Run the installer. **The installer is not code-signed yet**, so Windows SmartScreen will show
   *"Windows protected your PC"*. Click **More info**, then **Run anyway**. Signing is planned;
   until then the checksum above is the way to confirm you have the file from the Releases page.

3. Click through the installer. It installs to `%LOCALAPPDATA%\Create Companion\`, adds a
   **Create Companion** folder to the Start Menu, and starts the engine. A dial icon appears in
   the system tray.

Nothing else is installed: no services, no drivers. The engine is one process that reads the
keyboard through a standard Windows hook.

## First run

1. Right-click the tray icon and choose **Open configuration…**, or open **Create Companion**
   from the Start Menu. The window's dot next to the name is green when the engine is connected;
   if it isn't, click it (or the **Start engine** button) to start the engine.
2. Go to **Inputs** and decide which key each module gesture sends. The defaults for a Tune are
   F24 clockwise, F23 counter-clockwise, F22 tap, F20/F19/F18/F17 for the four one-finger
   swipes. Add rows for any other gestures you use.
3. Click **Export for OpenFlow…** and import the file in OpenFlow to flash the module. Or flash
   the keys by hand and use **Learn** on each row to capture what the module sends.
4. Star the applications you use under **Available**. Turn the dial: the window shows what was
   detected and what ran.

Start at login is off by default. Turn it on from the tray menu (**Start at login**); the engine
adds itself to the current user's startup entries.

## Upgrade

Download the new installer and run it. It closes the running engine and window, replaces the
programs, and starts the engine again. Your configuration is kept; if its format has changed, the
engine migrates it on first start and keeps the original next to it as
`config.backup-v<N>.toml`.

## Uninstall

*Settings → Apps → Installed apps → Create Companion → Uninstall*, or the uninstaller in the
install folder. It stops the engine, removes the programs and the start-at-login entry.

Your data is left in place, so a reinstall picks up where you left off:

| What | Where |
|---|---|
| Configuration | `%APPDATA%\CreateCompanion\config.toml` (and backups) |
| Logs | `%LOCALAPPDATA%\CreateCompanion\logs\` |

Delete those two folders to remove everything.

## Troubleshooting

- **A gesture does nothing.** Open the configuration window and repeat the gesture. A banner
  tells you which of three things happened: the key is not one of your inputs (add it under
  Inputs), the gesture is known but has no action in the active profile or System (bind it), or
  it ran and the action didn't do what you expected in that app (change it).
- **The engine isn't running.** Click the grey dot next to the app name, or start
  *Create Companion* from the Start Menu; the window starts the engine if needed. The log in
  `%LOCALAPPDATA%\CreateCompanion\logs\` records every decoded gesture and action.
- **Holding a modifier key by hand.** A modifier you hold yourself is ignored when decoding a
  gesture, so the dial keeps working while you hold Shift or Alt for something else; the action
  is sent with your modifier still down.
- **Alt+Tab replacements.** Tools such as DisplayFusion replace Windows' window switcher and
  also capture Ctrl+Alt+Tab; their switchers don't take arrow keys in sticky mode. To drive the
  switcher from the dial, disable the tool's Alt+Tab handler so Windows' own switcher is used;
  the bundled *Task View* profile matches it.
- **Windows Defender or SmartScreen flags the installer.** Expected while the installer is
  unsigned; verify the checksum and choose *Run anyway*.

## macOS

Create Companion on macOS is a menu-bar program plus the same configuration window. Download
`Create Companion_<version>_universal.dmg` from the Releases page, open it, and drag
**Create Companion** into Applications. One build runs on both Intel and Apple Silicon Macs.

**First launch.** The app is not notarized yet, so Gatekeeper blocks a double-click. Right-click
(or Control-click) the app in Applications and choose **Open**, then **Open** again in the
dialog. On macOS 15 and later the first attempt shows a warning instead; go to
*System Settings → Privacy & Security*, scroll to the message about Create Companion, and choose
**Open Anyway**. This is needed once.

**Permissions.** macOS gates what the engine does behind two switches in
*System Settings → Privacy & Security*. The engine asks for them on first start and logs which
one is missing:

| Permission | Why | Without it |
|---|---|---|
| **Input Monitoring** | to see the F-keys the module sends | no gesture is ever detected |
| **Accessibility** | to send the mapped shortcuts and read window titles for website profiles | gestures are detected but nothing happens |

After granting either one, quit the engine from its menu-bar icon and start it again from
Applications; macOS applies the permission to a fresh process.

**What's different from Windows.** macOS has no F21–F24, so the first-run configuration uses
F13–F20 (the README's Mac defaults) and Cmd-based shortcuts in the bundled profiles. A
configuration file created by an earlier Windows-style build keeps its F21–F24 inputs; the log
says so at start. Fix it under **Inputs**, or delete the file to get the macOS defaults. Cmd is the modifier the catalog's Mac shortcuts use, and Fn shortcuts work if the
module can send Fn. Files live in `~/Library/Application Support/CreateCompanion/` (configuration)
and `~/Library/Logs/CreateCompanion/` (logs). Start at login is a per-user LaunchAgent, switched
from the menu-bar icon. To remove everything, delete the app from Applications and those two
folders, plus `~/Library/LaunchAgents/dev.createcompanion.engine.plist` if start at login was on.

## Building the installer yourself

```powershell
git clone https://github.com/create-collective/create-companion
cd create-companion
powershell -ExecutionPolicy Bypass -File tools\build_installer.ps1
```

Requires Rust (stable MSVC), Node.js 22 and the Visual Studio Build Tools. The script builds the
engine, bundles it into the configuration window's Tauri installer, and writes
`target\release\bundle\nsis\Create Companion_<version>_x64-setup.exe` with a `.sha256` next to it.
Close any running Create Companion first; the build replaces its executables.

On a Mac, `bash tools/build_installer.sh` does the same with Xcode's command-line tools, Rust
(both Apple targets are added automatically) and Node.js 22, writing the universal dmg to
`target/universal-apple-darwin/release/bundle/dmg/`.
