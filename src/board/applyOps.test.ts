// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BoardOp } from "./proposals";
import { GHOST_KEY, serializeBoard } from "./serialize";

type AnyEl = ExcalidrawElement & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let plan: typeof import("./applyOps").plan;
let convert: (s: unknown[]) => AnyEl[];

beforeAll(async () => {
  // Text measurement comes from the canvas stub in test/canvas-stub.ts.
  const ex = await import("@excalidraw/excalidraw");
  convert = (s) => ex.convertToExcalidrawElements(s as never, { regenerateIds: false }) as AnyEl[];
  plan = (await import("./applyOps")).plan;
});

function baseScene(): AnyEl[] {
  return convert([
    { type: "rectangle", id: "A", x: 0, y: 0, width: 200, height: 100, label: { text: "Server" } },
    { type: "ellipse", id: "B", x: 500, y: 0, width: 200, height: 100 },
    { type: "arrow", id: "C", x: 210, y: 50, points: [[0, 0], [280, 0]], start: { id: "A" }, end: { id: "B" } },
    { type: "text", id: "D", x: 0, y: 300, text: "note" },
  ]);
}

const live = (els: readonly ExcalidrawElement[]) => els.filter((e) => !e.isDeleted) as AnyEl[];
const byId = (els: readonly ExcalidrawElement[], id: string) => els.find((e) => e.id === id) as AnyEl;

describe("plan", () => {
  it("fixture: the converted scene has bindings and a bound label", () => {
    const s = baseScene();
    expect(byId(s, "C").startBinding?.elementId).toBe("A");
    expect(s.some((e) => e.type === "text" && e.containerId === "A")).toBe(true);
  });

  it("ghost mode returns only locked, translucent elements and leaves the scene alone", () => {
    const scene = baseScene();
    const { aliases } = serializeBoard(scene, null);
    const ops: BoardOp[] = [
      { op: "create", id: "n1", type: "rectangle", x: 0, y: 200, width: 180, height: 80, text: "Cache" },
      { op: "create", id: "n2", type: "arrow", from: "s1", to: "n1" },
      { op: "update", id: "s2", text: "DB" },
      { op: "delete", id: "s4" },
    ];
    const { elements, notes } = plan(ops, aliases, scene, "ghost", "p1");
    expect(notes).toEqual([]);
    expect(elements.length).toBeGreaterThanOrEqual(5);
    for (const e of elements) {
      expect((e.customData as Record<string, unknown>)[GHOST_KEY]).toBe("p1");
      expect(e.locked).toBe(true);
      expect(e.opacity).toBeLessThanOrEqual(45);
      expect(scene.some((s) => s.id === e.id)).toBe(false);
    }
  });

  it("apply mode creates shapes, binds new arrows both ways, updates labels and deletes", () => {
    const scene = baseScene();
    const { aliases } = serializeBoard(scene, null);
    const ops: BoardOp[] = [
      { op: "create", id: "n1", type: "rectangle", x: 0, y: 200, width: 180, height: 80, text: "Cache", fill: "#ffec99" },
      { op: "create", id: "n2", type: "arrow", from: "s1", to: "n1", text: "reads" },
      { op: "update", id: "s2", text: "DB", fill: "#a5d8ff" },
      { op: "delete", id: "s4" },
    ];
    const { elements, notes } = plan(ops, aliases, scene, "apply", "p1");
    expect(notes).toEqual([]);

    const n1 = byId(elements, "p1-n1");
    expect(n1).toMatchObject({ type: "rectangle", backgroundColor: "#ffec99" });
    const arrow = byId(elements, "p1-n2");
    expect(arrow.startBinding.elementId).toBe("A");
    expect(arrow.endBinding.elementId).toBe("p1-n1");
    expect(byId(elements, "A").boundElements).toContainEqual({ id: "p1-n2", type: "arrow" });
    expect(n1.boundElements).toContainEqual({ id: "p1-n2", type: "arrow" });

    const b = byId(elements, "B");
    expect(b.backgroundColor).toBe("#a5d8ff");
    const bLabel = live(elements).find((e) => e.type === "text" && e.containerId === "B");
    expect(bLabel?.text).toBe("DB");
    expect(b.boundElements).toContainEqual({ id: bLabel!.id, type: "text" });

    expect(byId(elements, "D").isDeleted).toBe(true);
    // Nothing ghostly leaks into a real apply.
    expect(elements.some((e) => e.customData && (e.customData as Record<string, unknown>)[GHOST_KEY])).toBe(false);
  });

  it("re-routes existing arrows and moves labels when a shape moves", () => {
    const scene = baseScene();
    const { aliases } = serializeBoard(scene, null);
    const before = byId(scene, "C");
    const labelBefore = live(scene).find((e) => e.type === "text" && e.containerId === "A")!;
    const { elements } = plan([{ op: "update", id: "s1", y: 400 }], aliases, scene, "apply", "p2");
    const a = byId(elements, "A");
    expect(a.y).toBe(400);
    const label = byId(elements, labelBefore.id);
    expect(label.y - labelBefore.y).toBeCloseTo(400);
    const c = byId(elements, "C");
    expect(c.version).toBeGreaterThan(before.version);
    // Arrow now starts near A's new position, below where it used to.
    expect(c.y).toBeGreaterThan(before.y + 100);
  });

  it("changes standalone text in place and keeps its id", () => {
    const scene = baseScene();
    const { aliases } = serializeBoard(scene, null);
    const { elements } = plan([{ op: "update", id: "s4", text: "longer note" }], aliases, scene, "apply", "p3");
    const d = byId(elements, "D");
    expect(d.text).toBe("longer note");
    expect(d.version).toBeGreaterThan(byId(scene, "D").version);
    expect(d.isDeleted).toBe(false);
  });

  it("unbinds arrows whose shape was deleted and notes stale ids", () => {
    const scene = baseScene();
    const { aliases } = serializeBoard(scene, null);
    const { elements } = plan([{ op: "delete", id: "s2" }], aliases, scene, "apply", "p4");
    expect(byId(elements, "C").endBinding).toBeNull();

    const gone = scene.map((e) => (e.id === "B" ? { ...e, isDeleted: true } : e));
    const r = plan([{ op: "update", id: "s2", text: "x" }], aliases, gone, "apply", "p5");
    expect(r.notes[0]).toMatch(/no longer exists/);
  });
});
