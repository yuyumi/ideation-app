import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { api, errorText } from "../api";
import type { ClaudeSettings, Environment, GhStatus, PilotPermission, PilotSettings, WindowSettings } from "../types";
import { PERMISSION_LABEL } from "../pilots/NewPilotDialog";

// Keep in sync with src-tauri/src/settings.rs.
const DEFAULT_WINDOW: WindowSettings = { width: 1296, height: 810, topGapPercent: 0.5 };
const LIMITS = { minWidth: 960, minHeight: 600, maxDim: 10000, maxGap: 20 };
const MODEL_SUGGESTIONS = ["sonnet", "opus", "haiku", "fable"];

type WindowDraft = Record<keyof WindowSettings, string>;

const toDraft = (w: WindowSettings): WindowDraft => ({
  width: String(w.width),
  height: String(w.height),
  topGapPercent: String(w.topGapPercent),
});

function parseWindow(d: WindowDraft): { value?: WindowSettings; error?: string } {
  const width = Number(d.width);
  const height = Number(d.height);
  const topGapPercent = Number(d.topGapPercent);
  if (!Number.isFinite(width) || width < LIMITS.minWidth || width > LIMITS.maxDim)
    return { error: `Width must be between ${LIMITS.minWidth} and ${LIMITS.maxDim}` };
  if (!Number.isFinite(height) || height < LIMITS.minHeight || height > LIMITS.maxDim)
    return { error: `Height must be between ${LIMITS.minHeight} and ${LIMITS.maxDim}` };
  if (!Number.isFinite(topGapPercent) || topGapPercent < 0 || topGapPercent > LIMITS.maxGap)
    return { error: `Top gap must be between 0 and ${LIMITS.maxGap}%` };
  return { value: { width, height, topGapPercent } };
}

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [win, setWin] = useState<WindowDraft | null>(null);
  const [claude, setClaude] = useState<ClaudeSettings | null>(null);
  const [pilots, setPilots] = useState<PilotSettings | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setWin(toDraft(s.window));
        setClaude(s.claude);
        setPilots(s.pilots);
      })
      .catch((e) => setError(errorText(e)));
    api.checkEnvironment().then(setEnv).catch(() => {});
    api.githubStatus().then(setGh).catch(() => {});
    getVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setW = (key: keyof WindowSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setWin((d) => (d ? { ...d, [key]: e.target.value } : d));

  const useCurrentSize = async () => {
    try {
      const [width, height] = await api.currentWindowSize();
      setWin((d) => (d ? { ...d, width: String(width), height: String(height) } : d));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const browseClaude = async () => {
    const file = await open({ title: "Locate claude.exe or claude.cmd", filters: [{ name: "Claude Code", extensions: ["exe", "cmd"] }] });
    if (typeof file === "string") setClaude((c) => (c ? { ...c, path: file } : c));
  };

  const signIn = async () => {
    try {
      await api.githubLogin();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const save = async () => {
    if (!win || !claude || !pilots) return;
    const { value, error: invalid } = parseWindow(win);
    if (!value) return setError(invalid ?? "Invalid settings");
    if (!Number.isInteger(pilots.maxConcurrent) || pilots.maxConcurrent < 1 || pilots.maxConcurrent > 8) return setError("Pilots at once must be between 1 and 8");
    if (!(pilots.maxBudgetUsd >= 0 && pilots.maxBudgetUsd <= 1000)) return setError("Spending cap must be between 0 and 1000 USD");
    if (!Number.isInteger(pilots.maxTurns) || pilots.maxTurns < 0) return setError("Turn limit must be a whole number, 0 or more");
    setBusy(true);
    setError(null);
    try {
      await api.saveSettings({
        window: value,
        claude: { ...claude, path: claude.path.trim(), model: claude.model.trim() },
        pilots: { ...pilots, model: pilots.model.trim() },
      });
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        {!win || !claude || !pilots ? (
          <p className="muted">{error ?? "Loading…"}</p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <fieldset>
              <legend>Window</legend>
              <p className="muted small">Applied now and on every launch. The window is centered horizontally on the monitor it opens on.</p>
              <label className="grid">
                <span>Width</span>
                <input type="number" min={LIMITS.minWidth} max={LIMITS.maxDim} step={1} value={win.width} onChange={setW("width")} />
                <span className="muted small">px</span>
              </label>
              <label className="grid">
                <span>Height</span>
                <input type="number" min={LIMITS.minHeight} max={LIMITS.maxDim} step={1} value={win.height} onChange={setW("height")} />
                <span className="muted small">px</span>
              </label>
              <label className="grid">
                <span>Top gap</span>
                <input type="number" min={0} max={LIMITS.maxGap} step={0.1} value={win.topGapPercent} onChange={setW("topGapPercent")} />
                <span className="muted small">% of screen height</span>
              </label>
              <div className="row">
                <button type="button" className="small" onClick={useCurrentSize}>Use current window size</button>
                <button type="button" className="small" onClick={() => setWin(toDraft(DEFAULT_WINDOW))}>Reset to defaults</button>
              </div>
            </fieldset>

            <fieldset>
              <legend>Claude Code</legend>
              <p className="muted small">
                {env?.claude ? `Found ${env.claude}${env.claudePath ? ` at ${env.claudePath}` : ""}.` : "Claude Code was not found automatically."}
              </p>
              <label className="stack">
                <span>Path to claude</span>
                <span className="row">
                  <input className="grow" placeholder="Auto-detect" value={claude.path} onChange={(e) => setClaude({ ...claude, path: e.target.value })} />
                  <button type="button" className="small" onClick={browseClaude}>Browse…</button>
                </span>
              </label>
              <label className="stack">
                <span>Model for chat</span>
                <input
                  list="model-suggestions"
                  placeholder="sonnet (newest Sonnet)"
                  value={claude.model}
                  onChange={(e) => setClaude({ ...claude, model: e.target.value })}
                />
                <span className="muted small">Empty uses <code>sonnet</code>, which always resolves to the newest Sonnet model.</span>
                <datalist id="model-suggestions">
                  {MODEL_SUGGESTIONS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <label className="check">
                <input type="checkbox" checked={claude.repoAccess} onChange={(e) => setClaude({ ...claude, repoAccess: e.target.checked })} />
                Let chat read the board's repository (read-only: Read, Glob, Grep)
              </label>
            </fieldset>

            <fieldset>
              <legend>Pilots</legend>
              <p className="muted small">Defaults for new pilots. Each pilot can override model, permissions and limits.</p>
              <label className="stack">
                <span>Model</span>
                <input list="model-suggestions" placeholder="Claude Code's default" value={pilots.model} onChange={(e) => setPilots({ ...pilots, model: e.target.value })} />
              </label>
              <label className="stack">
                <span>Permissions</span>
                <select value={pilots.permission} onChange={(e) => setPilots({ ...pilots, permission: e.target.value as PilotPermission })}>
                  {(Object.keys(PERMISSION_LABEL) as PilotPermission[]).map((p) => (
                    <option key={p} value={p}>{PERMISSION_LABEL[p]}</option>
                  ))}
                </select>
              </label>
              <label className="grid">
                <span>At once</span>
                <input type="number" min={1} max={8} step={1} value={pilots.maxConcurrent} onChange={(e) => setPilots({ ...pilots, maxConcurrent: Number(e.target.value) })} />
                <span className="muted small">pilots running in parallel</span>
              </label>
              <label className="grid">
                <span>Spending cap</span>
                <input type="number" min={0} step={0.5} value={pilots.maxBudgetUsd} onChange={(e) => setPilots({ ...pilots, maxBudgetUsd: Number(e.target.value) })} />
                <span className="muted small">USD per run, 0 = none</span>
              </label>
              <label className="grid">
                <span>Turn limit</span>
                <input type="number" min={0} step={1} value={pilots.maxTurns} onChange={(e) => setPilots({ ...pilots, maxTurns: Number(e.target.value) })} />
                <span className="muted small">per run, 0 = none</span>
              </label>
              <p className="muted small">Pilots can never push to GitHub themselves; use Push branch on a pilot.</p>
            </fieldset>

            <fieldset>
              <legend>GitHub</legend>
              {!gh ? (
                <p className="muted small">Checking…</p>
              ) : !gh.installed ? (
                <p className="small">
                  The GitHub CLI is not installed. Install it with <code>winget install --id GitHub.cli</code>, then reopen Settings.
                </p>
              ) : (
                <div className="row center">
                  <span className="grow small">{gh.user ? `Signed in as ${gh.user}` : "Not signed in"}</span>
                  <button type="button" className="small" onClick={signIn}>{gh.user ? "Switch account" : "Sign in"}</button>
                  <button type="button" className="small ghost" onClick={() => api.githubStatus().then(setGh)}>Refresh</button>
                </div>
              )}
            </fieldset>

            {error && <div className="error" role="alert">{error}</div>}
            <div className="modal-actions">
              {version && <span className="muted small grow">Ideation {version} · MIT License</span>}
              <button type="button" onClick={onClose}>Cancel</button>
              <button type="submit" className="primary" disabled={busy}>Save</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
