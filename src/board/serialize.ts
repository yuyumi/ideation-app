// Compact JSON view of the board for Claude. Excalidraw's random element
// ids are replaced with short aliases (s1, s2, ...) that save tokens and
// give Claude ids it cannot plausibly invent.

import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** customData key marking preview ("ghost") elements. Ghosts never reach disk or Claude. */
export const GHOST_KEY = "ideationGhost";

export function isGhost(el: ExcalidrawElement): boolean {
  return Boolean(el.customData && (el.customData as Record<string, unknown>)[GHOST_KEY]);
}

export interface BoardShape {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  stroke?: string;
  fill?: string;
  from?: string;
  to?: string;
  frame?: string;
  group?: string;
}

export interface SerializedBoard {
  scope: "board" | "selection";
  shapes: BoardShape[];
  /** Shapes on the board but outside the selection. */
  notShown?: number;
}

/** alias -> Excalidraw element id */
export type AliasMap = Record<string, string>;

const r = (n: number) => Math.round(n);

type TextLike = ExcalidrawElement & { text?: string; originalText?: string; containerId?: string | null; name?: string | null };
type Bindable = ExcalidrawElement & {
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
};

export function serializeBoard(
  elements: readonly ExcalidrawElement[],
  selectedIds: Readonly<Record<string, boolean>> | null,
): { board: SerializedBoard; aliases: AliasMap } {
  const live = elements.filter((e) => !e.isDeleted && !isGhost(e));
  const byId = new Map(live.map((e) => [e.id, e]));

  // Text bound to a live container becomes that container's label.
  const labels = new Map<string, string>();
  const boundTextIds = new Set<string>();
  for (const e of live as TextLike[]) {
    if (e.type === "text" && e.containerId && byId.has(e.containerId)) {
      labels.set(e.containerId, e.originalText ?? e.text ?? "");
      boundTextIds.add(e.id);
    }
  }
  const shapes = live.filter((e) => !boundTextIds.has(e.id));

  const aliases: AliasMap = {};
  const aliasOf = new Map<string, string>();
  shapes.forEach((e, i) => {
    const a = `s${i + 1}`;
    aliases[a] = e.id;
    aliasOf.set(e.id, a);
  });
  const groupAlias = new Map<string, string>();
  const groupOf = (e: ExcalidrawElement) => {
    const outer = e.groupIds[e.groupIds.length - 1];
    if (!outer) return undefined;
    if (!groupAlias.has(outer)) groupAlias.set(outer, `g${groupAlias.size + 1}`);
    return groupAlias.get(outer);
  };

  const inScope = (e: ExcalidrawElement) => {
    if (!selectedIds) return true;
    if (selectedIds[e.id]) return true;
    // Selecting a label selects its container.
    return live.some((t) => boundTextIds.has(t.id) && (t as TextLike).containerId === e.id && selectedIds[t.id]);
  };
  const scoped = shapes.filter(inScope);

  const out: BoardShape[] = scoped.map((e) => {
    const t = e as TextLike;
    const b = e as Bindable;
    const shape: BoardShape = { id: aliasOf.get(e.id)!, type: e.type, x: r(e.x), y: r(e.y), w: r(e.width), h: r(e.height) };
    const text = e.type === "text" ? (t.originalText ?? t.text) : e.type === "frame" ? t.name ?? undefined : labels.get(e.id);
    if (text) shape.text = text;
    if (e.type !== "text" && e.type !== "frame" && e.type !== "image") shape.stroke = e.strokeColor;
    if (e.type === "text") shape.stroke = e.strokeColor;
    if (e.backgroundColor && e.backgroundColor !== "transparent") shape.fill = e.backgroundColor;
    const from = b.startBinding?.elementId && aliasOf.get(b.startBinding.elementId);
    const to = b.endBinding?.elementId && aliasOf.get(b.endBinding.elementId);
    if (from) shape.from = from;
    if (to) shape.to = to;
    if (e.frameId && aliasOf.has(e.frameId)) shape.frame = aliasOf.get(e.frameId);
    const g = groupOf(e);
    if (g) shape.group = g;
    return shape;
  });

  const board: SerializedBoard = { scope: selectedIds ? "selection" : "board", shapes: out };
  if (selectedIds && shapes.length > scoped.length) board.notShown = shapes.length - scoped.length;
  return { board, aliases };
}

export function buildPrompt(userText: string, board: SerializedBoard): string {
  return `${userText.trim()}\n\n<board scope="${board.scope}">\n${JSON.stringify(board)}\n</board>`;
}
