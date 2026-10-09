# Release notes

<!-- Each "## <version>" section becomes the GitHub Release body (tools/release_notes.py).
     Describe what a user of the installed app sees. Developer tooling under tools/ (capture
     scripts, gesture plans, generators) stays in the repository for contributors, never ships
     in an installer, and is never mentioned here; the release job refuses a section that does. -->

## Unreleased

- **Updates from inside the app.** The configuration window asks once whether Create Companion
  may check for updates, once a week. Nothing is checked until you say yes, and you can change
  your mind under **Updates…** at the bottom of the window. A check downloads one small file from
  GitHub that names the newest release; nothing about you or your setup is sent.
- When a newer version exists, the tray menu's **Check for updates…** becomes **Update to
  x.y.z…** and the window shows it too. Nothing downloads or installs until you click
  **Install**; the update is checked against Create Companion's own signing key before it runs,
  and the engine restarts on the new version by itself.
- **Signed installers.** Windows shows Travis Wye as the publisher, and the macOS app is signed
  and notarized by Apple, so it opens with a double-click.

Upgrading: install this version by hand one last time; later versions arrive through the app.
On macOS, grant Input Monitoring and Accessibility again once after installing (the app's
signature is new); updates after this one keep them.

## 0.4.0 — Pinch, spread and finger counts

Pinch and spread become inputs of their own, and every input now names how many fingers the
module was flashed for, with each module offering only the counts its firmware really has.

- **Pinch and spread are separate inputs.** They are the two halves of one field and each
  needs its own key, so the Inputs add row now offers **Pinch** and **Spread** on their own and
  no longer offers the combined **Pinch & spread**: a single key for both halves could not tell
  a pinch from a spread. Two fingers only, on the Tune and on a Touch. An existing combined
  pair keeps working; its two rows are what the separate choices create anyway.
- Both send a run of keys scaled to how far the fingers travel, like a two-finger swipe, so
  those rows carry the **One per swipe / Follow swipe** switch. One per swipe is the default:
  the gesture fires its action once.
- **Finger counts follow the module.** The Tune stops at three fingers (it has no 4-finger
  field), so the Inputs page no longer offers **4 fingers** for a Tune tap or swipe. A Touch
  still offers 3 and 4 for taps and 2 to 4 for swipes; pinch and spread stay two fingers.
- **Every input has a finger count.** The **any fingers** choice is gone: an any-count row next
  to a counted row for the same gesture would fight over the same flashed field and send two
  different things. A row from before finger counts still shows "any fingers" until you pick a
  count; the engine's any-count fallback for bindings is unchanged.

Upgrading: nothing to do. Existing rows keep their keys and counts. If an Inputs row shows
"any fingers" (the default Tune swipes on F17 to F20 are such rows), pick the count that Tune
is flashed for; until then that row cannot be exported as a module profile.

## 0.3.0 — Touch support

The Touch module is measured on real hardware, and the engine and the Inputs page
know how it behaves. Flash a Touch so its fields send modifier + F-keys (the 2-finger
scroll axes, the 3-finger swipes and tap, the 4-finger swipes and tap are the fields OpenFlow
can map today) and add them under Inputs like any Tune gesture.

- **Touch runs.** The collapse / *Follow swipe* handling now knows which Touch gestures arrive
  as a run of keys: two-finger scroll (and swipe) in any direction, and the four-finger swipes
  up and down. Three-finger swipes, four-finger left and right, and every tap are single keys
  and are left alone. Measured on a Touch on 2026-09-10; the
  Tune's rule (two-finger swipes) is unchanged. The Inputs page offers *Follow swipe* on those rows.
- **Inputs, what the add row offers.** Double tap and the split scroll axes (*Scroll up & down*,
  *Scroll left & right*) are withheld on every module: the engine only relays a double tap the
  firmware sends, and no module has such a field; a two-finger motion is added as a swipe.
  Pinch & spread is offered at 2 fingers only. Adding a Left or Right Touch input no longer
  offers 1 finger, or a 2-finger tap: the Touch firmware owns those fields (cursor, left and
  right click) and ignores a key written to them, and NayaFlow refuses to map them. Existing
  rows keep their values.

### Known limitations

- A Touch cannot yet be mapped at 1 finger (cursor and left click) or for the 2-finger tap
  (right click): the module firmware owns those fields and ignores a key written to them. Its
  1- and 2-finger swipe fields, double tap and pinch & spread have no known device field yet.
- macOS has no F21–F24; keep a Touch's keys within F13–F20 there.
- Installers are still unsigned on both platforms (SmartScreen warning, Gatekeeper right-click → Open).

### Upgrading

Windows: run the new installer over the old one; it stops the engine, replaces the programs and
restarts. macOS: drag the new app over the old one in Applications. The configuration file
format is unchanged; nothing is migrated.

