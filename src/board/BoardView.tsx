import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { api, errorText } from "../api";
import { beforeClose } from "../closeGuard";
import type { BoardInfo, PilotMeta } from "../types";
import SettingsButton from "../settings/SettingsButton";
import GitHubMenu from "../github/GitHubMenu";
import Sidebar from "./Sidebar";
import NewPilotDialog from "../pilots/NewPilotDialog";
import { pilotIdFromLink } from "./pilotCards";
import { isGhost } from "./serialize";

const SAVE_DELAY_MS = 600;
const SIDEBAR_KEY = "ideation.sidebarOpen";

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

type SaveState = "saved" | "dirty" | "saving" | "error";

/** Cheap change detector; onChange also fires on pointer moves and scrolls. */
function fingerprint(elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles): string {
  let versions = 0;
  for (const el of elements) versions += el.version;
  return `${elements.length}:${versions}:${appState.viewBackgroundColor}:${Object.keys(files).length}`;
}

export default function BoardView({
  board,
  onClose,
  onOpenSettings,
}: {
  board: BoardInfo;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const [gitRefresh, setGitRefresh] = useState(0);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [newPilot, setNewPilot] = useState(false);
  const [pilotRequest, setPilotRequest] = useState<{ id: string; nonce: number; meta?: PilotMeta } | null>(null);
  const openPilot = useCallback((id: string, meta?: PilotMeta) => {
    setSidebarOpen(true);
    setPilotRequest({ id, nonce: Date.now(), meta });
  }, []);
  const getApi = useCallback(() => apiRef.current, []);

  const lastPrint = useRef<string | null>(null);
  const pending = useRef<string | null>(null); // serialized scene awaiting save
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api
      .loadScene(board.path)
      .then((raw) => {
        const data = JSON.parse(raw);
        setInitial({ elements: data.elements ?? [], appState: data.appState ?? {}, files: data.files ?? {}, scrollToContent: true });
      })
      .catch((e) => setLoadError(errorText(e)));
  }, [board.path]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const scene = pending.current;
    if (scene === null) return;
    pending.current = null;
    setSaveState("saving");
    try {
      await api.saveScene(board.path, scene);
      setSaveState(pending.current === null ? "saved" : "dirty");
      setSaveError(null);
    } catch (e) {
      pending.current ??= scene; // keep it so the next flush retries
      setSaveState("error");
      setSaveError(errorText(e));
    }
  }, [board.path]);

  // Save any pending edit before the window closes.
  useEffect(() => beforeClose(flush), [flush]);

  const onChange = (allElements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    // Preview ghosts from chat suggestions are never saved.
    const elements = allElements.some(isGhost) ? allElements.filter((e) => !isGhost(e)) : allElements;
    const print = fingerprint(elements, appState, files);
    if (lastPrint.current === null) {
      lastPrint.current = print; // first change is the initial load
      return;
    }
    if (print === lastPrint.current) return;
    lastPrint.current = print;
    pending.current = serializeAsJSON(elements, appState, files, "local");
    setSaveState("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  };

  const close = async () => {
    await flush();
    onClose();
  };

  const commit = async () => {
    const message = commitMsg ?? "";
    setCommitMsg(null);
    await flush();
    try {
      const made = await api.commitBoard(board.path, message);
      setNotice(made ? "Board committed" : "Nothing new to commit");
      setGitRefresh((n) => n + 1);
    } catch (e) {
      setNotice(errorText(e));
    }
    window.setTimeout(() => setNotice(null), 3000);
  };

  const statusLabel: Record<SaveState, string> = {
    saved: "Saved",
    dirty: "Unsaved",
    saving: "Saving…",
    error: "Save failed",
  };

  return (
    <div className="board">
      <header className="topbar">
        <button className="ghost" onClick={close} title="Back to boards">←</button>
        <div className="title">
          <strong>{board.name}</strong>
          <span className="muted small">{board.path}</span>
        </div>
        <span className={`status ${saveState}`} title={saveError ?? undefined}>{statusLabel[saveState]}</span>
        {notice && <span className="notice small">{notice}</span>}
        {commitMsg === null ? (
          <button onClick={() => setCommitMsg("")}>Commit board</button>
        ) : (
          <form
            className="commit-form"
            onSubmit={(e) => {
              e.preventDefault();
              commit();
            }}
          >
            <input autoFocus placeholder="Commit message (optional)" value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} />
            <button className="primary" type="submit">Commit</button>
            <button type="button" className="ghost" onClick={() => setCommitMsg(null)}>Cancel</button>
          </form>
        )}
        <button onClick={() => setNewPilot(true)} disabled={!initial} title="Launch Claude Code on this board in its own branch">
          Run pilot
        </button>
        <GitHubMenu boardPath={board.path} boardName={board.name} refreshKey={gitRefresh} />
        <button
          className={sidebarOpen ? "on" : ""}
          onClick={() => {
            const next = !sidebarOpen;
            setSidebarOpen(next);
            try {
              localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
            } catch {
              /* not important */
            }
          }}
          title="Show or hide the chat and pilots panel"
        >
          Claude
        </button>
        <SettingsButton onClick={onOpenSettings} />
      </header>
      <div className="board-body">
      <main className="canvas">
        {loadError ? (
          <div className="error">Could not load board: {loadError}</div>
        ) : initial ? (
          <Excalidraw
            excalidrawAPI={(a) => (apiRef.current = a)}
            onLinkOpen={(element, event) => {
              const id = pilotIdFromLink(element.link);
              if (id) {
                event.preventDefault();
                openPilot(id);
              }
            }}
            initialData={initial}
            onChange={onChange}
            UIOptions={{ canvasActions: { saveToActiveFile: false, loadScene: true } }}
          />
        ) : (
          <div className="muted pad">Loading…</div>
        )}
      </main>
      {initial && (
        <div className="sidebar-wrap" hidden={!sidebarOpen}>
          <Sidebar boardPath={board.path} getApi={getApi} pilotRequest={pilotRequest} onNewPilot={() => setNewPilot(true)} />
        </div>
      )}
      </div>
      {newPilot && (
        <NewPilotDialog boardPath={board.path} getApi={getApi} onClose={() => setNewPilot(false)} onStarted={(m) => openPilot(m.id, m)} />
      )}
    </div>
  );
}
