import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActionPicker } from "./ActionPicker";
import { AddApp } from "./AddApp";
import { Updates } from "./Updates";
import { Inputs, type Learned } from "./Inputs";
import { api } from "./api";
import {
  OS_NAME,
  actionFor,
  loadAllPlatforms,
  storeAllPlatforms,
  type Os,
  describeAction,
  eventLabel,
  type SortMode,
  SORT_LABEL,
  nextSortMode,
  loadSortMode,
  storeSortMode,
  sortEvents,
  streams,
  transportLabel,
  type Accel,
  type Action,
  type AppEntry,
  type Binding,
  type CatalogEntry,
  type Config,
  type EngineMsg,
  type Profile,
} from "./types";

type SaveState = { kind: "idle" } | { kind: "dirty" } | { kind: "saving" } | { kind: "saved" } | { kind: "applied" } | { kind: "error"; msg: string };
type NavTab = "active" | "available";

const ACCELS: Accel[] = ["none", "light", "medium", "aggressive"];
const DEFAULT = -1; // selected index for the default profile
const INPUTS = -2; // the Inputs (transport) editor
const GOD = -3; // the God Mode override profile

/** A row of the Active list: a profile's config index, or the System row. */
type NavRow = number | "system";

function isEnabled(p: Profile) {
  return p.enabled !== false;
}

/** Can this catalog entry run on the given OS? */
function entryOnOs(a: AppEntry, os: Os): boolean {
  if (a.kind === "system") return a.os?.includes(os) ?? false;
  if (a.kind === "site") return true;
  if (os === "macos") return a.match.macos_bundle.length > 0;
  return a.match.windows_exe.length > 0;
}

/**
 * The one figure every sidebar row shows: how many documented shortcuts the
 * catalog has for it. A profile without a catalog entry (added by hand) shows
 * how many of its inputs are mapped instead.
 */
function countLabel(entry: AppEntry | undefined, p?: Profile): string {
  if (entry) return `${entry.actions.length.toLocaleString()} shortcuts`;
  const n = p ? Object.keys(p.bindings).length : 0;
  return n === 1 ? "1 mapping" : `${n} mappings`;
}

/** The platforms an entry runs on, for the tag shown when browsing all platforms. */
function entryPlatforms(a: AppEntry): string {
  if (a.kind === "system") return (a.os ?? []).map((o) => OS_NAME[o]).join(" · ");
  const out: string[] = [];
  if (a.match.windows_exe.length) out.push("Windows");
  if (a.match.macos_bundle.length) out.push("macOS");
  return out.join(" · ");
}

/** "This computer / All platforms" switch; remembered between launches. */
function PlatformToggle(props: { value: boolean; onChange: (v: boolean) => void; compact?: boolean }) {
  return (
    <div className={"seg " + (props.compact ? "compact" : "")} title="Show only what runs on this computer, or every platform (to build a config you will move to another machine)">
      <button className={props.value ? "" : "on"} onClick={() => props.onChange(false)}>
        This computer
      </button>
      <button className={props.value ? "on" : ""} onClick={() => props.onChange(true)}>
        All platforms
      </button>
    </div>
  );
}

function currentOs(): Os {
  const p = navigator.platform.toLowerCase();
  if (p.startsWith("win")) return "windows";
  if (p.startsWith("mac")) return "macos";
  return "linux";
}

function matchText(p: { name: string; match: Profile["match"] }) {
  return [p.name, ...p.match.windows_exe, ...p.match.window_title, ...p.match.macos_bundle].join(" ").toLowerCase();
}

/**
 * Link a profile to its catalog entry: by name first, then by a shared
 * executable or bundle id with the same kind of title rule (so "Photoshop"
 * still finds "Adobe Photoshop", and Browser does not swallow YouTube).
 */
