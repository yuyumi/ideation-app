// Parsing and validating the board edits Claude proposes in a ```board-ops
// block. Nothing here touches the canvas; see applyOps.ts for that.

import type { AliasMap } from "./serialize";

export type ShapeType = "rectangle" | "ellipse" | "diamond" | "text";

export interface CreateShapeOp {
  op: "create";
  id: string;
  type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  stroke?: string;
  fill?: string;
}

export interface CreateArrowOp {
  op: "create";
  id: string;
  type: "arrow";
  from: string;
  to: string;
  text?: string;
  stroke?: string;
}

export interface UpdateOp {
  op: "update";
  id: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
}

export interface DeleteOp {
  op: "delete";
  id: string;
}

export type BoardOp = CreateShapeOp | CreateArrowOp | UpdateOp | DeleteOp;

export interface Proposal {
  summary: string;
  ops: BoardOp[];
  /** Human-readable reasons for ops that were rejected during validation. */
  dropped: string[];
}

const SHAPE_TYPES: ShapeType[] = ["rectangle", "ellipse", "diamond", "text"];
const MAX_OPS = 200;
const MAX_TEXT = 2000;
const MAX_COORD = 1_000_000;
const MAX_SIZE = 10_000;
const DEFAULT_W = 180;
const DEFAULT_H = 80;
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent)$/;
const NEW_ID = /^n\d{1,4}$/;

const FENCE = /```board-ops[ \t]*\r?\n([\s\S]*?)```/g;

/** Splits a reply into prose and the last board-ops block, if any. */
export function splitReply(text: string): { prose: string; block: string | null } {
  const matches = [...text.matchAll(FENCE)];
  if (matches.length === 0) return { prose: text.trim(), block: null };
  const last = matches[matches.length - 1];
  const prose = text.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { prose, block: last[1] };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const inCoord = (v: number) => Math.abs(v) <= MAX_COORD;
const inSize = (v: number) => v > 0 && v <= MAX_SIZE;

function optString(o: Record<string, unknown>, key: string, problems: string[]): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    problems.push(`${key} must be text`);
    return undefined;
  }
  if (v.length > MAX_TEXT) {
    problems.push(`${key} is longer than ${MAX_TEXT} characters`);
    return undefined;
  }
  return v;
}

function optColor(o: Record<string, unknown>, key: "stroke" | "fill", problems: string[]): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !COLOR.test(v)) {
    problems.push(`${key} must be a hex color or "transparent"`);
    return undefined;
  }
  return v;
}

/**
 * Validates raw ops against the aliases the board was sent with. Invalid ops
 * are dropped with a reason; valid ones are returned in their original order.
 */
