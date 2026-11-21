// How a rich page draws its embeds (NS-3D): DOM node views, like NS-3B's, never React inside the editor and never an
// iframe. A view reads what it shows (a note, a diagram, a file, a PDF page) and never writes the page by itself: only
// Update on a code range and the choices in the dialogs change attributes. A source that is missing draws a placeholder
// with the stored title, not an error page.
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import type { AnyExtension } from "@tiptap/core";
import { systemDiagram } from "../../../lib/architecture";
import { read as readNote } from "../../../lib/lm";
import { currentTheme, onThemeChange } from "../../../lib/theme";
import { useWorkspace } from "../../../workspace/store";
import { code, darkTheme, lightTheme } from "../../review/CodeDiff";
import { loadLanguage } from "../../review/language";
import { atomView, el, type Make, type ViewEnv } from "../../rich/views";
import { rangeLabel, rangeState, updated, type RangeState } from "./codeRange";
import { EMBED_LABELS, type EmbedType } from "./embeds";
import { drawPage } from "./pdf";

const baseName = (path: string) => path.split("/").pop() ?? path;

type Draw = Parameters<typeof atomView>[0];
/** An embed's view: an atom box that starts clean each time it draws, so a placeholder's mark never outlives the redraw. */
const embedView = (draw: Draw): Make => atomView((box, node, env, props) => {
  box.classList.remove("hm-embed-missing");
  return draw(box, node, env, props);
}, "div", "hm-embed");

/** A box that says what could not be drawn, naming it. */
function placeholder(box: HTMLElement, kind: EmbedType, text: string, extra?: string) {
  box.classList.add("hm-embed-missing");
  box.append(el("div", "hm-embed-kind", EMBED_LABELS[kind]), el("div", "rich-missing", text));
  if (extra) box.append(el("div", "muted small", extra));
}

const caption = (box: HTMLElement, title: string) => { if (title) box.append(el("div", "hm-embed-caption muted", title)); };

/** The first lines of a note's body for its card: no headings and no fenced code, at most four lines of at most 220
 *  characters. */
export function cardLines(body: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) { fenced = !fenced; continue; }
    if (fenced || !line || line.startsWith("#")) continue;
    out.push(line.length > 220 ? `${line.slice(0, 219)}…` : line);
    if (out.length === 4) break;
  }
  return out;
}

// ---- Memory note card ----

const noteCard = embedView((box, node) => {
  const { ref, title } = node.attrs as { ref: string; title: string };
  box.classList.add("hm-notecard");
  const head = el("div", "hm-card-head");
  const name = el("button", "link hm-card-title", title || ref);
  name.type = "button";
  const kind = el("span", "hm-card-kind muted");
  head.append(name, kind);
  const body = el("div", "hm-card-body muted", "Loading…");
  box.append(head, body);
  name.title = "Open this note (Ctrl+click: in a split)";
  name.addEventListener("click", (e) => { e.preventDefault(); useWorkspace.getState().openNote(ref, { title: title || undefined, split: e.ctrlKey || e.metaKey }); });
  let gone = false;
  // A ref that starts with `-` would be an option to the command that reads the note: such a page is never asked about it.
  if (ref.trim().startsWith("-")) {
    box.classList.add("hm-embed-missing");
    body.textContent = "This note reference is not valid.";
    name.disabled = true;
    return;
  }
  readNote(ref).then((note) => {
    if (gone) return;
    name.textContent = note.title;
    kind.textContent = `${note.type} · ${note.status}`;
    body.textContent = "";
    for (const line of cardLines(note.body)) body.append(el("p", "", line));
    if (!body.childElementCount) body.textContent = "This note has no text yet.";
  }, () => {
    if (gone) return;
    box.classList.add("hm-embed-missing");
    body.textContent = "This note is not available: Living Memory is not connected, or the note was removed.";
  });
  return () => { gone = true; };
});

// ---- Architecture diagram ----

const diagram = embedView((box, node) => {
  const { system, path, title } = node.attrs as { system: string; path: string; title: string };
  box.classList.add("hm-diagram");
  const holder = el("div", "hm-diagram-image muted", "Loading the diagram…");
  box.append(holder);
  caption(box, title);
  let gone = false;
  systemDiagram(system, path).then((url) => {
    if (gone) return;
    const img = el("img");
    img.alt = title || `Architecture diagram ${path}`;
    img.draggable = false;
    img.src = url;
    holder.className = "hm-diagram-image";
    holder.replaceChildren(img);
  }, (e) => {
    if (gone) return;
    holder.remove();
    // A diagram the system's manifest no longer lists (W3) is named, not hidden.
    placeholder(box, "diagram", `Diagram not found: ${path} (system ${system})`, e instanceof Error ? e.message : String(e));
  });
  return () => { gone = true; };
});

// ---- Code range ----

