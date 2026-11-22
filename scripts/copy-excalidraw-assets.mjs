// Copies Excalidraw's font files into public/ so the app works fully offline.
// Excalidraw otherwise fetches fonts from a CDN at runtime.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "fonts");
const dest = join(root, "public", "fonts");

if (!existsSync(src)) {
  console.error(`Excalidraw fonts not found at ${src}. Run npm install first.`);
  process.exit(1);
}
if (!existsSync(dest)) {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log("Copied Excalidraw fonts to public/fonts");
}
