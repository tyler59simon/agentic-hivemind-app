// The drawing editor (NS-3D): Excalidraw full screen over the page, with Done and Cancel. Excalidraw is a lazy chunk
// (`excalidrawLoader.ts`); this file holds no import of it but types. Collaboration, library browsing, AI and links to
// excalidraw.com are off, so nothing here reaches the network: its fonts come from Hivemind's own folder.
import { useEffect, useRef, useState } from "react";
import { currentTheme } from "../../../lib/theme";
import { Confirm } from "../../../ui/Modal";
import type { RichContext } from "../../editor/rich/context";
import { commitDrawing, DrawingChanged, loadScene, type Drawing, type LoadedScene } from "./drawing";
import { loadExcalidraw } from "./excalidrawLoader";

type Lib = Awaited<ReturnType<typeof loadExcalidraw>>;
/** The parts of Excalidraw's imperative API this dialog calls. */
interface Api { getSceneElements(): readonly unknown[]; getAppState(): Record<string, unknown>; getFiles(): Record<string, unknown> }

export interface DrawingDialogProps {
  ctx: RichContext;
  /** The drawing being edited, or null for a new one. */
  existing: Drawing | null;
  /** Point the page at the new files; `replaces` is the scene of the block being edited. False when it cannot. */
  apply(next: Drawing, replaces: string | null): boolean;
  stillUsed(preview: string): boolean;
  onClose(): void;
}

type Phase = { name: "loading" } | { name: "ready"; lib: Lib; scene: LoadedScene | null; note: string | null } | { name: "failed"; message: string };

/** A white PNG for a drawing with nothing in it, which Excalidraw's export refuses to draw. */
function blankPng(): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 96;
  const g = canvas.getContext("2d");
  if (g) { g.fillStyle = "#ffffff"; g.fillRect(0, 0, canvas.width, canvas.height); }
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? b.arrayBuffer().then((x) => resolve(new Uint8Array(x)), reject) : reject(new Error("The preview could not be made"))), "image/png"));
}

