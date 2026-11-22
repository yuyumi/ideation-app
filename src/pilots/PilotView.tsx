import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, errorText } from "../api";
import { buildPrompt, serializeBoard } from "../board/serialize";
import Markdown from "../chat/Markdown";
import type { Activity, DeleteInfo, PilotEvent, PilotMeta } from "../types";
import DiffView from "./DiffView";
import ResultsView from "./ResultsView";
import { STATUS_LABEL, fmtCost, fmtDuration, fmtTokens } from "./format";

type Tab = "activity" | "report" | "results" | "changes";

interface Props {
  boardPath: string;
  meta: PilotMeta;
  getApi: () => ExcalidrawImperativeAPI | null;
  onBack: () => void;
  onChanged: (meta: PilotMeta) => void;
  onDeleted: (id: string) => void;
}

export default function PilotView({ boardPath, meta, getApi, onBack, onChanged, onDeleted }: Props) {
  const active = meta.status === "queued" || meta.status === "running";
  const [tab, setTab] = useState<Tab>(meta.hasReport && !active ? "report" : "activity");
  const [activity, setActivity] = useState<Activity[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [withBoard, setWithBoard] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasRemote, setHasRemote] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DeleteInfo | null>(null);
  const feedEnd = useRef<HTMLDivElement>(null);
  // Re-read report, results and changes whenever a run finishes.
  const refreshKey = `${meta.status}-${meta.finishedAt ?? ""}-${meta.runs}`;

  useEffect(() => {
    let alive = true;
    api.pilotActivity(boardPath, meta.id).then((a) => alive && setActivity(a));
    const off = listen<PilotEvent>("pilot-event", (e) => {
      const ev = e.payload;
      if (ev.boardPath === boardPath && ev.id === meta.id && ev.activity) setActivity((a) => [...a, ev.activity!]);
    });
    return () => {
      alive = false;
      off.then((f) => f());
    };
  }, [boardPath, meta.id]);

  useEffect(() => {
    if (!meta.hasReport) return setReport(null);
    api.pilotReadFile(boardPath, meta.id, "PILOT_REPORT.md").then((c) => setReport(c.text)).catch(() => setReport(null));
  }, [boardPath, meta.id, meta.hasReport, refreshKey]);

  useEffect(() => {
    api.repoRemoteStatus(boardPath).then((r) => setHasRemote(!!r.remoteUrl)).catch(() => {});
  }, [boardPath]);

  useEffect(() => {
    if (tab === "activity") feedEnd.current?.scrollIntoView({ block: "end" });
  }, [activity.length, tab]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const sendFollowUp = () =>
    run("follow", async () => {
      let prompt = followUp.trim();
      const ex = getApi();
      if (withBoard && ex) prompt = buildPrompt(prompt, serializeBoard(ex.getSceneElementsIncludingDeleted(), null).board);
      const m = await api.pilotFollowUp(boardPath, meta.id, followUp.trim(), prompt);
      setFollowUp("");
      setTab("activity");
      onChanged(m);
    });

  const resume = () =>
    run("follow", async () => {
      const text = "The previous run was interrupted. Continue where you left off, then finish the report.";
      onChanged(await api.pilotFollowUp(boardPath, meta.id, text, text));
      setTab("activity");
    });

  const openFolder = () => run("open", async () => revealItemInDir(await api.pilotWorktreePath(boardPath, meta.id)));

  const askDelete = () => run("delete", async () => setConfirmDelete(await api.pilotDeleteInfo(boardPath, meta.id)));

  const doDelete = () =>
    run("delete", async () => {
      await api.pilotDelete(boardPath, meta.id);
      setConfirmDelete(null);
      onDeleted(meta.id);
    });

  const t = meta.tokens;
  return (
    <div className="pilot-view">
      <div className="chat-head">
        <button className="ghost small" onClick={onBack}>← Pilots</button>
        <strong className="grow ellipsis" title={meta.title}>{meta.title}</strong>
        <span className={`pstatus ${meta.status}`}>{STATUS_LABEL[meta.status]}</span>
      </div>

      <div className="pilot-meta small">
        <dl className="status-grid">
          <dt>Model</dt>
          <dd>{meta.modelUsed ?? (meta.model || "Claude Code default")}</dd>
          <dt>Mode</dt>
          <dd>{meta.permissionMode ?? meta.permission}</dd>
          <dt>Cost</dt>
          <dd>
            {fmtCost(meta.costUsd)}
            {meta.maxBudgetUsd > 0 && <span className="muted"> (cap ${meta.maxBudgetUsd} per run)</span>}
          </dd>
          <dt>Tokens</dt>
          <dd title={`Input ${t.input}, written to cache ${t.cacheWrite}, read from cache ${t.cacheRead}, output ${t.output}`}>
            {fmtTokens(t.input + t.cacheWrite + t.cacheRead)} in · {fmtTokens(t.output)} out
          </dd>
          <dt>Time</dt>
          <dd>
            {fmtDuration(meta.durationMs)} · {meta.runs} run{meta.runs === 1 ? "" : "s"}
          </dd>
          <dt>Branch</dt>
          <dd><code>{meta.branch}</code></dd>
        </dl>
        <div className="row wrap">
          {active && <button className="small" disabled={!!busy} onClick={() => run("stop", () => api.pilotCancel(boardPath, meta.id))}>Stop</button>}
          {meta.status === "interrupted" && meta.sessionId && <button className="small primary" disabled={!!busy} onClick={resume}>Resume</button>}
          {!active && !meta.sessionId && (
            <button
              className="small primary"
              disabled={!!busy}
              title="This pilot never got going; run it again from its original instructions"
              onClick={() => run("again", async () => onChanged(await api.pilotStartAgain(boardPath, meta.id)))}
            >
              Start again
            </button>
          )}
          <button className="small" disabled={!!busy || !meta.baseCommit} onClick={openFolder}>Open folder</button>
          {hasRemote && (
            <button className="small" disabled={!!busy || active || !meta.resultCommit} onClick={() => run("push", () => api.pilotPush(boardPath, meta.id))}>
              {busy === "push" ? "Pushing…" : "Push branch"}
            </button>
          )}
          <button className="small" disabled={!!busy} onClick={() => run("pin", async () => onChanged(await api.pilotSetPinned(boardPath, meta.id, !meta.pinned)))}>
            {meta.pinned ? "Unpin" : "Pin"}
          </button>
          <span className="grow" />
          <button className="small ghost danger-text" disabled={!!busy || meta.pinned} title={meta.pinned ? "Unpin to delete" : undefined} onClick={askDelete}>
            Delete…
          </button>
        </div>
        {confirmDelete && (
          <div className="confirm">
            <p className="small">
              <strong>Delete this pilot?</strong> This removes its folder <code>.pilots/{meta.id}</code>
              {confirmDelete.branchExists && <>, its branch <code>{meta.branch}</code></>} and its logs. It cannot be undone.
            </p>
            {confirmDelete.unsavedCommits > 0 && !confirmDelete.pushed && (
              <p className="warn small">
                The branch has {confirmDelete.unsavedCommits} commit{confirmDelete.unsavedCommits === 1 ? "" : "s"} that exist nowhere else. Push the branch first to keep them.
              </p>
            )}
            {confirmDelete.pushed && <p className="muted small">The branch stays on GitHub; only the local copy is deleted.</p>}
            <div className="row">
              <button className="small danger" disabled={!!busy} onClick={doDelete}>{busy === "delete" ? "Deleting…" : "Delete"}</button>
              <button className="small ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
            </div>
          </div>
        )}
        {meta.error && <div className="error small">{meta.error}</div>}
        {meta.denials.length > 0 && (
          <details className="dropped">
            <summary>{meta.denials.length} action{meta.denials.length === 1 ? " was" : "s were"} denied</summary>
            <ul>
              {meta.denials.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </details>
        )}
        {error && <div className="error small">{error}</div>}
      </div>

      <nav className="tabs sub">
        {(["activity", "report", "results", "changes"] as Tab[]).map((k) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </nav>

      <div className="pilot-body">
        {tab === "activity" && (
          <div className="feed">
            <div className="feed-item user">
              <div className="small muted">Instructions</div>
              <div className="pre">{meta.instructions}</div>
            </div>
            {activity.length === 0 && <p className="muted small">{meta.status === "queued" ? "Waiting for a free slot…" : "No activity yet."}</p>}
            {activity.map((a, i) => (
              <div key={i} className={`feed-item ${a.kind}`}>
                {a.kind === "tool" ? (
                  <div className="small">
                    <strong>{a.text}</strong> {a.detail && <code>{a.detail}</code>}
                  </div>
                ) : a.kind === "text" ? (
                  <Markdown text={a.text} />
                ) : (
                  <div className="small">
                    {a.text}
                    {a.detail && <div className="pre muted">{a.detail}</div>}
                  </div>
                )}
              </div>
            ))}
            {meta.status === "running" && <div className="muted small typing">Working…</div>}
            <div ref={feedEnd} />
          </div>
        )}
        {tab === "report" &&
          (report ? (
            <div className="report">
              <Markdown text={report} />
            </div>
          ) : (
            <p className="muted small pad">{active ? "The report appears when the pilot finishes." : "This pilot did not write PILOT_REPORT.md."}</p>
          ))}
        {tab === "results" && <ResultsView boardPath={boardPath} id={meta.id} refreshKey={refreshKey} />}
        {tab === "changes" && <DiffView boardPath={boardPath} id={meta.id} refreshKey={refreshKey} />}
      </div>

      {!active && meta.sessionId && (
        <div className="composer">
          <textarea
            rows={2}
            placeholder="Follow-up instructions for this pilot (continues the same session)"
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && followUp.trim()) {
                e.preventDefault();
                sendFollowUp();
              }
            }}
          />
          <div className="row center">
            <label className="check small">
              <input type="checkbox" checked={withBoard} onChange={(e) => setWithBoard(e.target.checked)} />
              Include the current board
            </label>
            <span className="grow" />
            <button className="primary small" disabled={!followUp.trim() || !!busy} onClick={sendFollowUp}>Run follow-up</button>
          </div>
        </div>
      )}
    </div>
  );
}
