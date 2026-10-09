import { useEffect, useState } from "react";
import { api, type UpdateOffer } from "./api";

type Check =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "offer"; offer: UpdateOffer }
  | { kind: "installing"; received: number; total?: number }
  | { kind: "error"; msg: string };

/**
 * The Updates panel: this version, the weekly-check switch, and checking and
 * installing on demand. Installing always waits for a click.
 */
export function Updates(props: {
  version: string;
  auto: boolean | undefined;
  onAuto: (on: boolean) => void;
  checkNow: boolean;
  onClose: () => void;
}) {
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  const busy = check.kind === "checking" || check.kind === "installing";

  async function runCheck() {
    setCheck({ kind: "checking" });
    try {
      const offer = await api.updateCheck();
      setCheck(offer ? { kind: "offer", offer } : { kind: "current" });
    } catch (e) {
      setCheck({ kind: "error", msg: String(e) });
    }
  }

  async function install() {
    setCheck({ kind: "installing", received: 0 });
    try {
      // Windows: the installer replaces this program and starts it again;
      // macOS: the app restarts itself once the new bundle is in place.
      await api.updateInstall();
    } catch (e) {
      setCheck({ kind: "error", msg: String(e) });
    }
  }

  useEffect(() => {
    if (props.checkNow) void runCheck();
    const un = api.onUpdateProgress((p) =>
      setCheck((c) => (c.kind === "installing" ? { kind: "installing", received: p.received, total: p.total ?? undefined } : c)),
    );
    return () => {
      void un.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pct = check.kind === "installing" && check.total ? Math.min(100, Math.round((check.received / check.total) * 100)) : null;

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && props.onClose()}>
      <div className="modal" role="dialog" aria-label="Updates">
        <header>
          <h3>Updates</h3>
          <button className="ghost" onClick={props.onClose} disabled={busy}>
            ✕
          </button>
        </header>
        <div className="mbody">
          <div>
            Create Companion <b>{props.version || "…"}</b>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={props.auto === true} onChange={(e) => props.onAuto(e.target.checked)} />
            Check for updates automatically, once a week
          </label>
          <div className="muted small">
            A check downloads one small file from GitHub that names the newest release. Nothing about you or your setup is sent, and nothing is
            installed until you click Install.
          </div>

          {check.kind === "current" && <div className="update-state ok">You have the latest version.</div>}
          {check.kind === "error" && <div className="update-state error">Could not check: {check.msg}</div>}
          {check.kind === "offer" && (
            <div className="update-offer">
              <div>
                <b>Version {check.offer.version}</b> is available.
              </div>
              {check.offer.notes && <pre className="update-notes">{check.offer.notes}</pre>}
            </div>
          )}
          {check.kind === "installing" && (
            <div className="update-offer">
              <div>{pct === null ? "Downloading…" : pct < 100 ? `Downloading… ${pct}%` : "Installing…"}</div>
              <div className="progress">
                <div style={{ width: `${pct ?? 5}%` }} />
              </div>
              <div className="muted small">Create Companion closes while the update installs and starts again on its own.</div>
            </div>
          )}
        </div>
        <footer>
          {check.kind === "offer" ? (
            <button className="primary" onClick={install}>
              Install {check.offer.version} and restart
            </button>
          ) : (
            <button onClick={runCheck} disabled={busy}>
              {check.kind === "checking" ? "Checking…" : "Check now"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