const codeRange = embedView((box, node, env, props) => {
  const a = node.attrs as { file: string; from: number; to: number; sha256: string; text: string; title: string };
  box.classList.add("hm-code-range");
  const head = el("div", "hm-embed-head");
  head.append(el("code", "hm-range-label", rangeLabel(a.file, a.from, a.to)));
  if (a.title) head.append(el("span", "muted", a.title));
  const badge = el("span", "hm-range-badge");
  badge.hidden = true;
  const update = el("button", "link", "Update");
  update.type = "button";
  update.hidden = true;
  head.append(el("span", "fill"), badge, update);
  const note = el("div", "muted small");
  note.hidden = true;
  const host = el("div", "hm-range-code");
  box.append(head, note, host);

  const theme = new Compartment();
  const themeNow = () => (currentTheme() === "emerald-light" ? lightTheme : darkTheme);
  const language = new Compartment();
  let view: EditorView | null = null;
  let gone = false;
  const show = (text: string) => {
    view?.destroy();
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers({ formatNumber: (n) => String(n + a.from - 1) }), EditorState.readOnly.of(true), EditorView.editable.of(false),
          language.of([]), syntaxHighlighting(code), theme.of(themeNow()),
        ],
      }),
    });
    loadLanguage(a.file).then((support) => { if (!gone && support) view?.dispatch({ effects: language.reconfigure(support) }); });
  };
  show(a.text);
  const stop = onThemeChange(() => view?.dispatch({ effects: theme.reconfigure(themeNow()) }));

  const apply = (state: RangeState) => {
    if (gone) return;
    if (state.kind === "missing") {
      note.textContent = `${a.file} was not found, so these are the lines stored in the page.`;
      note.hidden = false;
    } else if (state.kind === "past-end") {
      note.textContent = `${a.file} now has ${state.lines} ${state.lines === 1 ? "line" : "lines"}, fewer than this range, so these are the lines stored in the page.`;
      note.hidden = false;
    } else {
      if (state.shown !== a.text) show(state.shown);
      if (state.kind === "changed") {
        badge.textContent = "Changed since embedded";
        badge.hidden = false;
        update.hidden = !props.editor.isEditable;
        update.title = "Store the file's current lines in the page";
        update.onclick = (e) => {
          e.preventDefault();
          const pos = typeof props.getPos === "function" ? props.getPos() : undefined;
          if (pos === undefined || !props.editor.isEditable) return;
          props.editor.view.dispatch(props.editor.state.tr.setNodeMarkup(pos, undefined, updated(node.attrs as typeof a, state.current)));
        };
      }
    }
  };
  const files = env.ctx().notebook;
  if (!files) apply({ kind: "missing" });
  else files.read(a.file).then((file) => apply(rangeState(a, file.binary ? null : file.text)), () => apply({ kind: "missing" }));
  return () => { gone = true; stop(); view?.destroy(); };
});

// ---- PDF page ----

const pdfPage = embedView((box, node, env) => {
  const { file, page, title } = node.attrs as { file: string; page: number; title: string };
  const shown = title || `${baseName(file)}, page ${page}`;
  const url = env.ctx().notebook?.url(file);
  if (!url) { placeholder(box, "pdfPage", `PDF page: ${shown}`, `${file} is not available here.`); return; }
  box.classList.add("hm-pdf");
  const head = el("div", "hm-embed-head", "");
  head.append(el("span", "", shown), el("span", "fill"), el("span", "muted small", file));
  const canvas = el("canvas", "hm-pdf-canvas");
  const status = el("div", "muted small", "The page draws when it scrolls into view.");
  box.append(head, canvas, status);
  let gone = false;
  const draw = () => {
    status.textContent = "Drawing the page…";
    void drawPage(url, page, canvas, box.clientWidth - 2 || 700, () => !gone).then((r) => {
      if (gone) return;
      status.textContent = r.ok ? "" : r.reason;
      if (!r.ok) canvas.hidden = true;
    });
  };
  // A page draws when it scrolls into view, at the pane's width.
  let seen: IntersectionObserver | null = null;
  if (typeof IntersectionObserver === "function") {
    seen = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { seen?.disconnect(); draw(); } });
    seen.observe(box);
  } else draw();
  return () => { gone = true; seen?.disconnect(); };
});

// ---- Gallery ----

/** What a key does in the lightbox of `count` pictures at `index`: arrows move (and stop at the ends), Home and End jump,
 *  Escape closes. `null` when the key is not one the lightbox takes. */
export function lightboxKey(index: number, count: number, key: string): { index: number; open: boolean } | null {
  switch (key) {
    case "ArrowRight": case "ArrowDown": return { index: Math.min(count - 1, index + 1), open: true };
    case "ArrowLeft": case "ArrowUp": return { index: Math.max(0, index - 1), open: true };
    case "Home": return { index: 0, open: true };
    case "End": return { index: count - 1, open: true };
    case "Escape": return { index, open: false };
    default: return null;
  }
}

