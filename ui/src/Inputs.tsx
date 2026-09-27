import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import {
  buildMods,
  type SortMode,
  sortEvents,
  streams,
  fingerOptions,
  fingersLabel,
  FUNCTION_KEYS,
  gestureLabel,
  makeEvent,
  MODULES,
  moduleLabel,
  moduleBehavior,
  choicesFor,
  choiceLabel,
  halvesOf,
  isPair,
  pairOf,
  PAIRS,
  type GestureChoice,
  parseEvent,
  parseMods,
  takesFingers,
  TRANSPORT_MODS,
  transportLabel,
  type Mods,
  type TransportCode,
} from "./types";
import type { GestureId, ModuleId } from "./events";
import { SortHeader, Switch } from "./App";

export interface Learned {
  key: string;
  mods: Mods;
  seq: number;
}

const MOD_BUTTON: Record<string, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: "Win", fn: "Fn" };
const MOD_TITLE: Record<string, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", cmd: "Win on Windows, Cmd on macOS", fn: "Fn (Globe): macOS only, and only if the module firmware can send it" };
/** Module-profile keycode tokens for the modifiers a module can send. */
const PROFILE_MOD: Record<string, string> = { ctrl: "LCTRL", shift: "LSHIFT", alt: "LALT", cmd: "LGUI" };
/** macOS has virtual key codes for F13–F20 only. */
const MAC_OK = new Set(["F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20"]);

/** Module-profile chord token, the vocabulary OpenFlow's encoder speaks. */
function profileChord(t: TransportCode): string {
  const toks = [...parseMods(t.mods)].filter((m) => PROFILE_MOD[m]).map((m) => PROFILE_MOD[m]);
  return [...toks, t.key].join(" + ");
}

/** An OpenFlow module-profile action for one transport code. */
function profileAction(t: TransportCode): { actionType: string; actionCode: string } {
  return parseMods(t.mods).size === 0 ? { actionType: "key", actionCode: t.key } : { actionType: "shortcut_alias", actionCode: profileChord(t) };
}

function KeySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <select className="mono" value={value} onChange={(e) => onChange(e.target.value)} title={MAC_OK.has(value) ? "" : "F21–F24 do not exist on macOS"}>
      <optgroup label="Windows and macOS">
        {FUNCTION_KEYS.filter((k) => MAC_OK.has(k)).map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </optgroup>
      <optgroup label="Windows only">
        {FUNCTION_KEYS.filter((k) => !MAC_OK.has(k)).map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

/** Toggle buttons for the namespace modifiers a module can hold with its key. */
function ModToggles({ value, onChange }: { value: Mods | undefined; onChange: (v: Mods) => void }) {
  const set = parseMods(value);
  return (
    <div className="modtoggles">
      {TRANSPORT_MODS.map((m) => (
        <button
          key={m}
          type="button"
          className={set.has(m) ? "on" : ""}
          title={MOD_TITLE[m]}
          onClick={() => {
            const next = new Set(set);
            if (next.has(m)) next.delete(m);
            else next.add(m);
            onChange(buildMods(next));
          }}
        >
          {MOD_BUTTON[m]}
        </button>
      ))}
    </div>
  );
}

function FingerSelect({ module, gesture, value, onChange }: { module: ModuleId; gesture: GestureId; value: number | null; onChange: (v: number | null) => void }) {
  if (!takesFingers(gesture)) return <span className="muted">dial</span>;
  const allowed = fingerOptions(module, gesture);
  // A row made before a count was withheld keeps showing its value; only new choices are limited.
  const opts = value && !allowed.includes(value) ? [value, ...allowed] : allowed;
  const title =
    "How many fingers the module was flashed for. Every input needs a count: an any-count row next to a counted one for the same gesture would fight over the same flashed field." +
    (module === "TUNE" ? "" : " A Touch cannot map 1 finger or a 2-finger tap yet: the module firmware owns those.") +
    (value === null ? " This row predates finger counts: pick one to export it." : "");
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} title={title}>
      {/* "any fingers" is no longer offered; a legacy row without a count still shows it until a count is picked. */}
      {value === null && <option value="">any fingers</option>}
      {opts.map((n) => (
        <option key={n} value={n}>
          {fingersLabel(n)}
        </option>
      ))}
    </select>
  );
}

