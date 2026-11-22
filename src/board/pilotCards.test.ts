// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { freeSpot } from "./pilotCards";

const r = (x: number, y: number, width = 100, height = 50) => ({ x, y, width, height });

describe("freeSpot", () => {
  it("goes to the right of the anchor when that space is empty", () => {
    expect(freeSpot([r(0, 0)], [r(0, 0)], 240, 72)).toEqual({ x: 160, y: 0, width: 240, height: 72 });
  });
  it("avoids shapes to the right and never overlaps anything", () => {
    const scene = [r(0, 0, 200, 90), r(400, 0, 200, 90)]; // like "API server" then "Postgres"
    const spot = freeSpot(scene, [scene[0]], 240, 72);
    const card = { ...spot, width: 240, height: 72 };
    for (const e of scene) {
      const hit = card.x < e.x + e.width && e.x < card.x + card.width && card.y < e.y + e.height && e.y < card.y + card.height;
      expect(hit).toBe(false);
    }
  });
  it("handles an empty board", () => {
    expect(freeSpot([], [], 240, 72)).toEqual({ x: 0, y: 0 });
  });
});
