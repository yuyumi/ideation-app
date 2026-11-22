import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { FileChange } from "../types";

/** Files a pilot changed since it started, with a diff per file. */
export default function DiffView({ boardPath, id, refreshKey }: { boardPath: string; id: string; refreshKey: string }) {
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api.pilotChanges(boardPath, id).then(setFiles).catch((e) => setError(errorText(e)));
  }, [boardPath, id, refreshKey]);

  useEffect(() => {
    if (!open) return;
    setDiff("Loading…");
    api.pilotFileDiff(boardPath, id, open).then(setDiff).catch((e) => setDiff(errorText(e)));
  }, [boardPath, id, open, refreshKey]);

  if (error) return <p className="muted small pad">{error}</p>;
  if (!files) return <p className="muted small pad">Loading…</p>;
  if (files.length === 0) return <p className="muted small pad">No changes yet.</p>;

  const total = files.reduce((a, f) => ({ add: a.add + (f.added ?? 0), del: a.del + (f.removed ?? 0) }), { add: 0, del: 0 });
  return (
    <div className="diffview">
      <p className="muted small">
        {files.length} file{files.length === 1 ? "" : "s"} · <span className="plus">+{total.add}</span> <span className="minus">−{total.del}</span>
      </p>
      <ul className="filelist">
        {files.map((f) => (
          <li key={f.path} className={open === f.path ? "on" : ""}>
            <button className="link" onClick={() => setOpen(open === f.path ? null : f.path)}>
              <span className={`fstatus ${f.status}`}>{f.status[0].toUpperCase()}</span>
              <code className="ellipsis">{f.path}</code>
              <span className="grow" />
              {f.added != null && <span className="plus small">+{f.added}</span>}
              {f.removed != null && <span className="minus small">−{f.removed}</span>}
            </button>
            {open === f.path && (
              <pre className="diff">
                {diff.split("\n").map((l, i) => (
                  <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
                    {l || " "}
                  </div>
                ))}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