export function validateProposal(raw: unknown, aliases: AliasMap): Proposal {
  const dropped: string[] = [];
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { ops?: unknown }).ops)) {
    return { summary: "", ops: [], dropped: ["The edit block has no \"ops\" list."] };
  }
  const summaryRaw = (raw as { summary?: unknown }).summary;
  const summary = typeof summaryRaw === "string" ? summaryRaw.slice(0, 300) : "";
  let rawOps = (raw as { ops: unknown[] }).ops;
  if (rawOps.length > MAX_OPS) {
    dropped.push(`Only the first ${MAX_OPS} of ${rawOps.length} edits were kept.`);
    rawOps = rawOps.slice(0, MAX_OPS);
  }

  const existing = (id: unknown): id is string => typeof id === "string" && Object.prototype.hasOwnProperty.call(aliases, id);

  // First pass: which new shape ids exist, so arrows can point at them.
  const newShapeIds = new Set<string>();
  const seenNew = new Set<string>();
  for (const o of rawOps) {
    const op = o as Record<string, unknown>;
    if (op?.op === "create" && typeof op.id === "string" && NEW_ID.test(op.id) && SHAPE_TYPES.includes(op.type as ShapeType)) {
      newShapeIds.add(op.id);
    }
  }

  const ops: BoardOp[] = [];
  const touched = new Map<string, "update" | "delete">();

  rawOps.forEach((o, i) => {
    const n = i + 1;
    if (typeof o !== "object" || o === null) {
      dropped.push(`Edit ${n}: not an object.`);
      return;
    }
    const op = o as Record<string, unknown>;
    const problems: string[] = [];
    const label = `Edit ${n} (${String(op.op ?? "?")} ${String(op.id ?? "?")})`;

    if (op.op === "create") {
      if (typeof op.id !== "string" || !NEW_ID.test(op.id)) problems.push("new ids must look like n1, n2, ...");
      else if (seenNew.has(op.id)) problems.push(`id ${op.id} is used twice`);
      const text = optString(op, "text", problems);
      const stroke = optColor(op, "stroke", problems);

      if (op.type === "arrow") {
        const ref = (v: unknown) => existing(v) || (typeof v === "string" && newShapeIds.has(v));
        if (!ref(op.from)) problems.push(`"from" must be an existing or new shape id, got ${JSON.stringify(op.from)}`);
        if (!ref(op.to)) problems.push(`"to" must be an existing or new shape id, got ${JSON.stringify(op.to)}`);
        if (op.from === op.to) problems.push("an arrow cannot connect a shape to itself");
        if (problems.length === 0) {
          seenNew.add(op.id as string);
          ops.push({ op: "create", id: op.id as string, type: "arrow", from: op.from as string, to: op.to as string, text, stroke });
        }
      } else if (SHAPE_TYPES.includes(op.type as ShapeType)) {
        if (!isNum(op.x) || !isNum(op.y) || !inCoord(op.x) || !inCoord(op.y)) problems.push("x and y must be numbers");
        const width = op.width === undefined ? DEFAULT_W : op.width;
        const height = op.height === undefined ? DEFAULT_H : op.height;
        if (!isNum(width) || !isNum(height) || !inSize(width) || !inSize(height)) problems.push(`width and height must be between 0 and ${MAX_SIZE}`);
        if (op.type === "text" && !text) problems.push("text shapes need text");
        const fill = optColor(op, "fill", problems);
        if (problems.length === 0) {
          seenNew.add(op.id as string);
          ops.push({
            op: "create",
            id: op.id as string,
            type: op.type as ShapeType,
            x: op.x as number,
            y: op.y as number,
            width: width as number,
            height: height as number,
            text,
            stroke,
            fill,
          });
        }
      } else {
        problems.push(`type must be one of ${[...SHAPE_TYPES, "arrow"].join(", ")}`);
      }
    } else if (op.op === "update") {
      if (!existing(op.id)) problems.push("id is not a shape on the board");
      else if (touched.has(op.id)) problems.push(`${op.id} is already ${touched.get(op.id)}d by an earlier edit`);
      const upd: UpdateOp = { op: "update", id: op.id as string };
      const text = optString(op, "text", problems);
      if (text !== undefined) upd.text = text;
      for (const k of ["x", "y"] as const) {
        if (op[k] === undefined) continue;
        if (isNum(op[k]) && inCoord(op[k] as number)) upd[k] = op[k] as number;
        else problems.push(`${k} must be a number`);
      }
      for (const k of ["width", "height"] as const) {
        if (op[k] === undefined) continue;
        if (isNum(op[k]) && inSize(op[k] as number)) upd[k] = op[k] as number;
        else problems.push(`${k} must be between 0 and ${MAX_SIZE}`);
      }
      const stroke = optColor(op, "stroke", problems);
      const fill = optColor(op, "fill", problems);
      if (stroke !== undefined) upd.stroke = stroke;
      if (fill !== undefined) upd.fill = fill;
      if (problems.length === 0 && Object.keys(upd).length <= 2) problems.push("no fields to change");
      if (problems.length === 0) {
        touched.set(upd.id, "update");
        ops.push(upd);
      }
    } else if (op.op === "delete") {
      if (!existing(op.id)) problems.push("id is not a shape on the board");
      else if (touched.has(op.id)) problems.push(`${op.id} is already ${touched.get(op.id)}d by an earlier edit`);
      if (problems.length === 0) {
        touched.set(op.id as string, "delete");
        ops.push({ op: "delete", id: op.id as string });
      }
    } else {
      problems.push(`op must be create, update or delete`);
    }

    if (problems.length > 0) dropped.push(`${label}: ${problems.join("; ")}.`);
  });

  // Arrows into shapes deleted by this same proposal make no sense.
  const deleted = new Set(ops.filter((o): o is DeleteOp => o.op === "delete").map((o) => o.id));
  const kept = ops.filter((o) => {
    if (o.op === "create" && o.type === "arrow" && (deleted.has(o.from) || deleted.has(o.to))) {
      dropped.push(`Arrow ${o.id} connects to a shape this proposal deletes.`);
      return false;
    }
    return true;
  });

  return { summary, ops: kept, dropped };
}

/** Parses and validates the JSON inside a board-ops block. */
export function parseProposal(block: string, aliases: AliasMap): Proposal {
  let raw: unknown;
  try {
    raw = JSON.parse(block);
  } catch (e) {
    return { summary: "", ops: [], dropped: [`The edit block is not valid JSON (${(e as Error).message}).`] };
  }
  return validateProposal(raw, aliases);
}

/**
 * Indices of ops that can be applied when only `selected` are accepted:
 * arrows whose endpoint is a new shape that was not accepted are skipped.
 */
export function resolveSelection(ops: BoardOp[], selected: Set<number>): { apply: number[]; skipped: string[] } {
  const acceptedNew = new Set(
    ops.filter((o, i) => selected.has(i) && o.op === "create" && o.type !== "arrow").map((o) => o.id),
  );
  const apply: number[] = [];
  const skipped: string[] = [];
  ops.forEach((o, i) => {
    if (!selected.has(i)) return;
    if (o.op === "create" && o.type === "arrow") {
      const missing = [o.from, o.to].filter((ref) => /^n\d+$/.test(ref) && !acceptedNew.has(ref));
      if (missing.length > 0) {
        skipped.push(`Arrow ${o.id} skipped: it connects to ${missing.join(" and ")}, which was not accepted.`);
        return;
      }
    }
    apply.push(i);
  });
  return { apply, skipped };
}
