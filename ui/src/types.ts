// Mirrors companion-core's serde shapes (see crates/companion-core/src/config.rs).

/** Modifier namespace as the engine serializes it: "none" or "+"-joined lowercase tokens (ctrl, shift, alt, cmd, fn). */
export type Mods = string;
export interface TransportCode {
  key: string;
  mods?: Mods;
  /** Streamed gestures only: send every key of the run (default off = collapse to one). */
  follow?: boolean;
}

export type MediaKey =
  | "volume_up"
  | "volume_down"
  | "mute"
  | "play_pause"
  | "next_track"
  | "previous_track"
  | "brightness_up"
  | "brightness_down";

export type ScrollDirection = "up" | "down" | "left" | "right";

export type Action =
  | { type: "noop" }
  | { type: "keys"; chord: string; hold_ms?: number }
  | { type: "release" }
  | { type: "sequence"; chords: string[] }
  | { type: "media"; key: MediaKey }
  | { type: "scroll"; direction: ScrollDirection; lines?: number }
  | { type: "launch"; program: string; args?: string[] }
  | { type: "command"; command: string };

export type Accel = "none" | "light" | "medium" | "aggressive";

export interface Binding {
  action: Action;
  accel?: Accel;
  /** Plain-English label ("Increase Brush Size"); the action holds the keys. */
  name?: string;
  /** Streamed gestures only: true = every key fires, false = one per swipe, unset = the input's default. */
  follow?: boolean | null;
  /** Actions per detent (or per key of a followed swipe) before the speed curve. Default 1. */
  multiplier?: number;
  /** Catalog defaults only: the macOS action when it differs from `action`. */
  mac?: Action;
}

export interface AppMatch {
  windows_exe: string[];
  macos_bundle: string[];
  window_title: string[];
}

export interface Profile {
  name: string;
  /** Unstarred profiles keep their bindings but never match. */
  enabled?: boolean;
  match: AppMatch;
  bindings: Record<string, Binding>;
}

/** One shortcut an application exposes (presets/apps.json). */
export interface AppAction {
  id: string;
  name: string;
  context: string;
  windows?: Action;
  mac?: Action;
  linux?: Action;
}

/** An application or website the catalog knows about (presets/apps.json). */
export interface AppEntry {
  id: string;
  name: string;
  kind: "app" | "site" | "system";
  category?: string;
  /** System entries only: which OS's shortcuts these are. */
  os?: ("windows" | "macos" | "linux")[];
  match: AppMatch;
  defaults: Record<string, Binding>;
  actions: AppAction[];
  source?: string;
}

export interface Config {
  schema_version: number;
  /** `check_for_updates` is absent until the user answers the one-time question. */
  engine: { start_at_login: boolean; log_level: string; check_for_updates?: boolean };
  transport: Record<string, TransportCode>;
  default_profile: Profile;
  /** Overrides every other profile, whatever is in the foreground. */
  god_mode: Profile;
  profiles: Profile[];
  /** How many enabled app profiles the System row sits below in the Active list. */
  system_position?: number;
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  windows?: Action;
  mac?: Action;
  linux?: Action;
}

export type Os = "windows" | "macos" | "linux";
export const OS_NAME: Record<Os, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };
export type ActionColumn = "windows" | "mac" | "linux";
export const COLUMN_OS: Record<ActionColumn, Os> = { windows: "windows", mac: "macos", linux: "linux" };

/** Which action column applies on this OS. */
export function osColumn(os: Os): ActionColumn {
  return os === "macos" ? "mac" : os === "linux" ? "linux" : "windows";
}

/**
 * The chord to show for an action on `os`. Linux falls back to the Windows
 * column. With `allPlatforms`, an action documented only for another OS is
 * returned too, tagged with that OS so the row can say so.
 */
export function actionFor(a: { windows?: Action; mac?: Action; linux?: Action }, os: Os, allPlatforms: boolean): { action: Action; os?: Os } | undefined {
  const col = osColumn(os);
  const own = col === "linux" ? a.linux ?? a.windows : a[col];
  if (own) return { action: own };
  if (!allPlatforms) return undefined;
  for (const c of ["windows", "mac", "linux"] as ActionColumn[]) {
    if (c !== col && a[c]) return { action: a[c]!, os: COLUMN_OS[c] };
  }
  return undefined;
}