export function Inputs(props: {
  transport: Record<string, TransportCode>;
  onChange: (t: Record<string, TransportCode>) => void;
  onRename: (from: string, to: string) => void;
  engineConnected: boolean;
  learned: Learned | null;
  /** A key the keyboard sent that no input uses: prefill the add row with it. */
  suggest?: Learned | null;
  /** Order of the rows; shared with the profile mapping tables. */
  sortMode: SortMode;
  onSortMode: (m: SortMode) => void;
}) {
  const events = useMemo(() => sortEvents(Object.keys(props.transport), props.sortMode), [props.transport, props.sortMode]);
  const [armed, setArmedState] = useState<string | null>(null); // event being learned, or "new"
  const armedRef = useRef<string | null>(null);
  const setArmed = (v: string | null) => {
    armedRef.current = v;
    setArmedState(v);
  };
  const [newModule, setNewModule] = useState<ModuleId>("TUNE");
  const [newGesture, setNewGesture] = useState<GestureChoice>("TAP");
  const [newFingers, setNewFingers] = useState<number | null>(1);
  const [newKey, setNewKey] = useState<string>("F13");
  /** Second key of a pair (the `+` half); the first key is the `-` half. */
  const [newKey2, setNewKey2] = useState<string>("F14");
  /** "Follow the swipe" for a new streamed input. */
  const [newFollow, setNewFollow] = useState(false);
  const [newMods, setNewMods] = useState<Mods>("none");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const codeKey = (c: TransportCode) => `${buildMods(parseMods(c.mods))}+${c.key}`;
  const used = useMemo(() => {
    const m = new Map<string, string>();
    for (const ev of events) m.set(codeKey(props.transport[ev]), ev);
    return m;
  }, [events, props.transport]);

  const describe = (ev: string) => {
    const p = parseEvent(ev);
    return p ? `${moduleLabel(p.module)} / ${gestureLabel(p.gesture)}${p.fingers ? ` (${fingersLabel(p.fingers)})` : ""}` : ev;
  };

  // A learned key arrives: fill the row that was armed when Learn was clicked.
  useEffect(() => {
    const target = armedRef.current;
    if (!props.learned || !target) return;
    const code: TransportCode = { key: props.learned.key, mods: props.learned.mods };
    if (target === "new") {
      setNewKey(code.key);
      setNewMods(code.mods ?? "none");
      setMsg({ text: `Learned ${transportLabel(code)} — press Add to keep it`, ok: true });
    } else {
      setCode(target, code);
      setMsg({ text: `Learned ${transportLabel(code)} for ${describe(target)}`, ok: true });
    }
    setArmed(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.learned?.seq]);

  // An unassigned key was handed over from the detect banner: prefill the add row.
  useEffect(() => {
    if (!props.suggest) return;
    setNewKey(props.suggest.key);
    setNewMods(props.suggest.mods ?? "none");
    setMsg({ text: `${transportLabel({ key: props.suggest.key, mods: props.suggest.mods })} came from the keyboard. Pick the module and gesture it belongs to, then press Add.`, ok: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.suggest?.seq]);

  function setCode(ev: string, code: TransportCode) {
    const owner = used.get(codeKey(code));
    if (owner && owner !== ev) {
      setMsg({ text: `${transportLabel(code)} is already used by ${describe(owner)}.`, ok: false });
      return;
    }
    setMsg(null);
    props.onChange({ ...props.transport, [ev]: code });
  }

  function setFingers(ev: string, fingers: number | null) {
    const p = parseEvent(ev);
    if (!p) return;
    const to = makeEvent(p.module, p.gesture, fingers);
    if (to !== ev && props.transport[to]) {
      setMsg({ text: `${describe(to)} already exists.`, ok: false });
      return;
    }
    setMsg(null);
    props.onRename(ev, to);
  }

  function remove(ev: string) {
    const t = { ...props.transport };
    delete t[ev];
    props.onChange(t);
  }

  /** The events the add row would create (two for a pair) with their keys. */
  function pendingRows(): [string, TransportCode][] {
    const keys = [newKey, newKey2];
    return halvesOf(newGesture).map((g, i) => {
      const ev = makeEvent(newModule, g, newFingers);
      const code: TransportCode = { key: keys[i], mods: newMods };
      if (streams(ev) && newFollow) code.follow = true;
      return [ev, code];
    });
  }

  function add() {
    const rows = pendingRows();
    for (const [ev] of rows) {
      if (props.transport[ev]) {
        setMsg({ text: `${describe(ev)} already has a key. Edit it in the list.`, ok: false });
        return;
      }
    }
    const seen = new Set<string>();
    for (const [, code] of rows) {
      if (used.has(codeKey(code))) {
        setMsg({ text: `${transportLabel(code)} is already used by ${describe(used.get(codeKey(code))!)}.`, ok: false });
        return;
      }
      if (seen.has(codeKey(code))) {
        setMsg({ text: `Both directions of ${choiceLabel(newGesture)} are set to ${transportLabel(code)}; pick two different keys.`, ok: false });
        return;
      }
      seen.add(codeKey(code));
    }
    setMsg(null);
    const next = { ...props.transport, ...Object.fromEntries(rows) };
    props.onChange(next);
    advanceAddRow(next);
  }

  /**
   * After an Add, move the add row on to the next gesture that has no key yet
   * (same module, same finger count where possible) and the next unused keys,
   * so it is ready for another entry instead of pointing at the row just made.
   */
  function advanceAddRow(t: Record<string, TransportCode>) {
    const taken = new Set(Object.values(t).map(codeKey));
    const free = FUNCTION_KEYS.filter((k) => !taken.has(codeKey({ key: k, mods: newMods })));
    setNewKey(free[0] ?? newKey);
    setNewKey2(free[1] ?? free[0] ?? newKey2);
    for (const c of choicesFor(newModule)) {
      const opts = fingerOptions(newModule, halvesOf(c)[0]);
      const counts: (number | null)[] = opts.length === 0 ? [null] : newFingers && opts.includes(newFingers) ? [newFingers, ...opts.filter((n) => n !== newFingers)] : opts;
      for (const n of counts) {
        if (halvesOf(c).every((g) => !t[makeEvent(newModule, g, n)])) {
          setNewGesture(c);
          setNewFingers(n);
          return;
        }
      }
    }
  }

  async function toggleLearn(target: string) {
    if (armed === target) {
      setArmed(null);
      await api.engineSend({ cmd: "learn", on: false }).catch(() => {});
      return;
    }
    try {
      await api.engineSend({ cmd: "learn", on: true });
      setArmed(target);
      setMsg(null);
    } catch (e) {
      setMsg({ text: `Learn needs the engine running: ${e}`, ok: false });
    }
  }

  /**
   * One OpenFlow module profile per module (`openflow.module-profile` v1):
   * discrete gestures become `key` / `shortcut_alias` actions; the dial and
   * scroll axes become a `value` pair with `split` halves.
   */
  async function exportProfiles() {
    const dir = await open({ directory: true, multiple: false, title: "Folder for the module profile files" });
    if (typeof dir !== "string") return;
    const written: string[] = [];
    const skipped: string[] = [];
    for (const module of MODULES) {
      const evs = events.filter((ev) => parseEvent(ev)?.module === module);
      if (evs.length === 0) continue;
      const bindings: Record<string, { actionType: string; actionCode: string; split?: Record<string, { actionType: string; actionCode: string }> }> = {};
      for (const ev of evs) {
        const nb = moduleBehavior(ev);
        if (!nb) {
          skipped.push(`${describe(ev)}: set a finger count first`);
          continue;
        }
        if (parseMods(props.transport[ev].mods).has("fn")) skipped.push(`${describe(ev)}: Fn has no keycode in the module profile format; exported without it`);
        const action = profileAction(props.transport[ev]);
        if (nb.half) {
          const pair = (bindings[nb.behavior] ??= { actionType: "value", actionCode: "", split: {} });
          pair.split![nb.half] = action;
          const minus = pair.split!["-"]?.actionCode ?? "";
          const plus = pair.split!["+"]?.actionCode ?? "";
          pair.actionCode = `${minus} - ${plus}`;
        } else {
          bindings[nb.behavior] = action;
        }
      }
      for (const [b, v] of Object.entries(bindings)) {
        if (v.split && (!v.split["-"] || !v.split["+"])) skipped.push(`${b}: only one direction is bound (exported as is)`);
      }
      if (Object.keys(bindings).length === 0) continue;
      const doc = {
        format: "openflow.module-profile",
        version: 1,
        moduleType: module === "TUNE" ? "TUNE" : "TOUCH",
        name: `Create Companion ${moduleLabel(module)}`,
        bindings,
      };
      const file = `${dir.replace(/[\\/]+$/, "")}\\create-companion-${module.toLowerCase().replace("_", "-")}.json`;
      try {
        await api.writeTextFile(file, JSON.stringify(doc, null, 2) + "\n");
        written.push(file.split(/[\\/]/).pop()!);
      } catch (e) {
        skipped.push(`${moduleLabel(module)}: ${e}`);
      }
    }
    setMsg({
      text: `${written.length ? `Exported ${written.join(", ")} to ${dir}` : "Nothing exported"}${skipped.length ? ` · ${skipped.join("; ")}` : ""}`,
      ok: written.length > 0,
    });
  }

  return (
    <>
      <div className="detect idle">
        <span>
          Each gesture is flashed on the module (with OpenFlow) to send one key. List the same keys here; only these are intercepted, every other key passes
          through. Hold modifiers on the module to keep two modules apart, e.g. Tune on plain keys, Left Touch on Shift, Right Touch on Cmd. On macOS use
          F13–F20 only (F21–F24 do not exist there). Set the finger count to export a module profile.
        </span>
      </div>

      {msg && (
        <div className={"detect " + (msg.ok ? "" : "idle")}>
          <span className={msg.ok ? "big" : "error"}>{msg.text}</span>
        </div>
      )}
      {armed && (
        <div className="detect">
          <span className="big">Listening…</span>
          <span className="muted">Perform the gesture on the module now. Any F13–F24 key it sends will be captured (and passed through if it is not yet an input).</span>
        </div>
      )}

      <div className="card">
        <h2>
          Inputs
          <span className="spacer" />
          <button className="ghost" onClick={exportProfiles} title="Write one openflow.module-profile JSON per module, ready for OpenFlow's Import">
            Export for OpenFlow…
          </button>
        </h2>
        <div className="tablewrap">
          <table className="map">
            <thead>
              <tr>
                <th style={{ width: "24%" }}>
                  <SortHeader mode={props.sortMode} onChange={props.onSortMode} />
                </th>
                <th style={{ width: 110 }}>Fingers</th>
                <th>Sends</th>
                <th style={{ width: 140 }} title="Only 2-finger swipes stream; everything else sends one key per gesture">
                  Follow swipe
                </th>
                <th style={{ width: 150 }}></th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => {
                const t = props.transport[ev];
                const p = parseEvent(ev);
                if (!p) return null;
                return (
                  <tr key={ev} className={armed === ev ? "flash" : ""}>
                    <td className="ev">
                      <div>{gestureLabel(p.gesture)}</div>
                      <div className="module">
                        {moduleLabel(p.module)}
                        {pairOf(p.gesture) && ` · ${PAIRS[pairOf(p.gesture)!].label}`}
                      </div>
                    </td>
                    <td>
                      <FingerSelect module={p.module} gesture={p.gesture} value={p.fingers} onChange={(n) => setFingers(ev, n)} />
                    </td>
                    <td>
                      <div className="sends">
                        <ModToggles value={t.mods} onChange={(mods) => setCode(ev, { ...t, mods })} />
                        <KeySelect value={t.key} onChange={(key) => setCode(ev, { ...t, key })} />
                        <kbd>{transportLabel(t)}</kbd>
                      </div>
                    </td>
                    <td>
                      {streams(ev) ? (
                        <Switch
                          checked={!!t.follow}
                          on="Follow swipe"
                          off="One per swipe"
                          title="This gesture arrives as a run of keys scaled to how far the fingers travel (a Tune's 2-finger swipes; a Touch's 2-finger scroll and its 4-finger swipe up or down). Off: one action per swipe. On: every key acts, so volume or scroll follows the swipe. This is the default for every profile; a profile can flip it for itself."
                          onChange={(v) => setCode(ev, { ...t, follow: v })}
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="actions">
                      <button className={"ghost " + (armed === ev ? "primary" : "")} disabled={!props.engineConnected && armed !== ev} onClick={() => toggleLearn(ev)} title="Press the gesture on the module; the key it sends fills this row">
                        {armed === ev ? "Waiting…" : "Learn"}
                      </button>
                      <button className="ghost" title="Remove this input" onClick={() => remove(ev)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td className="ev">
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <select
                      value={newModule}
                      onChange={(e) => {
                        const m = e.target.value as ModuleId;
                        setNewModule(m);
                        const c = choicesFor(m).includes(newGesture) ? newGesture : "TAP";
                        setNewGesture(c);
                        const opts = fingerOptions(m, halvesOf(c)[0]);
                        setNewFingers(opts.length === 0 ? null : newFingers && opts.includes(newFingers) ? newFingers : opts[0]);
                      }}
                    >
                      {MODULES.map((m) => (
                        <option key={m} value={m}>
                          {moduleLabel(m)}
                        </option>
                      ))}
                    </select>
                    <select
                      value={newGesture}
                      onChange={(e) => {
                        const c = e.target.value as GestureChoice;
                        setNewGesture(c);
                        const opts = fingerOptions(newModule, halvesOf(c)[0]);
                        setNewFingers(opts.length === 0 ? null : newFingers && opts.includes(newFingers) ? newFingers : opts[0]);
                      }}
                    >
                      {choicesFor(newModule).map((c) => (
                        <option key={c} value={c}>
                          {choiceLabel(c)}
                        </option>
                      ))}
                    </select>
                  </div>
                </td>
                <td>
                  <FingerSelect module={newModule} gesture={halvesOf(newGesture)[0]} value={newFingers} onChange={setNewFingers} />
                </td>
                <td>
                  <div className="sends">
                    <ModToggles value={newMods} onChange={setNewMods} />
                    {isPair(newGesture) ? (
                      <>
                        <span className="muted">{gestureLabel(halvesOf(newGesture)[0])}</span>
                        <KeySelect value={newKey} onChange={setNewKey} />
                        <span className="muted">{gestureLabel(halvesOf(newGesture)[1])}</span>
                        <KeySelect value={newKey2} onChange={setNewKey2} />
                      </>
                    ) : (
                      <>
                        <KeySelect value={newKey} onChange={setNewKey} />
                        <kbd>{transportLabel({ key: newKey, mods: newMods })}</kbd>
                      </>
                    )}
                  </div>
                </td>
                <td>
                  {halvesOf(newGesture).some((g) => streams(makeEvent(newModule, g, newFingers))) ? (
                    <Switch checked={newFollow} on="Follow swipe" off="One per swipe" title="Off: one action per swipe. On: every key of the run acts." onChange={setNewFollow} />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="actions">
                  <button className={"ghost " + (armed === "new" ? "primary" : "")} disabled={!props.engineConnected && armed !== "new"} onClick={() => toggleLearn("new")}>
                    {armed === "new" ? "Waiting…" : "Learn"}
                  </button>
                  <button className="primary" onClick={add} disabled={pendingRows().some(([ev]) => props.transport[ev])} title={pendingRows().some(([ev]) => props.transport[ev]) ? "This gesture already has a key" : ""}>
                    Add
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
