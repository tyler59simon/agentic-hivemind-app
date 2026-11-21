// Excalidraw (NS-3D) is a lazy chunk, loaded when a drawing is first opened. Its fonts are served by Hivemind itself:
// `vite.config.ts` copies them to `/excalidraw-assets/` at build and serves them there in development, and
// `EXCALIDRAW_ASSET_PATH` points the library at that folder. It must be set before the library's code runs, because the
// library builds its font list when it is first evaluated, so the import comes after it and never before.
export const EXCALIDRAW_ASSETS = "/excalidraw-assets/";

type Excalidraw = typeof import("@excalidraw/excalidraw");
let loading: Promise<Excalidraw> | null = null;

export function loadExcalidraw(): Promise<Excalidraw> {
  loading ??= (async () => {
    (window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSETS;
    const [mod] = await Promise.all([import("@excalidraw/excalidraw"), import("@excalidraw/excalidraw/index.css")]);
    return mod;
  })();
  // A load that failed is tried again the next time a drawing opens.
  loading.catch(() => { loading = null; });
  return loading;
}
