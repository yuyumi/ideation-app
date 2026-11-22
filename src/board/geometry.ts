// Where an arrow between two shapes should start and end: on each shape's
// outline, along the line between their centers.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
}

export interface Point {
  x: number;
  y: number;
}

export const center = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Point on `b`'s outline in the direction of `toward`, pushed out by `gap`. */
export function edgePoint(b: Box, toward: Point, gap = 6): Point {
  const c = center(b);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const a = Math.max(b.width / 2, 1);
  const h = Math.max(b.height / 2, 1);
  let t: number; // fraction of (dx, dy) from the center to the outline
  if (b.type === "ellipse") {
    t = 1 / Math.sqrt((dx / a) ** 2 + (dy / h) ** 2);
  } else if (b.type === "diamond") {
    t = 1 / (Math.abs(dx) / a + Math.abs(dy) / h);
  } else {
    t = Math.min(dx === 0 ? Infinity : a / Math.abs(dx), dy === 0 ? Infinity : h / Math.abs(dy));
  }
  const len = Math.hypot(dx, dy);
  return { x: c.x + dx * t + (dx / len) * gap, y: c.y + dy * t + (dy / len) * gap };
}

/** Start and end points for an arrow from box `a` to box `b`. */
export function arrowBetween(a: Box, b: Box, gap = 6): { start: Point; end: Point } {
  return { start: edgePoint(a, center(b), gap), end: edgePoint(b, center(a), gap) };
}
