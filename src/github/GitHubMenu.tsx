import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, errorText } from "../api";
import type { GhStatus, RemoteStatus } from "../types";

const INSTALL_CMD = "winget install --id GitHub.cli";

/** GitHub repo names: letters, digits, '-', '_' and '.'. */
export function repoSlug(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "board";
}

interface Props {
  boardPath: string;
  boardName: string;
  /** Bump to re-read local status, e.g. after a commit. */
  refreshKey: number;
}

export default function GitHubMenu({ boardPath, boardName, refreshKey }: Props) {
  const [open, setOpen] = useState(false);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [owners, setOwners] = useState<string[]>([]);
  const [form, setForm] = useState({ owner: "", name: repoSlug(boardName), isPrivate: true, description: "" });
  const wrapRef = useRef<HTMLDivElement>(null);

  const loadRemote = useCallback(() => api.repoRemoteStatus(boardPath).then(setRemote).catch((e) => setError(errorText(e))), [boardPath]);

  useEffect(() => {
    loadRemote();
  }, [loadRemote, refreshKey]);

  const loadGh = useCallback(async () => {
    const s = await api.githubStatus();
    setGh(s);
    if (s.user) {
      const list = await api.githubOwners().catch(() => [s.user!]);
      setOwners(list);
      setForm((f) => (f.owner ? f : { ...f, owner: list[0] ?? "" }));
    }
    return s;
  }, []);

  useEffect(() => {
    if (open) loadGh();
  }, [open, loadGh]);

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = async (label: string, fn: () => Promise<RemoteStatus | void>, done?: string) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const r = await fn();
      if (r) setRemote(r);
      if (done) setMessage(done);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const signIn = async () => {
    await run("signin", () => api.githubLogin());
    setMessage("Finish signing in in the console window that opened. This panel updates when you're done.");
    // Poll until signed in, for up to five minutes.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await api.githubStatus();
      if (s.user) {
        await loadGh();
        setMessage(`Signed in as ${s.user}.`);
        return;
      }
    }
  };

  const hasRemote = !!remote?.remoteUrl;
  const badge = !remote ? "" : !hasRemote ? "" : remote.ahead > 0 ? ` ↑${remote.ahead}` : remote.behind > 0 ? ` ↓${remote.behind}` : "";

  return (
    <div className="popover-wrap" ref={wrapRef}>
      <button onClick={() => setOpen((o) => !o)} title="GitHub">
        {hasRemote ? "GitHub" : "Publish to GitHub"}
        {badge && <span className="badge-inline">{badge}</span>}
      </button>
      {open && (
        <div className="popover">
          {!gh ? (
            <p className="muted">Checking GitHub CLI…</p>
          ) : !gh.installed ? (
            <>
              <h3>Install the GitHub CLI</h3>
              <p className="small">Ideation uses the open-source GitHub CLI to sign in and create repos. Install it from PowerShell, then reopen this panel:</p>
              <code className="block">{INSTALL_CMD}</code>
              <div className="row">
                <button className="small" onClick={() => navigator.clipboard.writeText(INSTALL_CMD)}>Copy command</button>
                <button className="small" onClick={loadGh}>Check again</button>
              </div>
            </>
          ) : !gh.user ? (
            <>
              <h3>Sign in to GitHub</h3>
              <p className="small">Opens a console window with GitHub's browser sign-in. Git is set up to use the same login for push and pull.</p>
              <button className="primary" onClick={signIn} disabled={!!busy}>Sign in to GitHub</button>
            </>
          ) : !hasRemote ? (
            <>
              <h3>Publish this board</h3>
              <p className="muted small">Creates a GitHub repo, adds it as origin and pushes your commits. Signed in as {gh.user}.</p>
              {remote && remote.uncommitted > 0 && (
                <p className="warn small">{remote.uncommitted} uncommitted change{remote.uncommitted === 1 ? "" : "s"} will not be published. Commit first to include them.</p>
              )}
              <label className="field">
                <span>Owner</span>
                <select value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })}>
                  {owners.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Name</span>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <label className="field">
                <span>Description</span>
                <input value={form.description} placeholder="Optional" onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
              <label className="check">
                <input type="checkbox" checked={form.isPrivate} onChange={(e) => setForm({ ...form, isPrivate: e.target.checked })} />
                Private repository
              </label>
              <button
                className="primary"
                disabled={!!busy || !form.owner || !form.name.trim()}
                onClick={() =>
                  run(
                    "publish",
                    () => api.repoPublish(boardPath, form.owner, form.name.trim(), form.isPrivate, form.description),
                    `Published to github.com/${form.owner}/${form.name.trim()}.`,
                  )
                }
              >
                {busy === "publish" ? "Publishing…" : "Publish to GitHub"}
              </button>
            </>
          ) : (
            <>
              <h3>GitHub</h3>
              {remote!.webUrl ? (
                <a href={remote!.webUrl} onClick={(e) => { e.preventDefault(); openUrl(remote!.webUrl!); }}>
                  {remote!.webUrl.replace("https://", "")}
                </a>
              ) : (
                <code className="small">{remote!.remoteUrl}</code>
              )}
              <dl className="status-grid small">
                <dt>Branch</dt>
                <dd>{remote!.branch ?? "?"}{remote!.upstream ? ` → ${remote!.upstream}` : " (not pushed yet)"}</dd>
                <dt>To push</dt>
                <dd>{remote!.ahead} commit{remote!.ahead === 1 ? "" : "s"}</dd>
                <dt>To pull</dt>
                <dd>{remote!.behind} commit{remote!.behind === 1 ? "" : "s"}</dd>
                <dt>Uncommitted</dt>
                <dd>{remote!.uncommitted} file{remote!.uncommitted === 1 ? "" : "s"}</dd>
              </dl>
              <div className="row">
                <button className="small" disabled={!!busy} onClick={() => run("fetch", () => api.repoFetch(boardPath), "Up to date with GitHub.")}>
                  {busy === "fetch" ? "Checking…" : "Check for updates"}
                </button>
                <button className="small" disabled={!!busy || remote!.behind === 0} onClick={() => run("pull", () => api.repoPull(boardPath), "Pulled.")}>
                  {busy === "pull" ? "Pulling…" : "Pull"}
                </button>
                <button
                  className="small primary"
                  disabled={!!busy || (remote!.ahead === 0 && !!remote!.upstream)}
                  onClick={() => run("push", () => api.repoPush(boardPath), "Pushed.")}
                >
                  {busy === "push" ? "Pushing…" : "Push"}
                </button>
              </div>
              <p className="muted small">Signed in as {gh.user}.</p>
            </>
          )}
          {message && <p className="ok small">{message}</p>}
          {error && <div className="error small">{error}</div>}
        </div>
      )}
    </div>
  );
}

