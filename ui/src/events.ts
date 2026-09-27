// Semantic event names, mirroring companion-core/src/event.rs:
//   <MODULE>_<GESTURE>[_<n>F]   e.g. TUNE_CW, TUNE_TAP_1F, LEFT_TOUCH_SWIPE_UP_3F
// Legacy TUNE_PRESS is the one-finger tap; a name without a count is "any count".

export const MODULES = ["TUNE", "LEFT_TOUCH", "RIGHT_TOUCH"] as const;
export type ModuleId = (typeof MODULES)[number];

export const GESTURES = [
  "CW",
  "CCW",
  "TAP",
  "DOUBLE_TAP",
  "SWIPE_LEFT",
  "SWIPE_RIGHT",
  "SWIPE_UP",
  "SWIPE_DOWN",
  "PINCH",
  "SPREAD",
  "SCROLL_LEFT",
  "SCROLL_RIGHT",
  "SCROLL_UP",
  "SCROLL_DOWN",
] as const;
export type GestureId = (typeof GESTURES)[number];

const MODULE_LABEL: Record<ModuleId, string> = { TUNE: "Tune", LEFT_TOUCH: "Left Touch", RIGHT_TOUCH: "Right Touch" };
const GESTURE_LABEL: Record<GestureId, string> = {
  CW: "Clockwise",
  CCW: "Counterclockwise",
  TAP: "Tap",
  DOUBLE_TAP: "Double tap",
  SWIPE_LEFT: "Swipe left",
  SWIPE_RIGHT: "Swipe right",
  SWIPE_UP: "Swipe up",
  SWIPE_DOWN: "Swipe down",
  PINCH: "Pinch",
  SPREAD: "Spread",
  SCROLL_LEFT: "Scroll left",
  SCROLL_RIGHT: "Scroll right",
  SCROLL_UP: "Scroll up",
  SCROLL_DOWN: "Scroll down",
};

export interface ParsedEvent {
  module: ModuleId;
  gesture: GestureId;
  fingers: number | null;
}

export function parseEvent(id: string): ParsedEvent | null {
  const module = MODULES.find((m) => id.startsWith(m + "_"));
  if (!module) return null;
  let rest = id.slice(module.length + 1);
  let fingers: number | null = null;
  const m = /^(.*)_([1-4])F$/.exec(rest);
  if (m) {
    rest = m[1];
    fingers = Number(m[2]);
  }
  if (rest === "PRESS") return { module, gesture: "TAP", fingers: 1 };
  if (!(GESTURES as readonly string[]).includes(rest)) return null;
  const gesture = rest as GestureId;
  if (!takesFingers(gesture) && fingers !== null) return null;
  if (!gestureAvailable(module, gesture)) return null;
  return { module, gesture, fingers };
}

export function makeEvent(module: ModuleId, gesture: GestureId, fingers: number | null): string {
  return `${module}_${gesture}${takesFingers(gesture) && fingers ? `_${fingers}F` : ""}`;
}

export function takesFingers(g: GestureId): boolean {
  return g !== "CW" && g !== "CCW";
}

export function gestureAvailable(module: ModuleId, g: GestureId): boolean {
  return module === "TUNE" || (g !== "CW" && g !== "CCW");
}

export function gesturesFor(module: ModuleId): GestureId[] {
  return GESTURES.filter((g) => gestureAvailable(module, g));
}

/**
 * Gestures the firmware treats as one axis with two directions. Each half is
 * its own transport key, but the user thinks of (and the module profile names) the pair:
 * `rotate:tune:dial`, `pinch&spread:...`, `vertical:...`, `horizontal:...`.
 * `halves` is [minus, plus].
 */
export const PAIRS = {
  ROTATE: { label: "Dial (rotate)", halves: ["CCW", "CW"] as [GestureId, GestureId] },
  // Not offered as a choice (see WITHHELD); kept so a pinch or spread row can name the
  // device field it comes from, and so an older configuration still reads correctly.
  PINCH_SPREAD: { label: "Pinch & spread", halves: ["PINCH", "SPREAD"] as [GestureId, GestureId] },
  SCROLL_V: { label: "Scroll up & down", halves: ["SCROLL_UP", "SCROLL_DOWN"] as [GestureId, GestureId] },
  SCROLL_H: { label: "Scroll left & right", halves: ["SCROLL_LEFT", "SCROLL_RIGHT"] as [GestureId, GestureId] },
} as const;
export type PairId = keyof typeof PAIRS;
/** What the add row offers: a discrete gesture or a pair. */
export type GestureChoice = GestureId | PairId;

/**
 * Gestures the add row offers on their own. Pinch and spread are the two halves of one
 * `pinch&spread` field; each is bound to its own key, so each is offered here and the
 * combined choice is withheld (see `WITHHELD`).
 */