export function DrawingDialog({ ctx, existing, apply, stillUsed, onClose }: DrawingDialogProps) {
  const [phase, setPhase] = useState<Phase>({ name: "loading" });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ message: string; changed: boolean } | null>(null);
  const [discard, setDiscard] = useState(false);
  const api = useRef<Api | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const first = useRef<string | null>(null);
  const dirty = useRef(false);
  const nb = ctx.notebook;
  const attach = ctx.attachPath;

  useEffect(() => {
    let gone = false;
    (async () => {
      const lib = await loadExcalidraw();
      let scene: LoadedScene | null = null;
      let note: string | null = null;
      if (existing && nb) {
        try { scene = await loadScene(nb, existing.scene); } catch (e) {
          note = `${existing.scene} could not be read (${e instanceof Error ? e.message : String(e)}), so this starts a new drawing.`;
        }
      }
      if (!gone) setPhase({ name: "ready", lib, scene, note });
    })().catch((e) => { if (!gone) setPhase({ name: "failed", message: `The drawing editor could not load (${e instanceof Error ? e.message : String(e)}).` }); });
    return () => { gone = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Links inside Excalidraw (its help, its library) lead to excalidraw.com: none of them opens.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const stop = (e: MouseEvent) => { if ((e.target as HTMLElement | null)?.closest("a[href^='http']")) { e.preventDefault(); e.stopPropagation(); } };
    el.addEventListener("click", stop, true);
    return () => el.removeEventListener("click", stop, true);
  }, [phase.name]);

  if (!nb || !attach) {
    return <Overlay onCancel={onClose}><p className="center muted">This page cannot hold a drawing: its notebook is not a folder notebook.</p></Overlay>;
  }

  const finish = async (asNew: boolean) => {
    if (phase.name !== "ready" || !api.current) return;
    const { lib } = phase;
    const elements = api.current.getSceneElements();
    if (!elements.length && !existing) { onClose(); return; }
    setSaving(true);
    setProblem(null);
    try {
      const state = api.current.getAppState();
      const files = api.current.getFiles();
      const text = lib.serializeAsJSON(elements as never, state as never, files as never, "local");
      const png = elements.length
        ? new Uint8Array(await (await lib.exportToBlob({ elements: elements as never, appState: { ...state, exportBackground: true, exportWithDarkMode: false } as never, files: files as never, mimeType: "image/png", exportPadding: 16 })).arrayBuffer())
        : await blankPng();
      const scene = phase.scene;
      const edit = !asNew && existing && scene ? { ...existing, pre: scene.stamp, format: scene.format } : null;
      const done = await commitDrawing(nb, attach, {
        text, png, current: edit,
        apply: (next) => apply(next, existing?.scene ?? null),
        stillUsed,
      });
      if (!done.applied) ctx.fail("The drawing was saved in the notebook, but the page changed meanwhile, so its block was not updated.");
      else if (done.keptOld) ctx.fail("The drawing was saved, but its earlier preview could not be moved to the trash.");
      onClose();
    } catch (e) {
      setSaving(false);
      if (e instanceof DrawingChanged) setProblem({ message: `${e.message} Saving now would overwrite that change.`, changed: true });
      else setProblem({ message: `The drawing was not saved: ${e instanceof Error ? e.message : String(e)}`, changed: false });
    }
  };

  const cancel = () => (dirty.current ? setDiscard(true) : onClose());
  const dark = currentTheme() !== "emerald-light";
  const ready = phase.name === "ready" ? phase : null;
  return (
    <Overlay onCancel={cancel} onDone={ready && !saving ? () => void finish(false) : undefined} saving={saving}>
      <div className="hm-drawing-body" ref={host}>
        {phase.name === "loading" && <p className="center muted">Loading the drawing editor…</p>}
        {phase.name === "failed" && <p className="center muted">{phase.message}</p>}
        {ready && (
          <>
            {ready.note && <div className="banner note-banner">{ready.note}</div>}
            {problem && (
              <div className="banner error-banner" role="alert">
                {problem.message}
                {problem.changed && <button onClick={() => void finish(true)} disabled={saving}>Save as a new drawing</button>}
              </div>
            )}
            <div className="hm-drawing-canvas">
              <div className="hm-drawing-fill">
              <ready.lib.Excalidraw
                excalidrawAPI={(a) => { api.current = a as unknown as Api; }}
                initialData={ready.scene ? ({ ...(ready.scene.data as object), scrollToContent: true } as never) : null}
                theme={dark ? "dark" : "light"}
                langCode="en"
                name={existing ? existing.scene : "Drawing"}
                aiEnabled={false}
                isCollaborating={false}
                validateEmbeddable={false}
                handleKeyboardGlobally={false}
                UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false }, tools: { image: true } }}
                onChange={(elements) => {
                  const hash = String(ready.lib.hashElementsVersion(elements));
                  if (first.current === null) first.current = hash;
                  else dirty.current = hash !== first.current;
                }}
              >
                <ready.lib.MainMenu>
                  <ready.lib.MainMenu.DefaultItems.ClearCanvas />
                  <ready.lib.MainMenu.DefaultItems.ChangeCanvasBackground />
                </ready.lib.MainMenu>
              </ready.lib.Excalidraw>
              </div>
            </div>
          </>
        )}
      </div>
      {discard && (
        <Confirm title="Discard this drawing?" message="The changes made in this drawing are not saved." action="Discard" danger
          onAnswer={(yes) => { setDiscard(false); if (yes) onClose(); }} />
      )}
    </Overlay>
  );
}

/** The full-screen frame: a title, Done and Cancel above the editor. */
function Overlay({ children, onCancel, onDone, saving }: { children: React.ReactNode; onCancel: () => void; onDone?: () => void; saving?: boolean }) {
  return (
    <div className="hm-drawing" data-own-zoom role="dialog" aria-label="Drawing">
      <header className="hm-drawing-head">
        <strong>Drawing</strong>
        <span className="fill" />
        <button onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="primary" onClick={onDone} disabled={!onDone}>{saving ? "Saving…" : "Done"}</button>
      </header>
      {children}
    </div>
  );
}
