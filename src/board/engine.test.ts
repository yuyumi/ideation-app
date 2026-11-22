import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { buildPrompt, GHOST_KEY, serializeBoard } from "./serialize";
import { parseProposal, resolveSelection, splitReply, validateProposal } from "./proposals";
import { arrowBetween, edgePoint } from "./geometry";

// Minimal element factory; serializeBoard only reads these fields.
let seq = 0;
function el(partial: Record<string, unknown>): ExcalidrawElement {
  return {
    id: `id${++seq}`,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    customData: undefined,
    ...partial,
  } as unknown as ExcalidrawElement;
}

describe("serializeBoard", () => {
  const box = el({ id: "A", x: 10.4, y: 20.6 });
  const label = el({ id: "A-label", type: "text", containerId: "A", text: "Ser\nver", originalText: "Server" });
  const db = el({ id: "B", type: "ellipse", x: 300, backgroundColor: "#a5d8ff", groupIds: ["inner", "outer"] });
  const arrow = el({ id: "C", type: "arrow", startBinding: { elementId: "A" }, endBinding: { elementId: "B" } });
  const note = el({ id: "D", type: "text", text: "note", originalText: "note" });
  const deleted = el({ id: "E", isDeleted: true });
  const ghost = el({ id: "F", customData: { [GHOST_KEY]: "p1" } });
  const all = [box, label, db, arrow, note, deleted, ghost];

  it("aliases shapes, folds labels into containers and drops deleted and ghost elements", () => {
    const { board, aliases } = serializeBoard(all, null);
    expect(board.scope).toBe("board");
    expect(aliases).toEqual({ s1: "A", s2: "B", s3: "C", s4: "D" });
    expect(board.shapes[0]).toEqual({ id: "s1", type: "rectangle", x: 10, y: 21, w: 100, h: 50, text: "Server", stroke: "#1e1e1e" });
    expect(board.shapes[1]).toMatchObject({ id: "s2", fill: "#a5d8ff", group: "g1" });
    expect(board.shapes[2]).toMatchObject({ id: "s3", type: "arrow", from: "s1", to: "s2" });
    expect(board.shapes[3]).toMatchObject({ id: "s4", type: "text", text: "note" });
  });

  it("limits to the selection but keeps aliases for everything", () => {
    const { board, aliases } = serializeBoard(all, { "A-label": true });
    expect(board.scope).toBe("selection");
    expect(board.shapes.map((s) => s.id)).toEqual(["s1"]);
    expect(board.notShown).toBe(3);
    expect(Object.keys(aliases)).toHaveLength(4);
  });

  it("builds a prompt with the board block", () => {
    const { board } = serializeBoard([box], null);
    const p = buildPrompt("  improve this  ", board);
    expect(p.startsWith("improve this\n\n<board scope=\"board\">")).toBe(true);
    expect(p.endsWith("</board>")).toBe(true);
  });
});

describe("splitReply", () => {
  it("separates prose from the last board-ops block", () => {
    const text = "Here is a plan.\n\n```board-ops\n{\"ops\":[]}\n```\n\nDone.";
    const { prose, block } = splitReply(text);
    expect(block?.trim()).toBe('{"ops":[]}');
    expect(prose).toBe("Here is a plan.\n\nDone.");
  });
  it("handles replies without a block", () => {
    expect(splitReply("just text")).toEqual({ prose: "just text", block: null });
  });
});

describe("validateProposal", () => {
  const aliases = { s1: "A", s2: "B", s3: "C" };

  it("accepts well-formed ops and fills defaults", () => {
    const p = validateProposal(
      {
        summary: "Add cache",
        ops: [
          { op: "create", id: "n1", type: "rectangle", x: 0, y: 200, text: "Cache", fill: "#ffec99" },
          { op: "create", id: "n2", type: "arrow", from: "s1", to: "n1" },
          { op: "update", id: "s2", text: "DB", x: 10 },
          { op: "delete", id: "s3" },
        ],
      },
      aliases,
    );
    expect(p.dropped).toEqual([]);
    expect(p.summary).toBe("Add cache");
    expect(p.ops).toHaveLength(4);
    expect(p.ops[0]).toMatchObject({ width: 180, height: 80 });
  });

  it("drops invented ids, bad colors, bad types and conflicting edits with reasons", () => {
    const p = validateProposal(
      {
        ops: [
          { op: "update", id: "s9", text: "x" },
          { op: "create", id: "n1", type: "rectangle", x: 0, y: 0, fill: "red" },
          { op: "create", id: "n2", type: "hexagon", x: 0, y: 0 },
          { op: "create", id: "x5", type: "rectangle", x: 0, y: 0 },
          { op: "create", id: "n3", type: "arrow", from: "s1", to: "n99" },
          { op: "update", id: "s1" },
          { op: "delete", id: "s2" },
          { op: "update", id: "s2", text: "late" },
          { op: "create", id: "n4", type: "arrow", from: "s1", to: "s2" },
          { op: "create", id: "n5", type: "text", x: 0, y: 0 },
          "nonsense",
        ],
      },
      aliases,
    );
    expect(p.ops.map((o) => `${o.op}:${o.id}`)).toEqual(["delete:s2"]);
    expect(p.dropped).toHaveLength(10);
    expect(p.dropped.join("\n")).toMatch(/not a shape on the board/);
    expect(p.dropped.join("\n")).toMatch(/hex color/);
    expect(p.dropped.join("\n")).toMatch(/deletes/);
  });

  it("rejects non-JSON and missing ops", () => {
    expect(parseProposal("{nope", aliases).dropped[0]).toMatch(/not valid JSON/);
    expect(validateProposal({ summary: "x" }, aliases).dropped[0]).toMatch(/no "ops"/);
  });

  it("does not treat prototype keys as aliases", () => {
    const p = validateProposal({ ops: [{ op: "delete", id: "toString" }] }, aliases);
    expect(p.ops).toEqual([]);
  });
});

describe("resolveSelection", () => {
  it("skips arrows whose new endpoints were not accepted", () => {
    const { ops } = validateProposal(
      {
        ops: [
          { op: "create", id: "n1", type: "rectangle", x: 0, y: 0 },
          { op: "create", id: "n2", type: "arrow", from: "s1", to: "n1" },
          { op: "create", id: "n3", type: "arrow", from: "s1", to: "s2" },
        ],
      },
      { s1: "A", s2: "B" },
    );
    const r = resolveSelection(ops, new Set([1, 2]));
    expect(r.apply).toEqual([2]);
    expect(r.skipped[0]).toMatch(/n1/);
    expect(resolveSelection(ops, new Set([0, 1, 2])).apply).toEqual([0, 1, 2]);
  });
});

describe("geometry", () => {
  const a = { x: 0, y: 0, width: 100, height: 50, type: "rectangle" };
  const b = { x: 300, y: 0, width: 100, height: 50, type: "ellipse" };
  it("puts arrow ends on the outlines, outside by the gap", () => {
    const { start, end } = arrowBetween(a, b, 5);
    expect(start).toEqual({ x: 105, y: 25 });
    expect(end).toEqual({ x: 295, y: 25 });
  });
  it("handles diamonds and vertical directions", () => {
    const d = { x: 0, y: 0, width: 100, height: 100, type: "diamond" };
    const p = edgePoint(d, { x: 50, y: 500 }, 0);
    expect(p).toEqual({ x: 50, y: 100 });
    const q = edgePoint(d, { x: 500, y: 500 }, 0);
    expect(q.x).toBeCloseTo(75);
    expect(q.y).toBeCloseTo(75);
  });
});