## 0.2.0 — macOS arrives; Windows polish

### macOS (first release)

Create Companion now runs on macOS 10.15 and later, Intel and Apple Silicon, from one universal
dmg. The engine is a menu-bar program built on a CGEvent tap, with the same configuration
window as Windows.

- Inputs use F13–F20 (macOS has no F21–F24); the first-run configuration and the bundled
  profiles use Mac shortcuts (Cmd+T, Cmd+Z, Ctrl+Up for Mission Control, and so on).
- Needs two permissions in *System Settings → Privacy & Security*: **Input Monitoring** to see
  the module's keys and **Accessibility** to send shortcuts and read window titles. The engine
  asks on first start; quit and reopen it after granting them.
- **Not signed or notarized yet.** Gatekeeper blocks the first launch: right-click → Open on
  Ventura and Sonoma, or *Privacy & Security → Open Anyway* on macOS 15. See INSTALL.md.
- Start at login is a per-user LaunchAgent. Configuration lives in
  `~/Library/Application Support/CreateCompanion/`, logs in `~/Library/Logs/CreateCompanion/`.
- First release on this platform: tested on an Intel MacBook running Ventura. Reports from
  other machines are welcome in Issues.

### Windows and both platforms

- Every search field has a clear button (and Escape clears it).
- Starring an app uses the shortcuts for the platform you are on; several first-wave catalog
  entries had Mac columns that copied the Windows chords (undo/redo, new tab, back/forward,
  zoom) and are corrected.
- Issue templates for bugs, catalog requests and feature requests; Discussions enabled.
- Repository housekeeping: plan and scope documents moved to `docs/`.

### Upgrading

Windows: run the new installer over the old one; it stops the engine, replaces the programs and
restarts. macOS: drag the new app over the old one in Applications. Configuration files are kept
on both.

## 0.1.0 — first release (Windows)

Create Companion turns the Naya Create's Tune (and, soon, Touch) gestures into per-application
shortcuts. Flash the module once; change what its gestures do on the computer, live.

### What you get

- **Engine**: a small tray program that intercepts the F-keys a module sends, decodes the gesture
  (dial, taps and swipes by finger count, with modifier namespaces so two modules can share keys),
  picks a profile by the application in front, and sends the mapped action. Hot-reloads its
  configuration; starts at login if you ask it to.
- **Configuration window**: Active and Available profiles with search; star to enable; preview
  an app's shortcuts before enabling it; drag to set priority; per-gesture actions chosen by name
  from the catalog or recorded from the keyboard; media, scroll, launch and command actions;
  live "detected" strip showing what each gesture did.
- **Catalog**: 162 applications, websites and systems with 22,646 documented shortcuts,
  compiled from vendor documentation with sources cited per entry. Filtered to the running OS,
  with an *All platforms* switch for building a configuration to move to a Mac.
- **Profiles**: System (fallback), God Mode (wins everywhere; for window switching and other
  system-wide gestures), and one per app or site. A site title beats an app; one app beats a
  group; drag order breaks ties.
- **Inputs**: which key each gesture sends, with Learn (capture the module's actual key) and
  Export for OpenFlow (writes module-profile files to flash from).
- **Dial**: speed curves (light / medium / aggressive, tunable in the config) and a per-binding
  multiplier.
- **Two-finger swipes** on the Tune arrive as a run of keys scaled to travel; collapsed to one
  action by default, or set to *Follow swipe* per input or per binding so volume and scroll track
  the swipe.
- **Held modifiers**: a Shift or Alt you hold yourself never changes what a gesture means.
- **Installer**: per-user NSIS installer with both programs, Start Menu entry, starts the engine
  after install, removes the login entry on uninstall, keeps your configuration.

### Known limitations

- Windows only. macOS is next; Linux later.
- The installer is not code-signed yet: SmartScreen shows a warning on first run. Verify the
  `.sha256` from the Releases page.
- Touch modules are not yet measured on real hardware. The engine already handles their key
  ranges and modifier namespaces; how the Touch streams gestures will be characterised when one
  is on the bench, and defaults will follow.
- Hold, long-press and double-tap are not offered: the module firmware reports a tap only on
  finger lift, so there is nothing for the host to build them from.
- Third-party Alt+Tab replacements (DisplayFusion) capture the sticky Ctrl+Alt+Tab switcher as
  well and ignore arrow keys in that mode; disable their handler to drive Windows' switcher from
  the dial.

### Configuration

`%APPDATA%\CreateCompanion\config.toml`, schema version 2. Older files are migrated on load with a
backup kept next to them. Logs in `%LOCALAPPDATA%\CreateCompanion\logs\`.