const DISCRETE: GestureId[] = ["TAP", "DOUBLE_TAP", "SWIPE_LEFT", "SWIPE_RIGHT", "SWIPE_UP", "SWIPE_DOWN", "PINCH", "SPREAD"];

export function isPair(c: GestureChoice): c is PairId {
  return c in PAIRS;
}
/** The gestures a choice stands for: a pair's two halves, or the gesture itself. */
export function halvesOf(c: GestureChoice): GestureId[] {
  return isPair(c) ? [...PAIRS[c].halves] : [c];
}
/**
 * Not offered in the add row, on either module. Double tap: the engine only ever relays a key
 * the firmware sends for it, and no module has a double-tap field. Split scroll axes: a
 * two-finger motion is added as a swipe instead. Pinch & spread (2026-09-18): a combined
 * choice is meaningless, because one key for both halves would make a pinch and a spread
 * indistinguishable; each half needs its own key, which is what adding **Pinch** and
 * **Spread** separately does. The events still parse, and an existing row keeps working.
 */
const WITHHELD: ReadonlySet<GestureChoice> = new Set<GestureChoice>(["DOUBLE_TAP", "SCROLL_V", "SCROLL_H", "PINCH_SPREAD"]);

export function choicesFor(module: ModuleId): GestureChoice[] {
  const discrete = DISCRETE.filter((g) => gestureAvailable(module, g));
  const pairs = (Object.keys(PAIRS) as PairId[]).filter((p) => PAIRS[p].halves.every((g) => gestureAvailable(module, g)));
  return [...discrete, ...pairs].filter((c) => !WITHHELD.has(c));
}
export function choiceLabel(c: GestureChoice): string {
  return isPair(c) ? PAIRS[c].label : gestureLabel(c);
}
/** The pair a gesture belongs to, if any (for labelling rows). */
export function pairOf(g: GestureId): PairId | null {
  for (const p of Object.keys(PAIRS) as PairId[]) if ((PAIRS[p].halves as readonly string[]).includes(g)) return p;
  return null;
}

/**
 * Whether the module emits this gesture as a run of keys scaled to finger travel.
 * Tune (measured 2026-09-05): 2-finger swipes. Touch (measured 2026-09-10): 2-finger motion in
 * any direction (the scroll axes, and the swipe fields when they exist) and the 4-finger swipes
 * up and down. Pinch and spread stream on both modules (2026-09-18): each is one half of the
 * `pinch&spread` axis and runs a burst scaled to the fingers' travel. Everything else sends one
 * key. Mirrors SemanticEvent::streams in companion-core.
 */
export function streams(id: string): boolean {
  const p = parseEvent(id);
  if (!p) return false;
  const swipe = p.gesture.startsWith("SWIPE_");
  const pinch = p.gesture === "PINCH" || p.gesture === "SPREAD";
  if (p.module === "TUNE") return (swipe || pinch) && p.fingers === 2;
  return ((swipe || pinch || p.gesture.startsWith("SCROLL_")) && p.fingers === 2) || ((p.gesture === "SWIPE_UP" || p.gesture === "SWIPE_DOWN") && p.fingers === 4);
}

/**
 * Finger counts a gesture can be flashed for on this module. Pinch & spread is a two-finger
 * gesture on every module (the only `pinch&spread` field either device carries is the 2-finger
 * one). On a Touch, nothing at 1 finger and no 2-finger tap: the module firmware owns those
 * fields (cursor, left click, right click) and ignores a key written to them (probe
 * 2026-09-10: a key in the 2-finger tap field read back fine, the tap still right-clicked).
 * NayaFlow refuses to map them and OpenFlow mirrors that, so the Inputs page does not offer
 * them either. A Tune stops at 3 fingers (no 4-finger field on the dial). The events themselves
 * still parse, so an existing row keeps its value.
 */
export function fingerOptions(module: ModuleId, g: GestureId): number[] {
  if (!takesFingers(g)) return [];
  if (g === "PINCH" || g === "SPREAD") return [2];
  // The Tune has no 4-finger fields at all: its taps and swipes stop at 3 fingers.
  if (module === "TUNE") return [1, 2, 3];
  return [2, 3, 4].filter((n) => !(g === "TAP" && n === 2));
}

export function moduleLabel(m: string): string {
  return (MODULE_LABEL as Record<string, string>)[m] ?? m;
}
export function gestureLabel(g: string): string {
  return (GESTURE_LABEL as Record<string, string>)[g] ?? g;
}
export function fingersLabel(n: number | null): string {
  return n === null ? "" : n === 1 ? "1 finger" : `${n} fingers`;
}

