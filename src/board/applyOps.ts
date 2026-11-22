// Turns validated board ops into Excalidraw elements, either as a locked,
// translucent preview ("ghosts") or as real edits. Planning is pure: it takes
// the scene and returns a new scene, so it can be tested without a canvas.

import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith, ROUNDNESS } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { arrowBetween, center, edgePoint, type Box, type Point } from "./geometry";
import type { BoardOp, CreateArrowOp, CreateShapeOp, DeleteOp, UpdateOp } from "./proposals";
import { GHOST_KEY, type AliasMap } from "./serialize";

const NUNITO = 6;
const DEFAULT_STROKE = "#1e1e1e";
const GHOST_OPACITY = 45;
const ARROW_GAP = 6;

// Excalidraw elements are readonly; this loose type is for building new ones.
type El = ExcalidrawElement;
type AnyEl = El & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type BoundRef = { id: string; type: "arrow" | "text" };

export type Mode = "ghost" | "apply";

export interface PlanResult {
  /** The full new scene (apply) or just the ghost elements (ghost). */
  elements: El[];
  notes: string[];
}

const boxOf = (e: El): Box => ({ x: e.x, y: e.y, width: e.width, height: e.height, type: e.type });

const convert = (skeletons: unknown[]): AnyEl[] =>
  convertToExcalidrawElements(skeletons as ExcalidrawElementSkeleton[], { regenerateIds: false }) as AnyEl[];

function roundnessFor(type: string) {
  if (type === "rectangle") return { type: ROUNDNESS.ADAPTIVE_RADIUS };
  if (type === "diamond" || type === "ellipse") return { type: ROUNDNESS.PROPORTIONAL_RADIUS };
  return null;
}

interface LabelStyle {
  fontSize?: number;
  fontFamily?: number;
  strokeColor?: string;
}

function shapeSkeleton(
  id: string,
  type: string,
  b: { x: number; y: number; width: number; height: number },
  text: string | undefined,
  stroke: string | undefined,
  fill: string | undefined,
  label: LabelStyle = {},
  base: Partial<AnyEl> = {},
) {
  if (type === "text") {
    return {
      ...base,
      type: "text",
      id,
      x: b.x,
      y: b.y,
      text: text ?? "",
      strokeColor: stroke ?? label.strokeColor ?? DEFAULT_STROKE,
      fontFamily: label.fontFamily ?? NUNITO,
      fontSize: label.fontSize ?? 20,
    };
  }
  return {
    roughness: 0,
    strokeWidth: 2,
    fillStyle: "solid",
    roundness: roundnessFor(type),
    ...base,
    type,
    id,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    strokeColor: stroke ?? DEFAULT_STROKE,
    backgroundColor: fill ?? "transparent",
    label: text
      ? {
          text,
          fontFamily: label.fontFamily ?? NUNITO,
          fontSize: label.fontSize ?? 20,
          strokeColor: label.strokeColor ?? stroke ?? DEFAULT_STROKE,
        }
      : undefined,
  };
}

function arrowSkeleton(id: string, start: Point, end: Point, text?: string, stroke?: string) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return {
    type: "arrow",
    id,
    x: start.x,
    y: start.y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    points: [
      [0, 0],
      [dx, dy],
    ],
    strokeColor: stroke ?? DEFAULT_STROKE,
    strokeWidth: 2,
    roughness: 0,
    endArrowhead: "arrow",
    label: text ? { text, fontFamily: NUNITO, fontSize: 16 } : undefined,
  };
}

function ghostStyle(e: AnyEl, proposalId: string): AnyEl {
  return {
    ...e,
    opacity: Math.min(e.opacity ?? 100, GHOST_OPACITY),
    locked: true,
    customData: { ...(e.customData ?? {}), [GHOST_KEY]: proposalId },
  };
}

export function ghostOwner(e: El): string | undefined {
  const v = (e.customData as Record<string, unknown> | undefined)?.[GHOST_KEY];
  return typeof v === "string" ? v : undefined;
}

