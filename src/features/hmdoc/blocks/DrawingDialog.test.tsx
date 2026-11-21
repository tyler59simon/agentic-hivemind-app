// @vitest-environment jsdom
// NS-3D: the drawing editor around Excalidraw, which is mocked (jsdom cannot run it): the props that keep it off the
// network, and the Done and Cancel flows against mocked file commands.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Loaded, SaveOutcome } from "../../../lib/notebooks";
import type { RichContext } from "../../editor/rich/context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const fake = vi.hoisted(() => ({ props: null as Record<string, unknown> | null, elements: [] as unknown[], serialize: null as unknown, exportBlob: null as unknown }));
vi.mock("./excalidrawLoader", async () => {
  const React = await import("react");
  const h = React.createElement;
  const api = { getSceneElements: () => fake.elements, getAppState: () => ({ viewBackgroundColor: "#ffffff", exportWithDarkMode: true }), getFiles: () => ({}) };
  return {
    loadExcalidraw: async () => ({
      Excalidraw: (props: Record<string, unknown>) => {
        fake.props = props;
        (props.excalidrawAPI as (a: unknown) => void)(api);
        return h("div", { "data-testid": "excalidraw" }, h("a", { href: "https://libraries.excalidraw.com", id: "outside" }, "Browse libraries"));
      },
      MainMenu: Object.assign((p: { children?: unknown }) => h("div", null, p.children as never), { DefaultItems: { ClearCanvas: () => null, ChangeCanvasBackground: () => null } }),
      serializeAsJSON: (...args: unknown[]) => (fake.serialize as (...a: unknown[]) => string)(...args),
      exportToBlob: (...args: unknown[]) => (fake.exportBlob as (...a: unknown[]) => Promise<Blob>)(...args),
      hashElementsVersion: (els: unknown[]) => els.length,
    }),
  };
});

const { DrawingDialog } = await import("./DrawingDialog");

const FORMAT = { encoding: "utf-8", bom: false, eol: "lf" as const };
const stamp = { sha256: "a".repeat(64), size: 10, mtimeMs: 5 };
const loaded = (text: string) => ({ text, ...stamp, format: FORMAT, readOnly: null, binary: false }) as Loaded;

