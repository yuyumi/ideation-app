import { useState } from "react";
import type { BoardOp } from "../board/proposals";
import type { ProposalState } from "../types";

interface Props {
  proposal: ProposalState;
  previewing: boolean;
  busy: boolean;
  /** Display name for a shape id (existing alias like s3, or new id like n1). */
  nameOf: (id: string) => string;
  onTogglePreview: () => void;
  onAccept: (selected: Set<number>) => void;
  onReject: () => void;
}

function describe(op: BoardOp, nameOf: (id: string) => string): string {
  if (op.op === "delete") return `Delete ${nameOf(op.id)}`;
  if (op.op === "update") {
    const parts: string[] = [];
    if (op.text !== undefined) parts.push(`text to "${op.text}"`);
    if (op.x !== undefined || op.y !== undefined) parts.push("position");
    if (op.width !== undefined || op.height !== undefined) parts.push("size");
    if (op.stroke) parts.push(`outline ${op.stroke}`);
    if (op.fill) parts.push(`fill ${op.fill}`);
    return `Change ${nameOf(op.id)}: ${parts.join(", ")}`;
  }
  if (op.type === "arrow") return `Connect ${nameOf(op.from)} → ${nameOf(op.to)}${op.text ? ` ("${op.text}")` : ""}`;
  return `Add ${op.type}${op.text ? ` "${op.text}"` : ""}`;
}

const STATUS_LABEL = { accepted: "Accepted", partial: "Partly accepted", rejected: "Rejected", pending: "" };

export default function ProposalCard({ proposal, previewing, busy, nameOf, onTogglePreview, onAccept, onReject }: Props) {
  const [selected, setSelected] = useState(() => new Set(proposal.ops.map((_, i) => i)));
  const pending = proposal.status === "pending";
  const toggle = (i: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className={`proposal ${proposal.status}`}>
      <div className="proposal-head">
        <strong>{proposal.summary || "Suggested board edits"}</strong>
        {!pending && <span className="badge">{STATUS_LABEL[proposal.status]}</span>}
      </div>
      {proposal.ops.length > 0 && (
        <ul className="ops">
          {proposal.ops.map((op, i) => (
            <li key={i}>
              <label>
                <input type="checkbox" checked={selected.has(i)} disabled={!pending || busy} onChange={() => toggle(i)} />
                <span>{describe(op, nameOf)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {proposal.dropped.length > 0 && (
        <details className="dropped">
          <summary>{proposal.dropped.length} edit{proposal.dropped.length === 1 ? "" : "s"} could not be used</summary>
          <ul>
            {proposal.dropped.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </details>
      )}
      {proposal.notes && proposal.notes.length > 0 && (
        <ul className="notes">
          {proposal.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {pending && proposal.ops.length > 0 && (
        <div className="proposal-actions">
          <button className="small" onClick={onTogglePreview} disabled={busy}>
            {previewing ? "Hide preview" : "Preview"}
          </button>
          <span className="grow" />
          <button className="small ghost" onClick={onReject} disabled={busy}>Reject</button>
          <button className="small primary" onClick={() => onAccept(selected)} disabled={busy || selected.size === 0}>
            {selected.size === proposal.ops.length ? "Accept" : `Accept ${selected.size}`}
          </button>
        </div>
      )}
    </div>
  );
}