const ALL_PLATFORMS_KEY = "cc.allPlatforms";
export function loadAllPlatforms(): boolean {
  try {
    return localStorage.getItem(ALL_PLATFORMS_KEY) === "1";
  } catch {
    return false;
  }
}
export function storeAllPlatforms(v: boolean) {
  try {
    localStorage.setItem(ALL_PLATFORMS_KEY, v ? "1" : "0");
  } catch {
    /* per-viewer convenience only */
  }
}

export interface EngineMsg {
  type:
    | "hello"
    | "status"
    | "event"
    | "config_applied"
    | "config_rejected"
    | "learned"
    | "unassigned"
    | "unbound"
    | "connected"
    | "disconnected";
  version?: string;
  config?: string;
  profile?: string;
  paused?: boolean;
  event?: string;
  action?: string;
  repeat?: number;
  error?: string;
  /** `learned` / `unassigned`: the key and modifier namespace the module sent. */
  key?: string;
  mods?: Mods;
}

export const FUNCTION_KEYS = ["F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24"] as const;
/** Modifiers a module can carry alongside its F-key. Fn works only on macOS and only if the firmware can send it. */
export const TRANSPORT_MODS = ["ctrl", "shift", "alt", "cmd", "fn"] as const;
const MOD_TOKEN_LABEL: Record<string, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: "Cmd", win: "Cmd", meta: "Cmd", fn: "Fn" };
const MOD_ORDER = ["ctrl", "shift", "alt", "cmd", "fn"];
export function parseMods(m: Mods | undefined): Set<string> {
  if (!m || m === "none") return new Set();
  return new Set(m.toLowerCase().split(/[+_ ]/).filter(Boolean).map((t) => (t === "win" || t === "meta" ? "cmd" : t)));
}
export function buildMods(set: Set<string>): Mods {
  const toks = MOD_ORDER.filter((t) => set.has(t));
  return toks.length ? toks.join("+") : "none";
}
export function modsLabel(m: Mods | undefined): string {
  return MOD_ORDER.filter((t) => parseMods(m).has(t)).map((t) => MOD_TOKEN_LABEL[t]).join("+");
}
export { MODULES, GESTURES, PAIRS, moduleLabel, gestureLabel, gesturesFor, choicesFor, choiceLabel, halvesOf, isPair, pairOf, eventLabel, eventSortKey, parseEvent, makeEvent, fingerOptions, takesFingers, fingersLabel, moduleBehavior } from "./events";
export type { GestureChoice, PairId, SortMode } from "./events";
export { SORT_LABEL, nextSortMode, loadSortMode, storeSortMode, sortEvents, streams } from "./events";

export interface WindowInfo {
  exe: string;
  title: string;
}

const MEDIA_LABEL: Record<MediaKey, string> = {
  volume_up: "Volume up",
  volume_down: "Volume down",
  mute: "Mute",
  play_pause: "Play / pause",
  next_track: "Next track",
  previous_track: "Previous track",
  brightness_up: "Brightness up",
  brightness_down: "Brightness down",
};

export function describeAction(a: Action | undefined): string {
  if (!a) return "";
  switch (a.type) {
    case "noop":
      return "Do nothing";
    case "keys":
      return a.hold_ms ? `${a.chord} (hold ${(a.hold_ms / 1000).toFixed(1)} s)` : a.chord;
    case "release":
      return "Release held keys";
    case "sequence":
      return a.chords.join(", ");
    case "media":
      return MEDIA_LABEL[a.key] ?? a.key;
    case "scroll":
      return `Scroll ${a.direction}${(a.lines ?? 1) > 1 ? ` ×${a.lines}` : ""}`;
    case "launch":
      return `Launch ${a.program}${a.args?.length ? " " + a.args.join(" ") : ""}`;
    case "command":
      return `Run: ${a.command}`;
  }
}

export function transportLabel(t: TransportCode): string {
  const m = modsLabel(t.mods);
  return m ? `${m}+${t.key}` : t.key;
}
