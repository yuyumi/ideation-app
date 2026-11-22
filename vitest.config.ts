import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  test: {
    // Excalidraw's bundle uses extensionless imports; let Vite resolve them.
    server: { deps: { inline: [/@excalidraw/] } },
    css: false,
    setupFiles: ["./test/canvas-stub.ts"],
  },
});
