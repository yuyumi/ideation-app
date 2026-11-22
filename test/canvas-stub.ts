// jsdom has no 2D canvas. Excalidraw probes one at import time and measures
// text with it, so tests get a minimal stand-in with 8px-wide characters.
if (typeof HTMLCanvasElement !== "undefined") {
  const ctx = new Proxy(
    {
      filter: "none",
      font: "",
      measureText: (text: string) => ({
        width: text.length * 8,
        actualBoundingBoxAscent: 14,
        actualBoundingBoxDescent: 4,
      }),
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : () => undefined) },
  );
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
}

// jsdom also lacks the FontFace API Excalidraw registers its fonts with.
if (typeof globalThis.FontFace === "undefined") {
  class FakeFontFace {
    family: string;
    status = "loaded";
    constructor(family: string) {
      this.family = family;
    }
    load() {
      return Promise.resolve(this);
    }
  }
  (globalThis as Record<string, unknown>).FontFace = FakeFontFace;
}
if (typeof document !== "undefined" && !(document as unknown as { fonts?: unknown }).fonts) {
  Object.defineProperty(document, "fonts", {
    value: { add() {}, delete() {}, check: () => true, load: () => Promise.resolve([]), ready: Promise.resolve(), [Symbol.iterator]: function* () {} },
  });
}
