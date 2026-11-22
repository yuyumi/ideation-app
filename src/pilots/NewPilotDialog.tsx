import { useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { api, errorText } from "../api";
import { buildPrompt, serializeBoard } from "../board/serialize";
import { addPilotCard } from "../board/pilotCards";
import type { PilotMeta, PilotPermission, PilotSettings } from "../types";

export const PERMISSION_LABEL: Record<PilotPermission, string> = {
  auto: "Auto: Claude Code approves routine actions and blocks risky ones",
  editsOnly: "Edits only: read and write files, no commands",
  full: "Full access: everything allowed",
};

interface Props {
  boardPath: string;
  getApi: () => ExcalidrawImperativeAPI | null;
  onClose: () => void;
  onStarted: (meta: PilotMeta) => void;
}

export default function NewPilotDialog({ boardPath, getApi, onClose, onStarted }: Props) {
  const ex = getApi();
  const selected = ex ? Object.entries(ex.getAppState().selectedElementIds).filter(([, v]) => v).length : 0;
  const [defaults, setDefaults] = useState<PilotSettings | null>(null);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [scope, setScope] = useState<"board" | "selection">(selected > 0 ? "selection" : "board");
  const [model, setModel] = useState("");
  const [permission, setPermission] = useState<PilotPermission>("auto");
  const [budget, setBudget] = useState("");
  const [turns, setTurns] = useState("");
  const [addCard, setAddCard] = useState(true);
  const [uncommitted, setUncommitted] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((s) => {
      setDefaults(s.pilots);
      setModel(s.pilots.model);
      setPermission(s.pilots.permission);
      setBudget(String(s.pilots.maxBudgetUsd));
      setTurns(String(s.pilots.maxTurns));
    });
    api.repoRemoteStatus(boardPath).then((r) => setUncommitted(r.uncommitted)).catch(() => {});
  }, [boardPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const start = async () => {
    const ex = getApi();
    if (!ex || !instructions.trim()) return;
    const maxBudgetUsd = Number(budget || 0);
    const maxTurns = Number(turns || 0);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd < 0) return setError("Spending cap must be 0 or more");
    if (!Number.isInteger(maxTurns) || maxTurns < 0) return setError("Turn limit must be a whole number, 0 or more");
    const sel = scope === "selection" ? ex.getAppState().selectedElementIds : null;
    const { board } = serializeBoard(ex.getSceneElementsIncludingDeleted(), sel);
    setBusy(true);
    setError(null);
    try {
      const meta = await api.pilotStart({
        boardPath,
        title,
        instructions: instructions.trim(),
        prompt: buildPrompt(instructions, board),
        scope,
        model: model.trim(),
        permission,
        maxBudgetUsd,
        maxTurns,
      });
      if (addCard) addPilotCard(ex, meta, sel);
      onStarted(meta);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" role="dialog" aria-label="Run pilot" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Run a pilot</h2>
        <p className="muted small">
          Claude Code works unattended in its own copy of the repo, on a new branch. Ask it for a small app, an experiment, metrics, a prototype.
          It finishes with a report and puts outputs in <code>results/</code>.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <label className="stack">
            <span>Instructions</span>
            <textarea
              autoFocus
              rows={6}
              value={instructions}
              placeholder="e.g. Build a minimal prototype of the cache layer on this board and measure hit rate under a Zipf workload. Plot hit rate against cache size."
              onChange={(e) => setInstructions(e.target.value)}
            />
          </label>
          <label className="stack">
            <span>Title</span>
            <input value={title} placeholder="Defaults to the first line of the instructions" onChange={(e) => setTitle(e.target.value)} />
          </label>
          <div className="row center">
            <span className="small">Board context</span>
            <div className="scope">
              <button type="button" className={scope === "board" ? "on" : ""} onClick={() => setScope("board")}>Whole board</button>
              <button type="button" className={scope === "selection" ? "on" : ""} disabled={selected === 0} onClick={() => setScope("selection")}>
                Selection ({selected})
              </button>
            </div>
          </div>
          <details>
            <summary className="small">Model, permissions and limits</summary>
            <div className="options-grid">
              <label className="stack">
                <span>Model</span>
                <input list="pilot-models" value={model} placeholder="Claude Code's default" onChange={(e) => setModel(e.target.value)} />
                <datalist id="pilot-models">
                  {["sonnet", "opus", "haiku", "fable"].map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>
              <label className="stack">
                <span>Permissions</span>
                <select value={permission} onChange={(e) => setPermission(e.target.value as PilotPermission)}>
                  {(Object.keys(PERMISSION_LABEL) as PilotPermission[]).map((p) => (
                    <option key={p} value={p}>{PERMISSION_LABEL[p]}</option>
                  ))}
                </select>
              </label>
              <label className="stack">
                <span>Spending cap (USD, 0 = none)</span>
                <input type="number" min={0} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} />
              </label>
              <label className="stack">
                <span>Turn limit (0 = none)</span>
                <input type="number" min={0} step={1} value={turns} onChange={(e) => setTurns(e.target.value)} />
              </label>
            </div>
            {permission === "full" && (
              <p className="warn small">Full access lets the pilot run any command as you. Use it only for work you would run yourself without review.</p>
            )}
            {defaults && <p className="muted small">Defaults come from Settings → Pilots.</p>}
          </details>
          <label className="check">
            <input type="checkbox" checked={addCard} onChange={(e) => setAddCard(e.target.checked)} />
            Add a pilot card to the board
          </label>
          {uncommitted > 0 && (
            <p className="warn small">
              {uncommitted} uncommitted change{uncommitted === 1 ? "" : "s"} in this repo will not be in the pilot's copy, which starts from the last commit.
              The board itself is sent with the instructions.
            </p>
          )}
          {error && <div className="error">{error}</div>}
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={busy || !instructions.trim()}>
              {busy ? "Starting…" : "Run pilot"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
