import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { FileContent, PilotFile } from "../types";

const fmtSize = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** Splits a CSV line, honoring double-quoted fields. */
function csvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function Preview({ path, content }: { path: string; content: FileContent }) {
  if (content.kind === "image" && content.dataUrl) return <img className="result-img" src={content.dataUrl} alt={path} />;
  if (content.kind !== "text" || content.text == null) return <p className="muted small">Binary file ({fmtSize(content.size)}). Open the folder to view it.</p>;
  const text = content.text;
  if (path.endsWith(".json")) {
    try {
      return <pre className="code">{JSON.stringify(JSON.parse(text), null, 2)}</pre>;
    } catch {
      /* fall through to plain text */
    }
  }
  if (path.endsWith(".csv")) {
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 201).map(csvRow);
    return (
      <div className="table-wrap">
        <table className="csv">
          <thead>
            <tr>{rows[0]?.map((h, i) => <th key={i}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(1).map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
        {text.split(/\r?\n/).length > 201 && <p className="muted small">Showing the first 200 rows.</p>}
      </div>
    );
  }
  return (
    <pre className="code">
      {text}
      {content.truncated && "\n… (truncated)"}
    </pre>
  );
}

/** Files under the pilot's results/ folder, with inline previews. */
export default function ResultsView({ boardPath, id, refreshKey }: { boardPath: string; id: string; refreshKey: string }) {
  const [files, setFiles] = useState<PilotFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .pilotResults(boardPath, id)
      .then((f) => {
        setFiles(f);
        // Open the first image or table automatically.
        setOpen((o) => o ?? f.find((x) => /\.(png|svg|jpe?g|gif|webp|csv|json)$/i.test(x.path))?.path ?? null);
      })
      .catch((e) => setError(errorText(e)));
  }, [boardPath, id, refreshKey]);

  useEffect(() => {
    if (!open) return setContent(null);
    setContent(null);
    api.pilotReadFile(boardPath, id, open).then(setContent).catch((e) => setError(errorText(e)));
  }, [boardPath, id, open, refreshKey]);

  if (error) return <p className="muted small pad">{error}</p>;
  if (!files) return <p className="muted small pad">Loading…</p>;
  if (files.length === 0) return <p className="muted small pad">No files in results/ yet.</p>;
  return (
    <div className="results">
      <ul className="filelist">
        {files.map((f) => (
          <li key={f.path} className={open === f.path ? "on" : ""}>
            <button className="link" onClick={() => setOpen(f.path)}>
              <code className="ellipsis">{f.path.replace(/^results\//, "")}</code>
              <span className="grow" />
              <span className="muted small">{fmtSize(f.size)}</span>
            </button>
          </li>
        ))}
      </ul>
      {open && <div className="preview">{content ? <Preview path={open} content={content} /> : <p className="muted small">Loading…</p>}</div>}
    </div>
  );
}
