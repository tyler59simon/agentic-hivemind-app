import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync, readdirSync, statSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { join, relative, resolve, sep } from "node:path";
const host = process.env.TAURI_DEV_HOST;

/** Excalidraw's fonts (NS-3D), served by Hivemind itself so a drawing loads nothing from the network. `index.css` in the
 *  package references only the four Assistant fonts, which Vite bundles on its own; the others are found by
 *  `EXCALIDRAW_ASSET_PATH` (see `excalidrawLoader.ts`), which names `/excalidraw-assets/`. They are served from the package
 *  in development and copied to `dist/excalidraw-assets/` by the build. The Xiaolai family (Chinese handwriting, about
 *  13 MB of the 14 MB) is left out: Chinese, Japanese and Korean text in a drawing is drawn with a system font instead,
 *  and Excalidraw's attempt to load the missing file fails quietly. */
function excalidrawAssets(): Plugin {
  const root = resolve(process.cwd(), "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
  const base = "/excalidraw-assets/fonts/";
  const skipped = (file: string) => file.split(/[\\/]/).includes("Xiaolai");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n: string) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  return {
    name: "hivemind-excalidraw-assets",
    configureServer(server) {
      server.middlewares.use(base, (req: { url?: string }, res: { statusCode: number; setHeader(k: string, v: string): void; end(b?: unknown): void }, next: () => void) => {
        // Only a font file inside the package's fonts folder is ever served.
        const name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = resolve(root, name);
        if (!name || !file.startsWith(root + sep) || !file.endsWith(".woff2") || skipped(file)) { next(); return; }
        try {
          const bytes = readFileSync(file);
          res.setHeader("Content-Type", "font/woff2");
          res.end(bytes);
        } catch { next(); }
      });
    },
    generateBundle() {
      for (const file of walk(root).filter((f) => !skipped(f))) {
        this.emitFile({ type: "asset", fileName: `excalidraw-assets/fonts/${relative(root, file).split(sep).join("/")}`, source: readFileSync(file) });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), excalidrawAssets()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
