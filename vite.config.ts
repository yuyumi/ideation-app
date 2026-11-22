import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and does not need Vite to clear the terminal.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: { target: "es2021", chunkSizeWarningLimit: 4000 },
});
