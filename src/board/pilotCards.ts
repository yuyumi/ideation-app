// Pilot cards: ordinary board shapes that link to a pilot. Their fill shows
// the pilot's status; clicking the link opens the pilot in the sidebar.

import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { PilotMeta, PilotStatus } from "../types";
import { isGhost } from "./serialize";

export const PILOT_KEY = "ideationPilot";
export const PILOT_LINK_PREFIX = "ideation://pilot/";

export const STATUS_FILL: Record<PilotStatus, string> = {
  queued: "#e9ecef",
  running: "#a5d8ff",
  succeeded: "#b2f2bb",
  failed: "#ffc9c9",
  cancelled: "#ffec99",
  interrupted: "#ffec99",
};

export function pilotIdFromLink(link: string | null | undefined): string | null {
  return link && link.startsWith(PILOT_LINK_PREFIX) ? link.slice(PILOT_LINK_PREFIX.length) : null;
}

const pilotOf = (e: ExcalidrawElement) => (e.customData as Record<string, unknown> | undefined)?.[PILOT_KEY];

const CARD_W = 240;
const CARD_H = 72;
const GAP = 60;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Rect, b: Rect, pad: number) =>
  a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad;

/**
 * Top-left corner for a card near `anchor` that overlaps nothing on the board:
 * to the right of it first, then below it, moving outward until clear.
 */
export function freeSpot(scene: readonly Rect[], anchor: readonly Rect[], w: number, h: number): { x: number; y: number } {
  if (anchor.length === 0) return { x: 0, y: 0 };
  const minX = Math.min(...anchor.map((e) => e.x));
  const minY = Math.min(...anchor.map((e) => e.y));
  const maxX = Math.max(...anchor.map((e) => e.x + e.width));
  const maxY = Math.max(...anchor.map((e) => e.y + e.height));
  const clear = (c: Rect) => !scene.some((e) => overlaps(c, e, 20));
  for (let i = 0; i < 40; i++) {
    const right = { x: maxX + GAP, y: minY + i * (h + 20), width: w, height: h };
    if (clear(right)) return right;
    const below = { x: minX + i * (w + 20), y: maxY + GAP, width: w, height: h };
    if (clear(below)) return below;
  }
  // Fall back to below everything on the board.
  return { x: minX, y: Math.max(...scene.map((e) => e.y + e.height)) + GAP };
}

/** Adds a card to the right of the selection (or of the whole board) as one undoable step. */
export function addPilotCard(api: ExcalidrawImperativeAPI, meta: PilotMeta, selectedIds: Record<string, boolean> | null) {
  const scene = api.getSceneElements().filter((e) => !isGhost(e));
  const anchor = selectedIds ? scene.filter((e) => selectedIds[e.id]) : scene;
  const { x, y } = freeSpot(scene, anchor.length ? anchor : scene, CARD_W, CARD_H);
  const label = meta.title.length > 40 ? `${meta.title.slice(0, 40)}…` : meta.title;
  const card = convertToExcalidrawElements(
    [
      {
        type: "rectangle",
        id: `pilot-card-${meta.id}`,
        x,
        y,
        width: CARD_W,
        height: CARD_H,
        strokeColor: "#1e1e1e",
        backgroundColor: STATUS_FILL[meta.status],
        fillStyle: "solid",
        strokeStyle: "dashed",
        strokeWidth: 2,
        roughness: 0,
        roundness: { type: 3 },
        link: `${PILOT_LINK_PREFIX}${meta.id}`,
        customData: { [PILOT_KEY]: meta.id },
        label: { text: `Pilot: ${label}`, fontSize: 16, fontFamily: 6 },
      },
    ] as never,
    { regenerateIds: false },
  );
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), ...card],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

/** Recolors the card for a pilot after its status changes. */
export function updatePilotCard(api: ExcalidrawImperativeAPI, meta: PilotMeta) {
  const fill = STATUS_FILL[meta.status];
  const scene = api.getSceneElementsIncludingDeleted();
  if (!scene.some((e) => !e.isDeleted && pilotOf(e) === meta.id && e.backgroundColor !== fill)) return;
  api.updateScene({
    elements: scene.map((e) => (!e.isDeleted && pilotOf(e) === meta.id ? newElementWith(e, { backgroundColor: fill }) : e)),
    captureUpdate: CaptureUpdateAction.EVENTUALLY,
  });
}
