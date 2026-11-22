import { useCallback, useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { listen } from "@tauri-apps/api/event";
import { api, errorText } from "../api";
import { updatePilotCard } from "../board/pilotCards";
import type { PilotEvent, PilotMeta, PilotStatus } from "../types";
import PilotView from "./PilotView";
import { STATUS_LABEL, fmtAgo, fmtCost } from "./format";

interface Props {
  boardPath: string;
  getApi: () => ExcalidrawImperativeAPI | null;
  /** Pilot to open, e.g. from a card click; the nonce makes repeat clicks work. */
  openRequest: { id: string; nonce: number; meta?: PilotMeta } | null;
  onNewPilot: () => void;
}

const CLEANABLE: PilotStatus[] = ["failed", "cancelled", "interrupted", "succeeded"];

export default function PilotsPanel({ boardPath, getApi, openRequest, onNewPilot }: Props) {
  const [pilots, setPilots] = useState<PilotMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [cleanup, setCleanup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => api.pilotsList(boardPath).then(setPilots).catch((e) => setError(errorText(e))), [boardPath]);

  const upsert = useCallback((m: PilotMeta) => {
    setPilots((list) => {
      const i = list.findIndex((p) => p.id === m.id);
      if (i < 0) return [m, ...list];
      const next = [...list];
      next[i] = m;
      return next;
    });
    const ex = getApi();
    if (ex) updatePilotCard(ex, m);
  }, [getApi]);

  useEffect(() => {
    refresh();
    const off = listen<PilotEvent>("pilot-event", (e) => {
      if (e.payload.boardPath === boardPath && e.payload.meta) upsert(e.payload.meta);
    });
    return () => {
      off.then((f) => f());
    };
  }, [boardPath, refresh, upsert]);

  useEffect(() => {
    if (!openRequest) return;
    // A just-started pilot may not have reached the list yet.
    if (openRequest.meta) upsert(openRequest.meta);
    else refresh();
    setSelected(openRequest.id);
  }, [openRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = pilots.find((p) => p.id === selected);
  if (selected && current) {
    return (
      <PilotView
        key={current.id}
        boardPath={boardPath}
        meta={current}
        getApi={getApi}
        onBack={() => setSelected(null)}
        onChanged={upsert}
        onDeleted={(id) => {
          setPilots((l) => l.filter((p) => p.id !== id));
          setSelected(null);
        }}
      />
    );
  }

  const running = pilots.filter((p) => p.status === "running").length;
  const queued = pilots.filter((p) => p.status === "queued").length;
  return (
    <div className="pilots">
      <div className="chat-head">
        <strong className="grow">
          Pilots
          {(running > 0 || queued > 0) && (
            <span className="muted small"> · {running} running{queued > 0 ? `, ${queued} queued` : ""}</span>
          )}
        </strong>
        <button className="small" onClick={() => setCleanup(true)} disabled={pilots.length === 0}>Clean up…</button>
        <button className="small primary" onClick={onNewPilot}>New pilot</button>
      </div>
      {error && <div className="error small chat-error">{error}</div>}
      {selected && !current && <p className="muted small pad">That pilot no longer exists.</p>}
      {pilots.length === 0 ? (
        <div className="empty muted pad">
          <p>No pilots yet.</p>
          <p className="small">Select shapes on the board and click Run pilot. Each pilot works in its own branch and reports back here.</p>
        </div>
      ) : (
        <ul className="pilot-list">
          {pilots.map((p) => (
            <li key={p.id}>
              <button className="link" onClick={() => setSelected(p.id)}>
                <span className="row center">
                  <span className={`dot ${p.status}`} />
                  <strong className="ellipsis grow">{p.title}</strong>
                  {p.pinned && <span className="muted small" title="Pinned">📌</span>}
                </span>
                <span className="muted small">
                  {STATUS_LABEL[p.status]} · {fmtAgo(p.createdAt)} · {fmtCost(p.costUsd)}
                  {p.runs > 1 && ` · ${p.runs} runs`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {cleanup && (
        <CleanupDialog
          boardPath={boardPath}
          pilots={pilots}
          onClose={() => setCleanup(false)}
          onDone={() => {
            setCleanup(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function CleanupDialog({ boardPath, pilots, onClose, onDone }: { boardPath: string; pilots: PilotMeta[]; onClose: () => void; onDone: () => void }) {
  const [statuses, setStatuses] = useState<Set<PilotStatus>>(new Set(["failed", "cancelled", "interrupted"]));
  const [olderThan, setOlderThan] = useState("0");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

  const days = Math.max(0, Number(olderThan) || 0);
  const cutoff = Date.now() - days * 86_400_000;
  const targets = pilots.filter((p) => statuses.has(p.status) && !p.pinned && new Date(p.createdAt).getTime() <= cutoff);
  const pinnedSkipped = pilots.filter((p) => statuses.has(p.status) && p.pinned).length;

  const toggle = (s: PilotStatus) =>
    setStatuses((cur) => {
      const n = new Set(cur);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });

  const go = async () => {
    setBusy(true);
    const errs: string[] = [];
    for (const [i, p] of targets.entries()) {
      setProgress(`Deleting ${i + 1} of ${targets.length}: ${p.title}`);
      try {
        await api.pilotDelete(boardPath, p.id);
      } catch (e) {
        errs.push(`${p.title}: ${errorText(e)}`);
      }
    }
    setBusy(false);
    setProgress(null);
    if (errs.length) setFailures(errs);
    else onDone();
  };

  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div className="modal" role="dialog" aria-label="Clean up pilots" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Clean up pilots</h2>
        <p className="muted small">Deletes each matching pilot's folder, branch and logs. Running, queued and pinned pilots are never deleted.</p>
        <fieldset>
          <legend>Status</legend>
          {CLEANABLE.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={statuses.has(s)} onChange={() => toggle(s)} />
              {STATUS_LABEL[s]} ({pilots.filter((p) => p.status === s).length})
            </label>
          ))}
        </fieldset>
        <label className="grid">
          <span>Older than</span>
          <input type="number" min={0} step={1} value={olderThan} onChange={(e) => setOlderThan(e.target.value)} />
          <span className="muted small">days (0 = any age)</span>
        </label>
        <p className="small">
          <strong>{targets.length}</strong> pilot{targets.length === 1 ? "" : "s"} will be deleted.
          {pinnedSkipped > 0 && <span className="muted"> {pinnedSkipped} pinned skipped.</span>}
        </p>
        {targets.some((p) => p.resultCommit) && (
          <p className="warn small">Branches that were never pushed are deleted with their commits. Push any you want to keep first.</p>
        )}
        {progress && <p className="muted small">{progress}</p>}
        {failures.length > 0 && (
          <div className="error small">
            {failures.map((f, i) => (
              <div key={i}>{f}</div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={failures.length ? onDone : onClose} disabled={busy}>{failures.length ? "Close" : "Cancel"}</button>
          <button className="danger" onClick={go} disabled={busy || targets.length === 0 || failures.length > 0}>
            {busy ? "Deleting…" : `Delete ${targets.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