/** Plans `ops` against `scene`. Ops must already be validated against `aliases`. */
export function plan(ops: BoardOp[], aliases: AliasMap, scene: readonly El[], mode: Mode, proposalId: string): PlanResult {
  const notes: string[] = [];
  const live = new Map(scene.filter((e) => !e.isDeleted).map((e) => [e.id, e as AnyEl]));
  const prefix = mode === "ghost" ? `ghost-${proposalId}-` : `${proposalId}-`;
  const isNew = (ref: string) => /^n\d+$/.test(ref);
  const resolve = (ref: string): string | undefined => {
    if (isNew(ref)) return prefix + ref;
    const id = aliases[ref];
    return id && live.has(id) ? id : undefined;
  };
  const boundTextOf = (containerId: string) =>
    [...live.values()].find((e) => e.type === "text" && e.containerId === containerId);

  const boxes = new Map<string, Box>([...live.values()].map((e) => [e.id, boxOf(e)]));
  const created: AnyEl[] = [];
  const changed = new Map<string, AnyEl>();
  const deleted = new Set<string>();
  const moved = new Set<string>();
  const current = (id: string): AnyEl | undefined => changed.get(id) ?? live.get(id) ?? created.find((e) => e.id === id);
  const replace = (e: AnyEl) => {
    const i = created.findIndex((c) => c.id === e.id);
    if (i >= 0) created[i] = e;
    else changed.set(e.id, e);
  };

  // 1. New shapes.
  for (const op of ops.filter((o): o is CreateShapeOp => o.op === "create" && o.type !== "arrow")) {
    const id = prefix + op.id;
    created.push(...convert([shapeSkeleton(id, op.type, op, op.text, op.stroke, op.fill)]));
    boxes.set(id, { x: op.x, y: op.y, width: op.width, height: op.height, type: op.type });
  }

  // 2. Updates.
  for (const op of ops.filter((o): o is UpdateOp => o.op === "update")) {
    const id = resolve(op.id);
    const target = id ? live.get(id) : undefined;
    if (!id || !target) {
      notes.push(`${op.id} no longer exists; its update was skipped.`);
      continue;
    }
    const geom = {
      x: op.x ?? target.x,
      y: op.y ?? target.y,
      width: op.width ?? target.width,
      height: op.height ?? target.height,
    };
    const sizeChanged = geom.width !== target.width || geom.height !== target.height;
    const posChanged = geom.x !== target.x || geom.y !== target.y;
    const isLinear = target.type === "arrow" || target.type === "line";

    if (isLinear) {
      if (op.text !== undefined) notes.push(`Changing the label of ${op.id} is not supported yet.`);
      if (op.x !== undefined || op.y !== undefined || op.width !== undefined || op.height !== undefined)
        notes.push(`Moving or resizing ${op.id} is not supported; arrows follow the shapes they connect.`);
      if (mode === "apply" && op.stroke) changed.set(target.id, newElementWith(target, { strokeColor: op.stroke }) as AnyEl);
      continue;
    }
    if (!["rectangle", "ellipse", "diamond", "text"].includes(target.type)) {
      if (op.text !== undefined) notes.push(`${op.id} is a ${target.type}; its text cannot be changed.`);
    }
    boxes.set(target.id, { ...geom, type: target.type });
    if (sizeChanged || posChanged) moved.add(target.id);

    const bound = target.type === "text" ? undefined : boundTextOf(target.id);
    const newText = op.text ?? (target.type === "text" ? target.originalText ?? target.text : bound?.originalText);
    const labelStyle: LabelStyle = bound
      ? { fontSize: bound.fontSize, fontFamily: bound.fontFamily, strokeColor: bound.strokeColor }
      : target.type === "text"
        ? { fontSize: target.fontSize, fontFamily: target.fontFamily }
        : {};
    const stroke = op.stroke ?? target.strokeColor;
    const fill = op.fill ?? target.backgroundColor;

    if (mode === "ghost") {
      if (target.type === "text" || ["rectangle", "ellipse", "diamond"].includes(target.type)) {
        const base = target.type === "text" ? {} : { roughness: target.roughness, strokeWidth: target.strokeWidth, fillStyle: target.fillStyle, roundness: target.roundness };
        const ghosts = convert([shapeSkeleton(`${prefix}u-${op.id}`, target.type, geom, newText, stroke, fill, labelStyle, base)]);
        created.push(...ghosts.map((g) => ghostStyle(g, proposalId)));
      }
      continue;
    }

    // apply
    const props: Record<string, unknown> = { ...geom, strokeColor: stroke };
    if (target.type !== "text") props.backgroundColor = fill;
    let next = newElementWith(target, props) as AnyEl;

    if (target.type === "text" && op.text !== undefined) {
      const [t] = convert([shapeSkeleton(target.id, "text", geom, op.text, stroke, undefined, labelStyle)]);
      next = {
        ...t,
        version: target.version + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        index: target.index,
        groupIds: target.groupIds,
        frameId: target.frameId,
        angle: target.angle,
        opacity: target.opacity,
        locked: target.locked,
        link: target.link,
        boundElements: target.boundElements,
        customData: target.customData,
      };
    } else if (target.type !== "text" && (op.text !== undefined || (sizeChanged && bound))) {
      const others: BoundRef[] = (target.boundElements ?? []).filter((b: BoundRef) => b.id !== bound?.id);
      if (bound) changed.set(bound.id, newElementWith(bound, { isDeleted: true }) as AnyEl);
      if (newText) {
        const regenerated = convert([shapeSkeleton(target.id, target.type, geom, newText, stroke, fill, labelStyle)]);
        const label = regenerated.find((e) => e.type === "text");
        if (label) {
          created.push({ ...label, groupIds: target.groupIds, frameId: target.frameId });
          others.push({ id: label.id, type: "text" });
        }
      }
      next = newElementWith(next, { boundElements: others }) as AnyEl;
    } else if (bound && posChanged) {
      changed.set(bound.id, newElementWith(bound, { x: bound.x + geom.x - target.x, y: bound.y + geom.y - target.y }) as AnyEl);
    }
    changed.set(target.id, next);
  }

  // 3. Deletes.
  for (const op of ops.filter((o): o is DeleteOp => o.op === "delete")) {
    const id = resolve(op.id);
    const target = id ? live.get(id) : undefined;
    if (!id || !target) {
      notes.push(`${op.id} no longer exists.`);
      continue;
    }
    if (mode === "ghost") {
      const pad = 8;
      const [overlay] = convert([
        {
          type: "rectangle",
          id: `${prefix}d-${op.id}`,
          x: target.x - pad,
          y: target.y - pad,
          width: target.width + 2 * pad,
          height: target.height + 2 * pad,
          strokeColor: "#e03131",
          backgroundColor: "#ffc9c9",
          fillStyle: "solid",
          strokeStyle: "dashed",
          strokeWidth: 2,
          roughness: 0,
        },
      ]);
      created.push(ghostStyle(overlay, proposalId));
      continue;
    }
    deleted.add(target.id);
    changed.set(target.id, newElementWith(target, { isDeleted: true }) as AnyEl);
    for (const e of live.values()) {
      if (e.type === "text" && e.containerId === target.id) changed.set(e.id, newElementWith(e, { isDeleted: true }) as AnyEl);
    }
    boxes.delete(target.id);
  }

  // 4. New arrows, after shapes so they can attach to new and moved shapes.
  for (const op of ops.filter((o): o is CreateArrowOp => o.op === "create" && o.type === "arrow")) {
    const from = resolve(op.from);
    const to = resolve(op.to);
    const a = from ? boxes.get(from) : undefined;
    const b = to ? boxes.get(to) : undefined;
    if (!from || !to || !a || !b) {
      notes.push(`Arrow ${op.id} was skipped because one of its shapes is missing.`);
      continue;
    }
    const { start, end } = arrowBetween(a, b, ARROW_GAP);
    const id = prefix + op.id;
    const made = convert([arrowSkeleton(id, start, end, op.text, op.stroke)]);
    if (mode === "ghost") {
      created.push(...made.map((g) => ghostStyle(g, proposalId)));
      continue;
    }
    const arrow = made.find((e) => e.id === id)!;
    created.push(
      ...made.map((e) =>
        e.id === id
          ? {
              ...arrow,
              startBinding: { elementId: from, focus: 0, gap: ARROW_GAP },
              endBinding: { elementId: to, focus: 0, gap: ARROW_GAP },
            }
          : e,
      ),
    );
    for (const targetId of [from, to]) {
      const t = current(targetId)!;
      const refs: BoundRef[] = [...(t.boundElements ?? []), { id, type: "arrow" }];
      replace(created.some((c) => c.id === targetId) ? { ...t, boundElements: refs } : (newElementWith(t, { boundElements: refs }) as AnyEl));
    }
  }

  if (mode === "ghost") {
    return { elements: created.map((e) => (e.customData?.[GHOST_KEY] ? e : ghostStyle(e, proposalId))), notes };
  }

  // 5. Existing arrows: re-route ends attached to moved shapes, unbind ends on deleted ones.
  for (const e of live.values()) {
    if (e.type !== "arrow" || deleted.has(e.id)) continue;
    const arrow = current(e.id)!;
    const sId: string | undefined = arrow.startBinding?.elementId;
    const eId: string | undefined = arrow.endBinding?.elementId;
    const unbind: Record<string, null> = {};
    if (sId && deleted.has(sId)) unbind.startBinding = null;
    if (eId && deleted.has(eId)) unbind.endBinding = null;
    const reroute = (sId && moved.has(sId)) || (eId && moved.has(eId));
    if (!reroute) {
      if (Object.keys(unbind).length) changed.set(e.id, newElementWith(arrow, unbind) as AnyEl);
      continue;
    }
    const abs: Point[] = arrow.points.map((p: [number, number]) => ({ x: arrow.x + p[0], y: arrow.y + p[1] }));
    const n = abs.length;
    const sBox = sId && !deleted.has(sId) ? boxes.get(sId) : undefined;
    const eBox = eId && !deleted.has(eId) ? boxes.get(eId) : undefined;
    const start = sBox ? edgePoint(sBox, n > 2 ? abs[1] : eBox ? center(eBox) : abs[n - 1], ARROW_GAP) : abs[0];
    const end = eBox ? edgePoint(eBox, n > 2 ? abs[n - 2] : sBox ? center(sBox) : abs[0], ARROW_GAP) : abs[n - 1];
    const pts = [start, ...abs.slice(1, -1), end];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    changed.set(
      e.id,
      newElementWith(arrow, {
        ...unbind,
        x: start.x,
        y: start.y,
        points: pts.map((p) => [p.x - start.x, p.y - start.y]),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      }) as AnyEl,
    );
    // Keep an arrow's label near its middle.
    const label = boundTextOf(e.id);
    if (label) {
      const before = { x: (abs[0].x + abs[n - 1].x) / 2, y: (abs[0].y + abs[n - 1].y) / 2 };
      const after = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      changed.set(label.id, newElementWith(label, { x: label.x + after.x - before.x, y: label.y + after.y - before.y }) as AnyEl);
    }
  }

  const elements = [...scene.map((e) => changed.get(e.id) ?? e), ...created];
  return { elements, notes };
}