let root: Root | null = null;
let el: HTMLElement;
beforeEach(() => {
  fake.props = null;
  fake.elements = [];
  fake.serialize = vi.fn(() => "{scene json}");
  // jsdom's Blob has no arrayBuffer().
  fake.exportBlob = vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
  el = document.createElement("div");
  document.body.append(el);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

function setup(over: Partial<NonNullable<RichContext["notebook"]>> = {}, withNotebook = true) {
  const log: string[] = [];
  const notebook = withNotebook ? {
    files: [], url: () => null,
    read: vi.fn(async () => loaded('{"type":"excalidraw","elements":[{"id":"a"}],"appState":{"viewBackgroundColor":"#eee"},"files":{}}')),
    create: vi.fn(async (path: string) => { log.push(`create ${path}`); return stamp; }),
    save: vi.fn(async (path: string): Promise<SaveOutcome> => { log.push(`save ${path}`); return { status: "saved", ...stamp }; }),
    trash: vi.fn(async (path: string) => { log.push(`trash ${path}`); }),
    ...over,
  } : undefined;
  // The attach path never replaces a file: the second `Sketch.png` is `Sketch 1.png`.
  const attachPath = vi.fn(async (_bytes: Uint8Array, name: string) => { log.push(`attach ${name}`); return `attachments/${name === "Sketch.png" ? "Sketch 1.png" : name}`; });
  const ctx = { pictureUrl: () => null, readEmbed: async () => null, renderEmbed: () => () => {}, openPage: vi.fn(), openHref: vi.fn(), fail: vi.fn(), notebook, attachPath: withNotebook ? attachPath : undefined } as unknown as RichContext;
  const apply = vi.fn((_next: unknown, _replaces: string | null) => true);
  const onClose = vi.fn();
  return { log, notebook, attachPath, ctx, apply, onClose };
}

async function mount(s: ReturnType<typeof setup>, existing: { scene: string; preview: string } | null = null) {
  root = createRoot(el);
  await act(async () => root!.render(<DrawingDialog ctx={s.ctx} existing={existing} apply={s.apply} stillUsed={() => false} onClose={s.onClose} />));
  // The editor and the scene load asynchronously.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const click = async (b: Element | undefined) => { await act(async () => { (b as HTMLElement).click(); await new Promise((r) => setTimeout(r, 0)); }); };

describe("what Excalidraw is given", () => {
  it("has collaboration, AI, web embeds, loading, saving and exporting off, and the library and its links hidden or blocked", async () => {
    await mount(setup());
    const p = fake.props!;
    expect(p.aiEnabled).toBe(false);
    expect(p.isCollaborating).toBe(false);
    expect(p.validateEmbeddable).toBe(false);
    expect(p.handleKeyboardGlobally).toBe(false);
    expect(p.UIOptions).toEqual({ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false }, tools: { image: true } });
    expect(p).not.toHaveProperty("libraryReturnUrl");
    expect(p).not.toHaveProperty("onLibraryChange");
    expect(p).not.toHaveProperty("renderTopRightUI");
    // A link inside Excalidraw never navigates.
    const link = el.querySelector("#outside") as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("starts empty for a new drawing and with the scene for an edited one", async () => {
    await mount(setup());
    expect(fake.props!.initialData).toBeNull();
    await act(async () => root?.unmount());
    root = null;
    await mount(setup(), { scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch.png" });
    expect(fake.props!.initialData).toMatchObject({ type: "excalidraw", elements: [{ id: "a" }], appState: { viewBackgroundColor: "#eee" }, scrollToContent: true });
  });
});

describe("a new drawing", () => {
  it("Done attaches the preview and creates the scene, points the page at them and closes", async () => {
    const s = setup();
    await mount(s);
    fake.elements = [{ id: "e1" }];
    await click(button("Done"));
    expect(s.log).toHaveLength(2);
    expect(s.log[0]).toMatch(/^attach Drawing \d{8}-\d{6}\.png$/);
    expect(s.log[1]).toMatch(/^create attachments\/Drawing \d{8}-\d{6}\.excalidraw$/);
    expect(s.notebook!.create).toHaveBeenCalledWith(expect.stringMatching(/\.excalidraw$/), "{scene json}");
    const bytes = s.attachPath.mock.calls[0][0];
    expect([...bytes]).toEqual([1, 2, 3]);
    // The preview is exported on a white background, never dark.
    expect((fake.exportBlob as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ mimeType: "image/png", appState: { exportBackground: true, exportWithDarkMode: false } });
    expect(s.apply).toHaveBeenCalledTimes(1);
    expect(s.apply.mock.calls[0][0]).toMatchObject({ scene: expect.stringMatching(/\.excalidraw$/), preview: expect.stringMatching(/\.png$/) });
    expect(s.apply.mock.calls[0][1]).toBeNull();
    expect(s.onClose).toHaveBeenCalled();
  });

  it("Done with nothing drawn closes without writing anything", async () => {
    const s = setup();
    await mount(s);
    await click(button("Done"));
    expect(s.log).toEqual([]);
    expect(s.apply).not.toHaveBeenCalled();
    expect(s.onClose).toHaveBeenCalled();
  });

  it("Cancel closes without writing; with changes it asks first", async () => {
    const s = setup();
    await mount(s);
    await click(button("Cancel"));
    expect(s.onClose).toHaveBeenCalledTimes(1);
    expect(s.log).toEqual([]);
    // Drawn on, Cancel asks.
    await act(async () => root?.unmount());
    root = null;
    const s2 = setup();
    await mount(s2);
    await act(async () => { (fake.props!.onChange as (e: unknown[]) => void)([]); });
    await act(async () => { (fake.props!.onChange as (e: unknown[]) => void)([{ id: "new" }]); });
    await click(button("Cancel"));
    expect(s2.onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Discard this drawing?");
    await click(button("Discard"));
    expect(s2.onClose).toHaveBeenCalled();
    expect(s2.log).toEqual([]);
  });

  it("a page that is not in a folder notebook cannot hold a drawing", async () => {
    const s = setup({}, false);
    await mount(s);
    expect(el.textContent).toContain("not a folder notebook");
    expect(button("Done")!.disabled).toBe(true);
  });
});

describe("an edited drawing", () => {
  const existing = { scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch.png" };

  it("Done saves the scene against the hash it was read with, attaches the new preview, points the page at it and trashes the old one", async () => {
    const s = setup();
    await mount(s, existing);
    fake.elements = [{ id: "a" }, { id: "b" }];
    await click(button("Done"));
    expect(s.log).toEqual(["attach Sketch.png", "save attachments/Sketch.excalidraw", "trash attachments/Sketch.png"]);
    expect(s.notebook!.save).toHaveBeenCalledWith("attachments/Sketch.excalidraw", "{scene json}", stamp, FORMAT);
    expect(s.notebook!.create).not.toHaveBeenCalled();
    expect(s.apply).toHaveBeenCalledWith({ scene: "attachments/Sketch.excalidraw", preview: "attachments/Sketch 1.png" }, "attachments/Sketch.excalidraw");
    expect(s.onClose).toHaveBeenCalled();
  });

  it("a scene that changed on disk is not overwritten: the dialog stays open and offers a new drawing", async () => {
    const s = setup({ save: vi.fn(async (): Promise<SaveOutcome> => ({ status: "stale", sha256: "b".repeat(64) })) });
    await mount(s, existing);
    fake.elements = [{ id: "a" }];
    await click(button("Done"));
    expect(s.onClose).not.toHaveBeenCalled();
    expect(s.apply).not.toHaveBeenCalled();
    expect(el.querySelector("[role=alert]")!.textContent).toContain("changed on disk");
    expect(button("Save as a new drawing")).toBeTruthy();
    await click(button("Save as a new drawing"));
    expect(s.notebook!.create).toHaveBeenCalledWith(expect.stringMatching(/^attachments\/Drawing .*\.excalidraw$/), "{scene json}");
    expect(s.apply).toHaveBeenCalledWith(expect.objectContaining({ scene: expect.stringMatching(/^attachments\/Drawing/) }), "attachments/Sketch.excalidraw");
    expect(s.onClose).toHaveBeenCalled();
  });

  it("a scene that cannot be read starts a new drawing in its place, and says so", async () => {
    const s = setup({ read: vi.fn(async () => { throw new Error("no such file"); }) });
    await mount(s, existing);
    expect(el.textContent).toContain("could not be read");
    expect(fake.props!.initialData).toBeNull();
    fake.elements = [{ id: "a" }];
    await click(button("Done"));
    expect(s.notebook!.save).not.toHaveBeenCalled();
    expect(s.notebook!.create).toHaveBeenCalled();
    expect(s.apply).toHaveBeenCalledWith(expect.anything(), "attachments/Sketch.excalidraw");
    // The old preview belongs to a scene that is not there to compare: it is left alone.
    expect(s.notebook!.trash).not.toHaveBeenCalled();
  });

  it("an error from the file commands is shown and keeps the dialog open", async () => {
    const s = setup({ save: vi.fn(async () => { throw new Error("disk full"); }) });
    await mount(s, existing);
    fake.elements = [{ id: "a" }];
    await click(button("Done"));
    expect(el.querySelector("[role=alert]")!.textContent).toContain("disk full");
    expect(s.onClose).not.toHaveBeenCalled();
    expect(button("Save as a new drawing")).toBeUndefined();
    // The new preview that was attached for it is trashed again.
    expect(s.log).toEqual(["attach Sketch.png", "trash attachments/Sketch 1.png"]);
  });
});