/** `TUNE_SWIPE_LEFT_3F` -> ["Tune", "Swipe left", "3 fingers"] */
export function eventParts(id: string): [string, string, string] {
  const p = parseEvent(id);
  if (!p) return [id, "", ""];
  return [moduleLabel(p.module), gestureLabel(p.gesture), fingersLabel(p.fingers)];
}

/** `TUNE_SWIPE_LEFT_3F` -> ["Tune", "Swipe left · 3 fingers"] */
export function eventLabel(id: string): [string, string] {
  const [m, g, f] = eventParts(id);
  return [m, f ? `${g} · ${f}` : g];
}

/** Stable display order: module, then gesture, then finger count. */
export function eventSortKey(id: string): number {
  const p = parseEvent(id);
  if (!p) return 99999;
  return MODULES.indexOf(p.module) * 1000 + GESTURES.indexOf(p.gesture) * 10 + (p.fingers ?? 0);
}

/**
 * How the Input column is ordered. Clicking the header cycles through these.
 * Each mode has its own tie-breakers:
 *   fingers -> module -> gesture      (default: "all my 1-finger moves, then 2-finger…")
 *   module  -> gesture -> fingers
 *   gesture -> module  -> fingers
 *   alpha   -> gesture label A–Z, then module, then fingers
 */
export type SortMode = "fingers" | "module" | "gesture" | "alpha";
export const SORT_MODES: SortMode[] = ["fingers", "module", "gesture", "alpha"];
export const SORT_LABEL: Record<SortMode, string> = { fingers: "fingers", module: "module", gesture: "gesture", alpha: "A–Z" };

export function nextSortMode(m: SortMode): SortMode {
  return SORT_MODES[(SORT_MODES.indexOf(m) + 1) % SORT_MODES.length];
}

const SORT_KEY = "cc.inputSort";
export function loadSortMode(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return (SORT_MODES as string[]).includes(v ?? "") ? (v as SortMode) : "fingers";
  } catch {
    return "fingers";
  }
}
export function storeSortMode(m: SortMode) {
  try {
    localStorage.setItem(SORT_KEY, m);
  } catch {
    /* per-viewer convenience only */
  }
}

export function sortEvents(ids: string[], mode: SortMode): string[] {
  const parsed = new Map(ids.map((id) => [id, parseEvent(id)] as const));
  const fingers = (p: ParsedEvent) => p.fingers ?? 0; // dial (no count) sorts first
  const module = (p: ParsedEvent) => MODULES.indexOf(p.module);
  const gesture = (p: ParsedEvent) => GESTURES.indexOf(p.gesture);
  const alpha = (p: ParsedEvent) => gestureLabel(p.gesture).toLowerCase();
  const keys: Record<SortMode, (p: ParsedEvent) => (number | string)[]> = {
    fingers: (p) => [fingers(p), module(p), gesture(p)],
    module: (p) => [module(p), gesture(p), fingers(p)],
    gesture: (p) => [gesture(p), module(p), fingers(p)],
    alpha: (p) => [alpha(p), module(p), fingers(p)],
  };
  return [...ids].sort((a, b) => {
    const pa = parsed.get(a);
    const pb = parsed.get(b);
    if (!pa || !pb) return pa ? -1 : pb ? 1 : a.localeCompare(b);
    const ka = keys[mode](pa);
    const kb = keys[mode](pb);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

/**
 * Module-profile behavior string for an event, plus the half of a direction pair it is
 * (`"-"` or `"+"`), or null when a finger count is needed but missing.
 * Mirrors SemanticEvent::module_behavior in companion-core.
 */
export function moduleBehavior(id: string): { behavior: string; half: "-" | "+" | null } | null {
  const p = parseEvent(id);
  if (!p) return null;
  const mod = p.module === "TUNE" ? "tune" : "touch";
  if (p.gesture === "CW" || p.gesture === "CCW") return { behavior: `rotate:${mod}:dial`, half: p.gesture === "CW" ? "+" : "-" };
  if (p.fingers === null) return null;
  const q = p.fingers === 1 ? "1_finger" : `${p.fingers}_fingers`;
  const table: Record<string, [string, "-" | "+" | null]> = {
    TAP: ["tap", null],
    DOUBLE_TAP: ["double_tap", null],
    SWIPE_LEFT: ["swipe_left", null],
    SWIPE_RIGHT: ["swipe_right", null],
    SWIPE_UP: ["swipe_up", null],
    SWIPE_DOWN: ["swipe_down", null],
    PINCH: ["pinch&spread", "-"],
    SPREAD: ["pinch&spread", "+"],
    SCROLL_LEFT: ["horizontal", "-"],
    SCROLL_RIGHT: ["horizontal", "+"],
    SCROLL_UP: ["vertical", "-"],
    SCROLL_DOWN: ["vertical", "+"],
  };
  const [g, half] = table[p.gesture];
  return { behavior: `${g}:${mod}:${q}`, half };
}