// ---- Scene operations ----

export function hideGhosts(api: ExcalidrawImperativeAPI, proposalId: string) {
  const scene = api.getSceneElementsIncludingDeleted();
  if (!scene.some((e) => ghostOwner(e) === proposalId)) return;
  api.updateScene({ elements: scene.filter((e) => ghostOwner(e) !== proposalId), captureUpdate: CaptureUpdateAction.NEVER });
}

/** Shows (or refreshes) the preview for a proposal. Not recorded in undo history. */
export function showGhosts(api: ExcalidrawImperativeAPI, proposalId: string, ops: BoardOp[], aliases: AliasMap): string[] {
  const scene = api.getSceneElementsIncludingDeleted().filter((e) => ghostOwner(e) !== proposalId);
  const { elements: ghosts, notes } = plan(ops, aliases, scene, "ghost", proposalId);
  api.updateScene({ elements: [...scene, ...ghosts], captureUpdate: CaptureUpdateAction.NEVER });
  return notes;
}

/** Applies ops for real as a single undoable step and removes the preview. */
export function applyToScene(api: ExcalidrawImperativeAPI, proposalId: string, ops: BoardOp[], aliases: AliasMap): string[] {
  hideGhosts(api, proposalId);
  const scene = api.getSceneElementsIncludingDeleted();
  const { elements, notes } = plan(ops, aliases, scene, "apply", proposalId);
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  return notes;
}
