import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import type { BoardInfo, Environment, RecentBoard } from "../types";
import SettingsButton from "../settings/SettingsButton";

const LAST_PARENT_KEY = "ideation.lastParentDir";

function readLastParent(): string {
  try {
    return localStorage.getItem(LAST_PARENT_KEY) ?? "";
  } catch {
    return "";
  }
}

function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(iso).toLocaleDateString();
}

export default function BoardPicker({ onOpen, onOpenSettings }: { onOpen: (b: BoardInfo) => void; onOpenSettings: () => void }) {
  const [env, setEnv] = useState<Environment | null>(null);
  const [recent, setRecent] = useState<RecentBoard[]>([]);
  const [name, setName] = useState("");
  const [parent, setParent] = useState(readLastParent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.listRecentBoards().then(setRecent).catch((e) => setError(errorText(e)));

  useEffect(() => {
    api.checkEnvironment().then(setEnv);
    refresh();
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseParent = async () => {
    const dir = await open({ directory: true, title: "Folder to create the board in", defaultPath: parent || undefined });
    if (typeof dir === "string") setParent(dir);
  };

  const create = () =>
    run(async () => {
      const board = await api.createBoard(parent, name);
      try {
        localStorage.setItem(LAST_PARENT_KEY, parent);
      } catch {
        /* storage unavailable; not important */
      }
      onOpen(board);
    });

  const openFolder = () =>
    run(async () => {
      const dir = await open({ directory: true, title: "Open a board folder" });
      if (typeof dir === "string") onOpen(await api.openBoard(dir));
    });

  const openRecent = (path: string) => run(async () => onOpen(await api.openBoard(path)));

  const forget = (path: string) => run(async () => {
    await api.forgetBoard(path);
    await refresh();
  });

  const gitMissing = env !== null && !env.git;
  const canCreate = !busy && !gitMissing && name.trim() !== "" && parent !== "";

  return (
    <div className="home">
      <header className="home-header">
        <div>
          <h1>Ideation</h1>
          <p className="muted">Each board is its own git repo. Pilots run Claude Code against it.</p>
        </div>
        <SettingsButton onClick={onOpenSettings} />
      </header>

      {env && (
        <div className="env">
          <span className={env.git ? "ok" : "bad"}>{env.git ?? "Git not found. Install Git for Windows; boards need it."}</span>
          <span className={env.claude ? "ok" : "warn"}>
            {env.claude
              ? `Claude Code ${env.claude}`
              : "Claude Code not found. Boards work without it; chat and pilots need it."}
          </span>
        </div>
      )}

      {error && <div className="error" role="alert">{error}</div>}

      <section className="card">
        <h2>New board</h2>
        <div className="row">
          <input
            placeholder="Board name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canCreate && create()}
            autoFocus
          />
        </div>
        <div className="row">
          <input className="grow" readOnly placeholder="Parent folder" value={parent} onClick={chooseParent} />
          <button onClick={chooseParent} disabled={busy}>Choose…</button>
        </div>
        {name.trim() && parent && <p className="muted small">Creates a new repo at {parent}\{name.trim()}</p>}
        <div className="row">
          <button className="primary" onClick={create} disabled={!canCreate}>Create board</button>
          <button onClick={openFolder} disabled={busy}>Open board folder…</button>
        </div>
      </section>

      <section className="card">
        <h2>Recent boards</h2>
        {recent.length === 0 ? (
          <p className="muted">No boards yet.</p>
        ) : (
          <ul className="recent">
            {recent.map((b) => (
              <li key={b.path} className={b.exists ? "" : "missing"}>
                <button className="link" disabled={!b.exists || busy} onClick={() => openRecent(b.path)}>
                  <strong>{b.name}</strong>
                  <span className="muted small">{b.path}</span>
                </button>
                <span className="muted small">{b.exists ? relativeTime(b.lastOpened) : "folder missing"}</span>
                <button className="ghost small" title="Remove from this list. Files are not touched." onClick={() => forget(b.path)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