/** The lightbox over the app: the picture at `index` of `pictures`, with arrows to move and Escape to close. */
export function openLightbox(pictures: { url: string; name: string }[], start: number): () => void {
  let index = start;
  const opener = document.activeElement as HTMLElement | null;
  const root = el("div", "hm-lightbox");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Picture viewer");
  root.tabIndex = -1;
  const img = el("img");
  const label = el("div", "hm-lightbox-label");
  const prev = el("button", "hm-lightbox-prev", "‹");
  const next = el("button", "hm-lightbox-next", "›");
  const close = el("button", "hm-lightbox-close", "×");
  for (const [b, text] of [[prev, "Previous picture"], [next, "Next picture"], [close, "Close"]] as const) { b.type = "button"; b.setAttribute("aria-label", text); b.title = text; }
  root.append(img, label, prev, next, close);
  const draw = () => {
    img.src = pictures[index].url;
    img.alt = pictures[index].name;
    label.textContent = `${index + 1} of ${pictures.length}: ${pictures[index].name}`;
    prev.disabled = index === 0;
    next.disabled = index === pictures.length - 1;
  };
  const shut = () => {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
    opener?.focus?.();
  };
  const go = (key: string) => {
    const r = lightboxKey(index, pictures.length, key);
    if (!r) return false;
    if (!r.open) shut(); else { index = r.index; draw(); }
    return true;
  };
  function onKey(e: KeyboardEvent) {
    if (!go(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
  }
  prev.addEventListener("click", () => go("ArrowLeft"));
  next.addEventListener("click", () => go("ArrowRight"));
  close.addEventListener("click", shut);
  root.addEventListener("mousedown", (e) => { if (e.target === root) shut(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(root);
  draw();
  root.focus();
  return shut;
}

const gallery = embedView((box, node, env) => {
  const { images, columns, title } = node.attrs as { images: string[]; columns: number; title: string };
  const files = env.ctx().notebook;
  if (!files) { placeholder(box, "gallery", `Gallery: ${title || `${images.length} pictures`}`, "Its pictures are not available here."); return; }
  box.classList.add("hm-gallery");
  const grid = el("div", "hm-gallery-grid");
  grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  const loaded = images.map((path) => ({ path, url: files.url(path) }));
  const shown = loaded.filter((p): p is { path: string; url: string } => !!p.url).map((p) => ({ url: p.url, name: baseName(p.path) }));
  loaded.forEach((p) => {
    const cell = el("button", "hm-gallery-item");
    cell.type = "button";
    if (!p.url) { cell.append(el("span", "rich-missing", `Picture not found: ${p.path}`)); cell.disabled = true; grid.append(cell); return; }
    const img = el("img");
    img.src = p.url;
    img.alt = baseName(p.path);
    img.loading = "lazy";
    img.draggable = false;
    img.addEventListener("error", () => { cell.replaceChildren(el("span", "rich-missing", `Picture not found: ${p.path}`)); cell.disabled = true; });
    cell.append(img);
    cell.title = `${baseName(p.path)} (click to enlarge)`;
    cell.addEventListener("click", (e) => { e.preventDefault(); openLightbox(shown, shown.findIndex((s) => s.url === p.url)); });
    grid.append(cell);
  });
  box.append(grid);
  caption(box, title);
});

// ---- Drawing ----

const drawing = embedView((box, node, env, props) => {
  const { preview, scene, title } = node.attrs as { preview: string; scene: string; title: string };
  box.classList.add("hm-drawing-block");
  const url = env.ctx().notebook?.url(preview);
  const edit = el("button", "hm-drawing-edit", "Edit drawing");
  edit.type = "button";
  edit.title = `Edit ${baseName(scene)}`;
  edit.addEventListener("click", (e) => {
    e.preventDefault();
    const pos = typeof props.getPos === "function" ? props.getPos() : undefined;
    if (pos !== undefined && props.editor.isEditable) env.edit(pos);
  });
  if (!url) box.append(el("div", "rich-missing", `Drawing preview not found: ${preview}`));
  else {
    const img = el("img");
    img.src = url;
    img.alt = title || "Drawing";
    img.draggable = false;
    img.addEventListener("error", () => img.replaceWith(el("div", "rich-missing", `Drawing preview not found: ${preview}`)));
    box.append(img);
  }
  caption(box, title);
  if (props.editor.isEditable) box.append(edit);
});

const VIEWS: Record<string, Make> = { noteCard, diagram, codeRange, pdfPage, gallery, excalidraw: drawing };

/** The schema's extensions with the embeds' views, after `withViews` has given NS-3B's nodes theirs. */
export function withEmbedViews(extensions: AnyExtension[], env: ViewEnv): AnyExtension[] {
  return extensions.map((ext) => {
    const make = VIEWS[ext.name];
    if (!make) return ext;
    return (ext as AnyExtension & { extend: (c: object) => AnyExtension }).extend({ addNodeView: () => (props: Parameters<Make>[0]) => make(props, env) });
  });
}