function catalogFor(apps: AppEntry[], p: Profile): AppEntry | undefined {
  const byName = apps.find((a) => a.name.toLowerCase() === p.name.toLowerCase());
  if (byName) return byName;
  const exes = new Set(p.match.windows_exe.map((e) => e.toLowerCase()));
  const bundles = new Set(p.match.macos_bundle);
  const hasTitle = p.match.window_title.length > 0;
  return apps.find(
    (a) =>
      a.match.window_title.length > 0 === hasTitle &&
      (a.match.windows_exe.some((e) => exes.has(e.toLowerCase())) || a.match.macos_bundle.some((b) => bundles.has(b))),
  );
}

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [path, setPath] = useState("");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [sel, setSelRaw] = useState<number>(DEFAULT);
  /** A catalog entry being looked at from the Available list (not yet a profile). */
  const [preview, setPreview] = useState<AppEntry | null>(null);
  const setSel = (i: number) => {
    setSelRaw(i);
    setPreview(null);
  };
  const [navTab, setNavTab] = useState<NavTab>("active");
  const [navQ, setNavQ] = useState("");
  const [dragging, setDragging] = useState<NavRow | null>(null);
  const [dragOver, setDragOver] = useState<NavRow | null>(null);
  const [allPlatforms, setAllPlatformsState] = useState<boolean>(loadAllPlatforms);
  const setAllPlatforms = (v: boolean) => {
    setAllPlatformsState(v);
    storeAllPlatforms(v);
  };
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [engine, setEngine] = useState<{ connected: boolean; profile?: string; paused?: boolean; version?: string }>({ connected: false });
  const [last, setLast] = useState<{ event: string; profile: string; action: string; at: number; unbound?: boolean } | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [learned, setLearned] = useState<Learned | null>(null);
  /** Last F-key the keyboard sent that no input uses. */
  const [unassigned, setUnassigned] = useState<(Learned & { at: number }) | null>(null);
  /** Hand an unassigned key to the Inputs add row. */
  const [suggest, setSuggest] = useState<Learned | null>(null);
  const saveTimer = useRef<number | null>(null);
  const [appVersion, setAppVersion] = useState("");
  /** The Updates panel; `check` runs a check as it opens (the tray's "Check for updates..."). */
  const [updates, setUpdates] = useState<{ check: boolean } | null>(null);
  /** A newer version the engine's weekly check found. */
  const [knownUpdate, setKnownUpdate] = useState<string | null>(null);

  useEffect(() => {
    api.appVersion().then(setAppVersion).catch(() => {});
    api.updateKnown().then(setKnownUpdate).catch(() => {});
    api
      .launchFlags()
      .then((f) => f.updates && setUpdates({ check: true }))
      .catch(() => {});
  }, []);

  /** The answer to "check automatically?", kept with the engine's settings. */
  function setAutoUpdates(on: boolean) {
    setCfg((c) => (c ? { ...c, engine: { ...c.engine, check_for_updates: on } } : c));
    setSave({ kind: "dirty" });
  }

  useEffect(() => {
    api
      .loadConfig()
      .then((l) => {
        setCfg(l.config);
        setPath(l.path);
      })
      .catch((e) => setLoadErr(String(e)));
    api.actionCatalog().then(setCatalog).catch(() => setCatalog([]));
    api.appCatalog().then(setApps).catch(() => setApps([]));
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    api
      .onEngine((m: EngineMsg) => {
        switch (m.type) {
          case "connected":
            setEngine((e) => ({ ...e, connected: true }));
            break;
          case "disconnected":
            setEngine((e) => ({ ...e, connected: false }));
            break;
          case "hello":
            setEngine((e) => ({ ...e, connected: true, version: m.version }));
            break;
          case "status":
            setEngine((e) => ({ ...e, connected: true, profile: m.profile, paused: m.paused }));
            break;
          case "event":
            setLast({ event: m.event!, profile: m.profile!, action: m.action!, at: Date.now() });
            setUnassigned(null);
            setFlash(m.event!);
            window.setTimeout(() => setFlash(null), 900);
            break;
          case "config_applied":
            setSave((s) => (s.kind === "saved" || s.kind === "saving" ? { kind: "applied" } : s));
            break;
          case "config_rejected":
            setSave({ kind: "error", msg: m.error ?? "engine rejected the configuration" });
            break;
          case "learned":
            setLearned((l) => ({ key: m.key!, mods: m.mods ?? "none", seq: (l?.seq ?? 0) + 1 }));
            break;
          case "unbound":
            setLast({ event: m.event!, profile: m.profile!, action: "", at: Date.now(), unbound: true });
            setUnassigned(null);
            setFlash(m.event!);
            window.setTimeout(() => setFlash(null), 900);
            break;
          case "unassigned":
            setUnassigned((u) => ({ key: m.key!, mods: m.mods ?? "none", seq: (u?.seq ?? 0) + 1, at: Date.now() }));
            break;
        }
      })
      .then(async (u) => {
        un = u;
        // Catch up on anything emitted before this listener existed.
        try {
          const st = await api.engineState();
          setEngine((e) => ({
            ...e,
            connected: st.connected,
            version: st.hello?.version ?? e.version,
            profile: st.status?.profile ?? e.profile,
            paused: st.status?.paused ?? e.paused,
          }));
        } catch {
          /* engine_state unavailable: stay as-is */
        }
      });
    return () => un?.();
  }, []);

  const profile: Profile | null = useMemo(() => {
    if (!cfg || sel === INPUTS) return null;
    return sel === DEFAULT ? cfg.default_profile : sel === GOD ? cfg.god_mode : cfg.profiles[sel] ?? null;
  }, [cfg, sel]);

  function setTransport(transport: Config["transport"]) {
    setCfg((c) => (c ? { ...c, transport } : c));
    setSave({ kind: "dirty" });
  }

  /** Rename an event everywhere: transport row and every profile's binding. */
  function renameEvent(from: string, to: string) {
    if (from === to) return;
    setCfg((c) => {
      if (!c) return c;
      const ren = (b: Record<string, Binding>) => {
        if (!(from in b)) return b;
        const { [from]: moved, ...rest } = b;
        return { ...rest, [to]: moved };
      };
      const transport = { ...c.transport };
      if (from in transport) {
        transport[to] = transport[from];
        delete transport[from];
      }
      return {
        ...c,
        transport,
        default_profile: { ...c.default_profile, bindings: ren(c.default_profile.bindings) },
        god_mode: { ...c.god_mode, bindings: ren(c.god_mode.bindings) },
        profiles: c.profiles.map((p) => ({ ...p, bindings: ren(p.bindings) })),
      };
    });
    setSave({ kind: "dirty" });
  }

  /** Order of the Input column on every mapping table; shared with the Inputs page. */
  const [sortMode, setSortModeState] = useState<SortMode>(loadSortMode);
  const setSortMode = (m: SortMode) => {
    setSortModeState(m);
    storeSortMode(m);
  };
  const events = useMemo(() => (cfg ? sortEvents(Object.keys(cfg.transport), sortMode) : []), [cfg, sortMode]);

  /**
   * The catalog entry that corresponds to the selected profile: the app's own
   * entry, or for the Default profile the running OS's system shortcuts.
   */
  const appEntry = useMemo(() => {
    if (!profile) return undefined;
    if (sel === DEFAULT || sel === GOD) {
      const own = apps.find((a) => a.kind === "system" && a.os?.includes(currentOs()));
      if (!allPlatforms || !own) return own;
      // Browsing all platforms: the other systems' shortcuts join the list.
      const others = apps.filter((a) => a.kind === "system" && a !== own);
      return { ...own, name: "System", actions: [...own.actions, ...others.flatMap((a) => a.actions)] };
    }
    return catalogFor(apps, profile);
  }, [apps, profile, sel, allPlatforms]);

  // ---- nav lists ---------------------------------------------------------
  const nav = useMemo(() => {
    if (!cfg) return { active: [] as number[], disabled: [] as number[], available: [] as AppEntry[], os: currentOs() };
    const q = navQ.trim().toLowerCase();
    const hit = (t: string) => !q || t.includes(q);
    const active: number[] = [];
    const disabled: number[] = [];
    cfg.profiles.forEach((p, i) => {
      if (!hit(matchText(p))) return;
      (isEnabled(p) ? active : disabled).push(i);
    });
    const known = new Set(cfg.profiles.map((p) => catalogFor(apps, p)?.id).filter(Boolean));
    // System entries are not profiles; they feed the Default profile's picker.
    const os = currentOs();
    const available = apps.filter((a) => a.kind !== "system" && (allPlatforms || entryOnOs(a, os)) && !known.has(a.id)).filter((a) => hit(matchText(a)));
    return { active, disabled, available, os };
  }, [cfg, apps, navQ, allPlatforms]);

  /** Apply an edit to the selected profile and schedule a save. */
  const update = useCallback(
    (fn: (p: Profile) => Profile, target: number = sel) => {
      setCfg((c) => {
        if (!c) return c;
        if (target === DEFAULT) return { ...c, default_profile: fn(c.default_profile) };
        if (target === GOD) return { ...c, god_mode: fn(c.god_mode) };
        const profiles = c.profiles.slice();
        profiles[target] = fn(profiles[target]);
        return { ...c, profiles };
      });
      setSave({ kind: "dirty" });
    },
    [sel],
  );

  // Autosave 600 ms after the last edit; the engine picks the file up.
  useEffect(() => {
    if (save.kind !== "dirty" || !cfg) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      setSave({ kind: "saving" });
      try {
        await api.saveConfig(cfg);
        // An edit made while this save was in flight has already set "dirty"
        // again; leave that alone so it gets its own save.
        setSave((s) => (s.kind === "saving" ? { kind: "saved" } : s));
      } catch (e) {
        setSave({ kind: "error", msg: String(e) });
      }
    }, 600);
  }, [cfg, save.kind]);

  function setBinding(ev: string, action: Action | null, name?: string) {
    update((p) => {
      const bindings = { ...p.bindings };
      if (action === null) delete bindings[ev];
      else {
        const b: Binding = { action, accel: bindings[ev]?.accel ?? "none" };
        if (name) b.name = name;
        bindings[ev] = b;
      }
      return { ...p, bindings };
    });
    setPicker(null);
  }

  /** Per-binding "follow the swipe" (null = use the input's default). */
  function setFollow(ev: string, follow: boolean | null) {
    update((p) => {
      if (!p.bindings[ev]) return p;
      const b = { ...p.bindings[ev] };
      if (follow === null) delete b.follow;
      else b.follow = follow;
      return { ...p, bindings: { ...p.bindings, [ev]: b } };
    });
  }

  /** Actions per detent before acceleration; 1 clears the field. */
  function setMultiplier(ev: string, n: number) {
    const m = Math.max(1, Math.min(32, Math.round(n) || 1));
    update((p) => {
      if (!p.bindings[ev]) return p;
      const b = { ...p.bindings[ev] };
      if (m === 1) delete b.multiplier;
      else b.multiplier = m;
      return { ...p, bindings: { ...p.bindings, [ev]: b } };
    });
  }

  function setAccel(ev: string, accel: Accel) {
    update((p) => (p.bindings[ev] ? { ...p, bindings: { ...p.bindings, [ev]: { ...p.bindings[ev], accel } } } : p));
  }

  function addProfile(p: Profile) {
    setCfg((c) => (c ? { ...c, profiles: [...c.profiles, p] } : c));
    setSel(cfg ? cfg.profiles.length : 0);
    setNavTab("active");
    setSave({ kind: "dirty" });
    setAdding(false);
  }

  /** Star an app from the catalog: create its profile with the bundled defaults. */
  /** A catalog default as a binding for this OS: the Mac action on macOS. */
  function defaultForOs(b: Binding): Binding {
    const { mac, ...rest } = b;
    return currentOs() === "macos" && mac ? { ...rest, action: mac } : rest;
  }

  function activateApp(a: AppEntry) {
    const bindings = Object.fromEntries(Object.entries(a.defaults).map(([ev, b]) => [ev, defaultForOs(b)]));
    addProfile({ name: a.name, enabled: true, match: { ...a.match }, bindings });
  }

  function setEnabled(i: number, enabled: boolean) {
    update((p) => ({ ...p, enabled }), i);
    if (enabled) setSel(i);
  }

  /** The Active list in display order: enabled profiles with the System row among them. */
  const activeRows = useMemo<NavRow[]>(() => {
    if (!cfg) return [];
    const at = Math.min(cfg.system_position ?? 0, nav.active.length);
    return [...nav.active.slice(0, at), "system", ...nav.active.slice(at)];
  }, [cfg, nav.active]);

  /**
   * Drop `from` where `to` is. Every row except God Mode moves. App profile
   * order is the tie-break priority; the System row's slot is remembered as
   * display order only.
   */
  function moveRow(from: NavRow, to: NavRow) {
    if (!cfg) return;
    const fi = activeRows.indexOf(from);
    const ti = activeRows.indexOf(to);
    if (fi < 0 || ti < 0 || fi === ti) return;
    const next = [...activeRows];
    next.splice(fi, 1);
    next.splice(ti, 0, from);
    const shown = new Set(next.filter((r): r is number => r !== "system"));
    const profiles = [...next.filter((r): r is number => r !== "system").map((i) => cfg.profiles[i]), ...cfg.profiles.filter((_, i) => !shown.has(i))];
    const system_position = next.indexOf("system");
    setCfg((c) => (c ? { ...c, profiles, system_position } : c));
    // Keep the selection on the same profile.
    if (sel >= 0) setSelRaw(profiles.indexOf(cfg.profiles[sel]));
    setSave({ kind: "dirty" });
  }

  /** Drag-and-drop handlers shared by every movable row. */
  function dragProps(row: NavRow, enabled: boolean) {
    return {
      draggable: enabled,
      onDragStart: (e: React.DragEvent) => {
        if (!enabled) return;
        setDragging(row);
        e.dataTransfer.effectAllowed = "move";
      },
      onDragOver: (e: React.DragEvent) => {
        if (dragging === null || !enabled) return;
        e.preventDefault();
        if (dragOver !== row) setDragOver(row);
      },
      onDragLeave: () => dragOver === row && setDragOver(null),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (dragging !== null && dragging !== row) moveRow(dragging, row);
        setDragging(null);
        setDragOver(null);
      },
      onDragEnd: () => {
        setDragging(null);
        setDragOver(null);
      },
    };
  }

  function removeProfile(i: number) {
    setCfg((c) => (c ? { ...c, profiles: c.profiles.filter((_, k) => k !== i) } : c));
    setSel(DEFAULT);
    setSave({ kind: "dirty" });
  }

  function editMatch(field: "windows_exe" | "macos_bundle" | "window_title", values: string[]) {
    update((p) => ({ ...p, match: { ...p.match, [field]: values } }));
  }

  if (loadErr) {
    return (
      <div style={{ padding: 30 }}>
        <h2>Could not load the configuration</h2>
        <pre className="error">{loadErr}</pre>
        <p className="muted">Fix the file and reopen this window.</p>
        <button onClick={() => api.openConfigFolder()}>Open configuration folder</button>
      </div>
    );
  }
  if (!cfg || (sel !== INPUTS && !profile)) return <div style={{ padding: 30 }} className="muted">Loading…</div>;

  const showInputs = sel === INPUTS;
  const prof = (profile ?? cfg.default_profile) as Profile;
  const isDefault = sel === DEFAULT;
  const isGod = sel === GOD;
  /** System and God Mode: always on, no match rules, cannot be removed. */
  const fixed = isDefault || isGod;
  const liveName = engine.profile;
  const selectedDisabled = !fixed && !showInputs && !isEnabled(prof);

  const ProfileRow = ({ i, draggable }: { i: number; draggable?: boolean }) => {
    const p = cfg.profiles[i];
    const on = isEnabled(p);
    return (
      <div
        className={"profile-item " + (sel === i ? "active " : "") + (liveName === p.name ? "live " : "") + (on ? "" : "dim ") + (dragOver === i ? "dragover" : "")}
        onClick={() => setSel(i)}
        title={draggable ? "Drag to change priority: when two profiles match the same window and are equally specific, the higher one wins" : undefined}
        {...dragProps(i, !!draggable)}
      >
        <button
          className={"star " + (on ? "on" : "")}
          title={on ? "Disable this profile (keeps its mappings)" : "Enable this profile"}
          onClick={(e) => {
            e.stopPropagation();
            setEnabled(i, !on);
          }}
        >
          {on ? "★" : "☆"}
        </button>
        <span className="name">{p.name}</span>
        <span className="badge">{countLabel(catalogFor(apps, p), p)}</span>
      </div>
    );
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img className="logo" src="/icon.png" alt="" />
          Create Companion
          <span
            className={"dot " + (engine.connected ? "on" : "")}
            title={engine.connected ? "Engine connected" : "Engine not running: click to start it"}
            style={engine.connected ? undefined : { cursor: "pointer" }}
            onClick={() => !engine.connected && api.startEngine().catch((e) => setSave({ kind: "error", msg: `Could not start the engine: ${e}` }))}
          />
        </div>
        <div className="nav-tools">
          <SearchBox placeholder="Search apps and sites…" value={navQ} onChange={setNavQ} />
          <div className="seg">
            <button className={navTab === "active" ? "on" : ""} onClick={() => setNavTab("active")}>
              Active
            </button>
            <button className={navTab === "available" ? "on" : ""} onClick={() => setNavTab("available")}>
              Available{nav.available.length + nav.disabled.length > 0 ? ` (${nav.available.length + nav.disabled.length})` : ""}
            </button>
          </div>
        </div>
        <div className="profiles">
          {navTab === "active" && (
            <>
              <div className={"profile-item god " + (isGod ? "active " : "") + (liveName === cfg.god_mode.name ? "live" : "")} onClick={() => setSel(GOD)} title="Overrides every other profile, whatever is in the foreground">
                <span className="star on" title="Always active, everywhere" style={{ cursor: "default" }}>
                  ⚡
                </span>
                <span className="name">{cfg.god_mode.name}</span>
                <span className="badge">{countLabel(undefined, cfg.god_mode)}</span>
              </div>
              {activeRows.map((row) =>
                row === "system" ? (
                  <div
                    key="system"
                    className={"profile-item " + (isDefault ? "active " : "") + (liveName === cfg.default_profile.name ? "live " : "") + (dragOver === "system" ? "dragover" : "")}
                    onClick={() => setSel(DEFAULT)}
                    title="Used whenever no app profile binds a gesture"
                    {...dragProps("system", !navQ)}
                  >
                    <span className="star on" title="Always active" style={{ cursor: "default" }}>
                      ★
                    </span>
                    <span className="name">{cfg.default_profile.name}</span>
                    <span className="badge">{countLabel(apps.find((a) => a.kind === "system" && a.os?.includes(currentOs())), cfg.default_profile)}</span>
                  </div>
                ) : (
                  <ProfileRow key={row} i={row} draggable={!navQ} />
                ),
              )}
              {nav.active.length === 0 && navQ && <div className="nav-empty">No active profile matches "{navQ}".</div>}
              {nav.active.length > 1 && !navQ && <div className="nav-hint">Drag to set priority. Specific rules win first: a site title beats an app, one app beats a group.</div>}
            </>
          )}
          {navTab === "available" && (
            <>
              <div className="nav-platforms">
                <PlatformToggle value={allPlatforms} onChange={setAllPlatforms} compact />
              </div>
              {nav.disabled.map((i) => (
                <ProfileRow key={i} i={i} />
              ))}
              {nav.available.map((a) => (
                <div key={a.id} className={"profile-item dim " + (preview?.id === a.id ? "active" : "")} onClick={() => setPreview(a)} title="Click to look at its shortcuts; click the star to enable">
                  <button
                    className="star"
                    title="Enable with its default mappings"
                    onClick={(e) => {
                      e.stopPropagation();
                      activateApp(a);
                    }}
                  >
                    ☆
                  </button>
                  <span className="name">{a.name}</span>
                  <span className="badge">
                    {countLabel(a)}
                    {allPlatforms && !entryOnOs(a, nav.os) && <span className="ostag">{entryPlatforms(a)}</span>}
                  </span>
                </div>
              ))}
              {nav.available.length + nav.disabled.length === 0 && <div className="nav-empty">{navQ ? `Nothing matches "${navQ}".` : "Everything in the catalog is active."}</div>}
            </>
          )}
        </div>
        <div className="nav-add">
          <button onClick={() => setAdding(true)}>＋ Add application</button>
          <button className={showInputs ? "on" : ""} onClick={() => setSel(INPUTS)} title="Which key each module gesture sends">
            Inputs
          </button>
        </div>
        <div className="sidebar-foot">
          <div>
            Engine: {engine.connected ? `running${engine.version ? " v" + engine.version : ""}${engine.paused ? " (paused)" : ""}` : "not connected"}
          </div>
          <div>Active: {engine.profile ?? "—"}</div>
          <div>
            {knownUpdate ? (
              <button className="ghost update-note" style={{ padding: "2px 6px" }} onClick={() => setUpdates({ check: true })}>
                Update to {knownUpdate}…
              </button>
            ) : (
              <>
                Version {appVersion || "…"} ·{" "}
                <button className="ghost" style={{ padding: "2px 6px" }} onClick={() => setUpdates({ check: false })}>
                  Updates…
                </button>
              </>
            )}
          </div>
          <button className="ghost" style={{ justifySelf: "start", padding: "2px 6px" }} onClick={() => api.openConfigFolder()} title={path}>
            Open config folder
          </button>
        </div>
      </aside>

      <main className="main">
        {cfg.engine.check_for_updates === undefined && (
          <div className="detect warn ask-updates">
            <span>
              <b>Check for updates automatically, once a week?</b>{" "}
              <span className="muted">It downloads one small file from GitHub; nothing is installed without you.</span>
            </span>
            <span className="grow" />
            <button className="primary" onClick={() => setAutoUpdates(true)}>
              Yes
            </button>
            <button onClick={() => setAutoUpdates(false)}>No</button>
          </div>
        )}
        {preview ? (
          <CatalogPreview entry={preview} events={events} transport={cfg.transport} os={currentOs()} allPlatforms={allPlatforms} onEnable={() => activateApp(preview)} />
        ) : showInputs ? (
          <>
            <div className="topbar">
              <h1>Inputs</h1>
              <span className={"save-state " + (save.kind === "applied" ? "applied" : save.kind === "error" ? "error" : "")}>
                {save.kind === "idle" && "Changes save automatically"}
                {save.kind === "dirty" && "Editing…"}
                {save.kind === "saving" && "Saving…"}
                {save.kind === "saved" && (engine.connected ? "Saved · waiting for engine…" : "Saved")}
                {save.kind === "applied" && "Saved · applied by engine ✓"}
                {save.kind === "error" && `Error: ${save.msg}`}
              </span>
            </div>
            <div className="content">
              {unassigned && (
                <div className="detect warn">
                  <span className="muted">Received</span>
                  <span className="big mono">{transportLabel({ key: unassigned.key, mods: unassigned.mods })}</span>
                  <span className="muted">from the keyboard; no input uses it yet.</span>
                  <span style={{ flex: 1 }} />
                  <button className="primary" onClick={() => setSuggest({ key: unassigned.key, mods: unassigned.mods, seq: unassigned.seq })}>
                    Use it in the new row
                  </button>
                  <button className="ghost" onClick={() => setUnassigned(null)} title="Dismiss">
                    ✕
                  </button>
                </div>
              )}
              <Inputs transport={cfg.transport} onChange={setTransport} onRename={renameEvent} engineConnected={engine.connected} learned={learned} suggest={suggest} sortMode={sortMode} onSortMode={setSortMode} />
            </div>
          </>
        ) : (
          <>
        <div className="topbar">
          {fixed ? (
            <h1>{prof.name}</h1>
          ) : (
            <input className="title" value={prof.name} onChange={(e) => update((p) => ({ ...p, name: e.target.value }))} />
          )}
          {selectedDisabled && (
            <button className="primary" onClick={() => setEnabled(sel, true)}>
              ★ Enable
            </button>
          )}
          <span className={"save-state " + (save.kind === "applied" ? "applied" : save.kind === "error" ? "error" : "")}>
            {save.kind === "idle" && "Changes save automatically"}
            {save.kind === "dirty" && "Editing…"}
            {save.kind === "saving" && "Saving…"}
            {save.kind === "saved" && (engine.connected ? "Saved · waiting for engine…" : "Saved")}
            {save.kind === "applied" && "Saved · applied by engine ✓"}
            {save.kind === "error" && `Error: ${save.msg}`}
          </span>
          {!fixed && (
            <button onClick={() => removeProfile(sel)} title="Delete this profile and its mappings">
              Remove
            </button>
          )}
        </div>

        <div className="content">
          <div className={"detect " + (last ? (last.unbound ? "warn" : "") : "idle")}>
            {last ? (
              <>
                <span className="muted">Detected</span>
                <span className="big">{eventLabel(last.event).join(" / ")}</span>
                {last.unbound ? (
                  <span className="muted">in {last.profile}, but nothing is bound for it, so nothing happened.</span>
                ) : (
                  <span className="muted">
                    in {last.profile} → {last.action}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button className={last.unbound ? "primary" : ""} onClick={() => setPicker(last.event)}>
                  {last.unbound ? `Bind it for ${prof.name}` : `Change for ${prof.name}`}
                </button>
              </>
            ) : (
              <>
                <span>Turn the dial or swipe the Tune to detect an input.</span>
                {!engine.connected && (
                  <>
                    <span>· Engine not running.</span>
                    <button className="primary" onClick={() => api.startEngine().catch((e) => setSave({ kind: "error", msg: `Could not start the engine: ${e}` }))}>
                      Start engine
                    </button>
                  </>
                )}
              </>
            )}
          </div>

          {unassigned && (
            <div className="detect warn">
              <span className="muted">Received</span>
              <span className="big mono">{transportLabel({ key: unassigned.key, mods: unassigned.mods })}</span>
              <span className="muted">from the keyboard, but no input uses that key and modifier combination, so nothing happened.</span>
              <span style={{ flex: 1 }} />
              <button
                className="primary"
                onClick={() => {
                  setSuggest({ key: unassigned.key, mods: unassigned.mods, seq: unassigned.seq });
                  setSel(INPUTS);
                }}
              >
                Add it under Inputs
              </button>
              <button className="ghost" onClick={() => setUnassigned(null)} title="Dismiss">
                ✕
              </button>
            </div>
          )}

          {selectedDisabled && (
            <div className="detect idle">
              This profile is disabled: its mappings are kept but never used. Star it to enable.
            </div>
          )}

          {isGod && (
            <div className="detect warn">
              <span>
                <b>Binding to this profile overrides any and every other profile</b>, whatever is in the foreground. Only bind gestures you don't plan to use for any other profile. Good for system-wide moves such as switching windows or desktops.
              </span>
            </div>
          )}

          {!fixed && (
            <div className="card">
              <h2>Matches</h2>
              <div className="body" style={{ display: "grid", gap: 10 }}>
                <ChipEditor label="Windows executable" placeholder="app.exe" values={prof.match.windows_exe} onChange={(v) => editMatch("windows_exe", v)} mono />
                <ChipEditor label="Window title contains" placeholder="YouTube" values={prof.match.window_title} onChange={(v) => editMatch("window_title", v)} />
                <ChipEditor label="macOS bundle id" placeholder="com.example.App" values={prof.match.macos_bundle} onChange={(v) => editMatch("macos_bundle", v)} mono />
              </div>
            </div>
          )}

          <div className="card">
            <h2>
              Mappings
              <span className="spacer" />
              <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>
                {isGod ? "Bound rows win in every app; unbound rows do nothing here" : isDefault ? "Used whenever no app profile overrides an event" : `Unset rows use the ${cfg.default_profile.name} profile`}
              </span>
            </h2>
            <div className="tablewrap">
            <table className="map">
              <thead>
                <tr>
                  <th style={{ width: "20%" }}>
                    <SortHeader mode={sortMode} onChange={setSortMode} />
                  </th>
                  <th>Action</th>
                  <th style={{ width: 130 }}>Keys</th>
                  <th style={{ width: 190 }}>Repeat</th>
                  <th style={{ width: 90 }}></th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => {
                  const [mod, gesture] = eventLabel(ev);
                  const b = prof.bindings[ev];
                  const inherited = !b && !fixed ? cfg.default_profile.bindings[ev] : undefined;
                  const god = !isGod ? cfg.god_mode.bindings[ev] : undefined;
                  const shown = b ?? inherited;
                  const repeatable = b && (b.action.type === "keys" || b.action.type === "media" || b.action.type === "scroll");
                  const actionName = shown ? shown.name ?? (shown.action.type === "keys" ? "Custom shortcut" : describeAction(shown.action)) : "Not bound";
                  return (
                    <tr key={ev} className={flash === ev ? "flash" : ""}>
                      <td className="ev">
                        <div>{gesture}</div>
                        <div className="module">
                          {mod} · <span className="mono">{transportLabel(cfg.transport[ev])}</span>
                        </div>
                      </td>
                      <td className="action" onClick={() => setPicker(ev)}>
                        {god ? (
                          <span className="inherit" title={`${cfg.god_mode.name} binds this gesture, so it wins here. Change or unbind it in ${cfg.god_mode.name}.`}>
                            ⚡ {cfg.god_mode.name}: {god.name ?? (god.action.type === "keys" ? "Custom shortcut" : describeAction(god.action))}
                          </span>
                        ) : b ? (
                          <span className={shown?.name ? "" : "name-muted"}>{actionName}</span>
                        ) : (
                          <span className="inherit">{inherited ? `${cfg.default_profile.name}: ${actionName}` : "Not bound"}</span>
                        )}
                      </td>
                      <td className="keys">
                        {!shown ? (
                          <span className="muted">—</span>
                        ) : shown.action.type === "keys" ? (
                          <kbd>{shown.action.chord}</kbd>
                        ) : shown.action.type === "sequence" ? (
                          <kbd>{shown.action.chords.join(" , ")}</kbd>
                        ) : (
                          <span className="muted">{shown.action.type === "media" ? "media key" : shown.action.type === "scroll" ? `wheel ${shown.action.direction}` : shown.action.type}</span>
                        )}
                      </td>
                      <td>
                        {b && streams(ev) ? (
                          (() => {
                            const inputDefault = !!cfg.transport[ev]?.follow;
                            const effective = b.follow ?? inputDefault;
                            return (
                              <div className="repeat">
                                <Switch
                                  checked={effective}
                                  on="Follow swipe"
                                  off="One per swipe"
                                  title="This gesture arrives as a run of keys scaled to the finger travel (a Tune's 2-finger swipes; a Touch's 2-finger scroll and its 4-finger swipe up or down). Off: one action per swipe. On: every key acts, so the action tracks the swipe's length. Starts as the input's setting; flipping it here applies to this profile only."
                                  onChange={(v) => setFollow(ev, v === inputDefault ? null : v)}
                                />
                                {repeatable && (
                                  <label className="mult" title="Actions per key of the swipe (or per swipe when collapsed)">
                                    ×<input type="number" min={1} max={32} value={b.multiplier ?? 1} onChange={(e) => setMultiplier(ev, Number(e.target.value))} />
                                  </label>
                                )}
                              </div>
                            );
                          })()
                        ) : b ? (
                          <div className="repeat">
                            <select value={b.accel ?? "none"} disabled={!repeatable} onChange={(e) => setAccel(ev, e.target.value as Accel)} title={repeatable ? "Speed curve: turning the dial faster repeats the action more per detent" : "Only key, media and scroll actions repeat"}>
                              {ACCELS.map((a) => (
                                <option key={a} value={a}>
                                  {a}
                                </option>
                              ))}
                            </select>
                            {repeatable && (
                              <label className="mult" title="Actions per detent before the speed curve (1 = one action per detent)">
                                ×<input type="number" min={1} max={32} value={b.multiplier ?? 1} onChange={(e) => setMultiplier(ev, Number(e.target.value))} />
                              </label>
                            )}
                          </div>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="actions">
                        <button className="ghost" onClick={() => setPicker(ev)}>
                          Change
                        </button>
                        {b && (
                          <button className="ghost" title={fixed ? "Unbind" : `Use ${cfg.default_profile.name}`} onClick={() => setBinding(ev, null)}>
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>

          <div className="muted" style={{ fontSize: 12 }}>
            Config file: <span className="mono">{path}</span>. Which key each gesture sends is set under <b>Inputs</b>.
          </div>
        </div>
          </>
        )}
      </main>

      {picker && (
        <ActionPicker
          event={picker}
          current={prof.bindings[picker]}
          catalog={catalog}
          appName={appEntry?.name}
          appActions={appEntry?.actions ?? []}
          systemActions={apps.find((a) => a.kind === "system" && a.os?.includes(currentOs()))?.actions ?? []}
          os={currentOs()}
          allPlatforms={allPlatforms}
          onAllPlatforms={setAllPlatforms}
          onPick={(a, name) => setBinding(picker, a, name)}
          onClose={() => setPicker(null)}
        />
      )}
      {adding && <AddApp onAdd={addProfile} onClose={() => setAdding(false)} />}
      {updates && (
        <Updates
          version={appVersion}
          auto={cfg.engine.check_for_updates}
          onAuto={setAutoUpdates}
          checkNow={updates.check}
          onClose={() => setUpdates(null)}
        />
      )}
    </div>
  );
}

/** A search field with a clear button; Escape clears too. */
export const SearchBox = forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }>(function SearchBox(props, ref) {
  return (
    <div className={"searchbox " + (props.value ? "has-value" : "")}>
      <input
        ref={ref}
        type="text"
        placeholder={props.placeholder}
        value={props.value}
        autoFocus={props.autoFocus}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && props.value) {
            e.preventDefault();
            e.stopPropagation();
            props.onChange("");
          }
        }}
      />
      {props.value && (
        <button type="button" className="clear" title="Clear (Esc)" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => props.onChange("")}>
          ×
        </button>
      )}
    </div>
  );
});

/** A two-state toggle with a label that names the current state. */
export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; on: string; off: string; title?: string }) {
  return (
    <label className={"switch " + (props.checked ? "on" : "")} title={props.title}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="track">
        <span className="knob" />
      </span>
      <span className="switch-label">{props.checked ? props.on : props.off}</span>
    </label>
  );
}

/** The Input column header: click to cycle the sort order. */
export function SortHeader(props: { mode: SortMode; onChange: (m: SortMode) => void }) {
  return (
    <button className="sorthead" onClick={() => props.onChange(nextSortMode(props.mode))} title="Click to change the order: fingers → module → gesture → A–Z">
      Input <span className="muted">by {SORT_LABEL[props.mode]} ▾</span>
    </button>
  );
}

/** Read-only look at a catalog entry before enabling it. */
function CatalogPreview(props: { entry: AppEntry; events: string[]; transport: Config["transport"]; os: Os; allPlatforms: boolean; onEnable: () => void }) {
  const { entry: a } = props;
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const chord = (x: { windows?: Action; mac?: Action; linux?: Action }) => actionFor(x, props.os, props.allPlatforms);
  const rows = a.actions
    .map((x) => ({ x, c: chord(x) }))
    .filter(({ c }) => c)
    .filter(({ x, c }) => !needle || x.name.toLowerCase().includes(needle) || x.context.toLowerCase().includes(needle) || describeAction(c!.action).toLowerCase().includes(needle));
  const defaults = props.events.filter((ev) => a.defaults[ev]);
  const platforms = entryPlatforms(a);
  return (
    <>
      <div className="topbar">
        <h1>{a.name}</h1>
        <span className="badge">{a.kind === "site" ? "website" : a.kind}</span>
        {platforms && <span className="ostag">{platforms}</span>}
        <span className="spacer" />
        <button className="primary" onClick={props.onEnable} title="Create a profile for this app with the mappings below">
          ★ Enable
        </button>
      </div>
      <div className="content">
        <div className="card">
          <h2>Matches</h2>
          <div className="body chips">
            {a.match.windows_exe.map((v) => (
              <span key={"w" + v} className="chip mono" title="Windows executable">{v}</span>
            ))}
            {a.match.macos_bundle.map((v) => (
              <span key={"m" + v} className="chip mono" title="macOS bundle id">{v}</span>
            ))}
            {a.match.window_title.map((v) => (
              <span key={"t" + v} className="chip" title="Window title contains">title: {v}</span>
            ))}
            {a.kind === "system" && <span className="muted">System shortcuts: used by the System profile.</span>}
          </div>
        </div>

        <div className="card">
          <h2>
            Default mappings
            <span className="spacer" />
            <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>
              {defaults.length ? "What Enable will set up; every row can be changed afterwards" : "No bundled mappings; Enable creates an empty profile that falls back to System"}
            </span>
          </h2>
          {defaults.length > 0 && (
            <div className="tablewrap">
              <table className="map">
                <thead>
                  <tr>
                    <th style={{ width: "24%" }}>Input</th>
                    <th>Action</th>
                    <th style={{ width: 160 }}>Keys</th>
                  </tr>
                </thead>
                <tbody>
                  {defaults.map((ev) => {
                    const [mod, gesture] = eventLabel(ev);
                    const raw = a.defaults[ev];
                    const b = props.os === "macos" && raw.mac ? { ...raw, action: raw.mac } : raw;
                    return (
                      <tr key={ev}>
                        <td className="ev">
                          <div>{gesture}</div>
                          <div className="module">
                            {mod} · <span className="mono">{transportLabel(props.transport[ev])}</span>
                          </div>
                        </td>
                        <td>{b.name ?? (b.action.type === "keys" ? "Custom shortcut" : describeAction(b.action))}</td>
                        <td>
                          <kbd>{describeAction(b.action)}</kbd>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2>
            Shortcuts
            <span className="spacer" />
            <span className="muted" style={{ textTransform: "none", letterSpacing: 0 }}>
              {rows.length === a.actions.length ? `${a.actions.length} documented` : `${rows.length} of ${a.actions.length}`}
            </span>
          </h2>
          <div className="body" style={{ display: "grid", gap: 10 }}>
            <SearchBox placeholder={`Search ${a.name} shortcuts…`} value={q} onChange={setQ} />
            <div className="list" style={{ maxHeight: 420 }}>
              {rows.slice(0, 400).map(({ x, c }) => (
                <div key={x.id} className="row" style={{ cursor: "default" }}>
                  <div>
                    {x.name}
                    {x.context && <div className="sub">{x.context}</div>}
                  </div>
                  <div>
                    {c!.os && <span className="ostag">{OS_NAME[c!.os]}</span>}
                    <kbd>{describeAction(c!.action)}</kbd>
                  </div>
                </div>
              ))}
              {rows.length === 0 && <div className="row muted">No shortcuts match.</div>}
              {rows.length > 400 && <div className="row muted">Showing the first 400. Narrow the search to see more.</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ChipEditor(props: { label: string; placeholder: string; values: string[]; onChange: (v: string[]) => void; mono?: boolean }) {
  const [draft, setDraft] = useState("");
  function commit() {
    const v = draft.trim();
    if (v && !props.values.includes(v)) props.onChange([...props.values, v]);
    setDraft("");
  }
  return (
    <div className="field">
      <label>{props.label}</label>
      <div className="chips">
        {props.values.map((v) => (
          <span key={v} className={"chip " + (props.mono ? "mono" : "")}>
            {v}
            <button title="Remove" onClick={() => props.onChange(props.values.filter((x) => x !== v))}>
              ✕
            </button>
          </span>
        ))}
        <span className="chip-add">
          <input
            className={props.mono ? "mono" : ""}
            placeholder={props.placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            onBlur={commit}
          />
        </span>
      </div>
    </div>
  );
}
