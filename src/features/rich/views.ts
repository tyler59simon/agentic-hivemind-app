// How the Rich editor draws what has no plain HTML form (NS-3B): pictures and embeds through the page's
// `RichContext` (the same grant and embed drawing as Live), links that open with Ctrl+click, KaTeX math, footnote
// references with their text as a tooltip, callouts with a type chip, code blocks with a language field and a
// Mermaid preview, and source boxes edited in a small CodeMirror. Views never change the document by themselves.
import { markdown } from "@codemirror/lang-markdown";
import { EditorView as CodeView, keymap as cmKeymap } from "@codemirror/view";
import type { AnyExtension, Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import { currentTheme } from "../../lib/theme";
import { renderMath } from "../../ui/Math";
import { diagramClick, drawMermaid, skipReason } from "../../ui/Mermaid";
import type { RichContext } from "../editor/rich/context";
import { CALLOUT_TYPES, parseCallout, parseEmbed, section } from "../editor/rich/parse";

/** What the views need from the editor around them. */
export interface ViewEnv {
  ctx(): RichContext;
  /** Open the editing popover for the atom at `pos`. */
  edit(pos: number): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export type View = { dom: HTMLElement; contentDOM?: HTMLElement; update?(node: PMNode): boolean; destroy?(): void; stopEvent?(e: Event): boolean; ignoreMutation?(m: unknown): boolean; selectNode?(): void; deselectNode?(): void };
export type Make = (props: NodeViewRendererProps, env: ViewEnv) => View;

const posOf = (props: NodeViewRendererProps) => (typeof props.getPos === "function" ? props.getPos() : undefined);

/** An atom drawn by `draw` and redrawn when its attributes change; double-click edits it. */
export function atomView(draw: (box: HTMLElement, node: PMNode, env: ViewEnv, props: NodeViewRendererProps) => (() => void) | void, tag: "span" | "div", cls: string): Make {
  return (props, env) => {
    const box = el(tag, `${cls} rich-atom`);
    box.contentEditable = "false";
    let node = props.node;
    let cleanup = draw(box, node, env, props) ?? undefined;
    box.addEventListener("dblclick", (e) => {
      const pos = posOf(props);
      if (pos === undefined || !props.editor.isEditable) return;
      e.preventDefault();
      env.edit(pos);
    });
    return {
      dom: box,
      update(next) {
        if (next.type !== node.type) return false;
        if (JSON.stringify(next.attrs) === JSON.stringify(node.attrs)) { node = next; return true; }
        node = next;
        cleanup?.();
        box.textContent = "";
        cleanup = draw(box, node, env, props) ?? undefined;
        return true;
      },
      destroy() { cleanup?.(); },
      selectNode() { box.classList.add("rich-selected"); },
      deselectNode() { box.classList.remove("rich-selected"); },
      // Clicks on buttons inside an atom are the atom's own.
      stopEvent: (e) => e.target instanceof HTMLElement && !!e.target.closest("button, input, textarea, a[href], .cm-editor"),
      ignoreMutation: () => true,
    };
  };
}

function picture(box: HTMLElement, src: string, alt: string, wiki: boolean, width: number | undefined, env: ViewEnv) {
  const url = env.ctx().pictureUrl(src, wiki);
  if (!url) { box.append(el("span", "rich-missing", `Picture: ${alt || src}`)); return; }
  const img = el("img");
  img.src = url;
  img.alt = alt;
  img.draggable = false;
  if (width) img.style.width = `${width}px`;
  img.addEventListener("error", () => { box.textContent = ""; box.append(el("span", "rich-missing", `Picture not found: ${src}`)); });
  box.append(img);
}

const image = atomView((box, node, env) => {
  const m = /^(.*?)\|\s*(\d+)(?:x\d+)?\s*$/.exec(node.attrs.alt);
  picture(box, node.attrs.src, m ? m[1] : node.attrs.alt, false, m ? Number(m[2]) : undefined, env);
}, "span", "rich-image");

const embed = atomView((box, node, env) => {
  const e = parseEmbed(`![[${node.attrs.value}]]`);
  if (!e) { box.append(el("span", "rich-missing", `![[${node.attrs.value}]]`)); return; }
  if (e.kind === "picture") { picture(box, e.src, e.alt, true, e.width, env); return; }
  const ctx = env.ctx();
  box.classList.add("rich-embed-page");
  const head = el("div", "rich-embed-head");
  const open = el("button", "link", "Open");
  open.type = "button";
  open.title = `Open ${e.target} (Ctrl+click: in a split)`;
  open.addEventListener("click", (ev) => { ev.preventDefault(); ctx.openPage(e.target, ev.ctrlKey || ev.metaKey); });
  head.append(el("span", "rich-embed-title", e.heading ? `${e.target} › ${e.heading}` : e.target), open);
  const body = el("div", "rich-embed-body markdown", "Loading…");
  box.append(head, body);
  let gone = false;
  let remove: (() => void) | undefined;
  ctx.readEmbed(e.target).then((page) => {
    if (gone) return;
    if (!page) { body.textContent = `No page is named ${e.target}.`; return; }
    const text = section(page.text, e.heading);
    if (text === null) { body.textContent = `${page.title} has no heading ${e.heading}.`; return; }
    body.textContent = "";
    remove = ctx.renderEmbed(body, { ...page, text }, e.target);
  }, () => { if (!gone) body.textContent = `${e.target} could not be read.`; });
  return () => { gone = true; remove?.(); };
}, "span", "rich-embed");

/** `[[target#heading|alias]]`: the alias (or the target) shown as a link. */
export function wikiParts(value: string) {
  // In a table cell the pipe is written `\|` (R1-6).
  const pipe = value.indexOf("|");
  const target = (pipe >= 0 ? value.slice(0, pipe) : value).replace(/\\$/, "").trim();
  const alias = pipe >= 0 ? value.slice(pipe + 1).trim() : "";
  return { target, shown: alias || target };
}

const wikiLink = atomView((box, node, env) => {
  const { target, shown } = wikiParts(node.attrs.value);
  box.textContent = shown;
  box.title = `${target} (Ctrl+click to open, Ctrl+Shift+click in a split)`;
  const open = (e: MouseEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    env.ctx().openPage(target.replace(/#.*$/, "") || target, e.shiftKey);
  };
  box.addEventListener("mousedown", open);
  // A redraw for a new target removes this one's listener (Codex review of 2392f6b, R1-13).
  return () => box.removeEventListener("mousedown", open);
}, "span", "rich-wikilink");

const math = (display: boolean) => atomView((box, node) => {
  const tex = display ? node.attrs.value.trim() : node.attrs.value;
  if (!tex) { box.append(el("span", "rich-missing", display ? "Empty math block" : "Empty math")); return; }
  void renderMath(box, tex, display);
}, display ? "div" : "span", display ? "rich-math-block" : "rich-math");

const footnoteRef = atomView((box, node, _env, props) => {
  const id = node.attrs.identifier as string;
  box.textContent = node.attrs.label ?? id;
  // The tooltip is the definition's text, looked up when the pointer arrives.
  box.addEventListener("mouseenter", () => {
    let text = "";
    props.editor.state.doc.descendants((n) => {
      if (text) return false;
      if (n.type.name === "footnoteDef" && n.attrs.identifier === id) { text = n.textContent; return false; }
      return true;
    });
    box.title = text || `No footnote [^${node.attrs.label ?? id}] on this page`;
  });
}, "span", "rich-fnref");

const RAW_LABELS: Record<string, string> = { html: "HTML", definition: "Link definition", frontmatter: "Properties", block: "Markdown source", comment: "Comment", reference: "Reference link" };

const rawInline = atomView((box, node) => {
  box.textContent = node.attrs.value;
  box.title = `${RAW_LABELS[node.attrs.kind] ?? "Source"}: double-click to edit`;
  if (node.attrs.kind === "comment") box.classList.add("rich-comment");
}, "span", "rich-raw-inline");

/** A source box: the block's Markdown in a small CodeMirror. Typing there updates the node; the box never writes to
 *  the document unless its text changed. */
const rawBlock: Make = (props, _env) => {
  const box = el("div", "rich-raw");
  box.contentEditable = "false";
  let node = props.node;
  const label = el("div", "rich-raw-label", RAW_LABELS[node.attrs.kind] ?? "Markdown source");
  const host = el("div", "rich-raw-code");
  box.append(label, host);
  let updating = false;
  const code = new CodeView({
    doc: node.attrs.value,
    parent: host,
    extensions: [
      markdown(), CodeView.lineWrapping,
      CodeView.editable.of(props.editor.isEditable),
      cmKeymap.of([{ key: "Escape", run: () => { props.editor.commands.focus(); return true; } }]),
      CodeView.updateListener.of((u) => {
        if (!u.docChanged || updating || !props.editor.isEditable) return;
        const pos = posOf(props);
        if (pos === undefined) return;
        const value = u.state.doc.toString();
        const { tr } = props.editor.state;
        props.editor.view.dispatch(tr.setNodeMarkup(pos, undefined, { ...node.attrs, value, original: null }));
      }),
    ],
  });
  return {
    dom: box,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      if (next.attrs.value !== code.state.doc.toString()) {
        updating = true;
        code.dispatch({ changes: { from: 0, to: code.state.doc.length, insert: next.attrs.value } });
        updating = false;
      }
      return true;
    },
    destroy() { code.destroy(); },
    selectNode() { box.classList.add("rich-selected"); },
    deselectNode() { box.classList.remove("rich-selected"); },
    stopEvent: (e) => host.contains(e.target as globalThis.Node),
    ignoreMutation: () => true,
  };
};

const CALLOUT_ICON: Record<string, string> = {
  note: "✎", abstract: "≡", info: "i", todo: "☐", tip: "✦", success: "✓", question: "?", warning: "!",
  failure: "✕", danger: "‼", bug: "✱", example: "☰", quote: "❝",
};

/** Icons a rich page's callout can show in place of its type's own. */
const CALLOUT_PICK = ["★", "♥", "→", "⚑", "☀", "✦", "✱", "☰"];

/** A callout: its type chip opens a menu of types and folding; the title and body are edited in place. */
const callout: Make = (props) => {
  let node = props.node;
  const box = el("div", "rich-callout callout");
  const chip = el("button", "rich-callout-chip");
  chip.type = "button";
  chip.contentEditable = "false";
  const content = el("div", "rich-callout-content");
  box.append(chip, content);
  const draw = () => {
    const c = parseCallout(`> ${node.attrs.marker}`);
    const type = c?.type ?? "note";
    box.className = `rich-callout callout callout-${type}`;
    chip.textContent = `${node.attrs.icon || CALLOUT_ICON[type] || "✎"} ${c?.label ?? type}${c?.fold === "-" ? " ▸" : c?.fold === "+" ? " ▾" : ""}`;
    chip.title = "Callout type and folding";
  };
  draw();
  const menu = el("div", "rich-callout-menu menu");
  menu.hidden = true;
  chip.addEventListener("mousedown", (e) => e.preventDefault());
  chip.addEventListener("click", () => {
    if (!props.editor.isEditable) return;
    menu.hidden = !menu.hidden;
  });
  const set = (marker: string) => {
    menu.hidden = true;
    const pos = posOf(props);
    if (pos === undefined || !props.editor.isEditable) return;
    props.editor.view.dispatch(props.editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, marker }));
  };
  for (const t of CALLOUT_TYPES) {
    const b = el("button", "", `${CALLOUT_ICON[t]} ${t}`);
    b.type = "button";
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      const fold = /\]([+-]?)$/.exec(node.attrs.marker)?.[1] ?? "";
      set(`[!${t}]${fold}`);
    });
    menu.append(b);
  }
  for (const [fold, name] of [["", "Not foldable"], ["+", "Foldable, open"], ["-", "Foldable, closed"]] as const) {
    const b = el("button", "", name);
    b.type = "button";
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => set(node.attrs.marker.replace(/\]([+-]?)$/, `]${fold}`)));
    menu.append(b);
  }
  // A rich page (NS-3C) lets a callout carry an icon of its own: the choices follow the folding ones.
  if (props.node.type.spec.attrs && "icon" in props.node.type.spec.attrs) {
    for (const icon of [null, ...CALLOUT_PICK]) {
      const b = el("button", "", icon ?? "Type's own icon");
      b.type = "button";
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        menu.hidden = true;
        const pos = posOf(props);
        if (pos === undefined || !props.editor.isEditable) return;
        props.editor.view.dispatch(props.editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, icon }));
      });
      menu.append(b);
    }
  }
  box.append(menu);
  return {
    dom: box,
    contentDOM: content,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      draw();
      return true;
    },
    stopEvent: (e) => chip.contains(e.target as globalThis.Node) || menu.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => !content.contains((m as MutationRecord).target),
  };
};

/** A code block with its language in a field above it, and for `mermaid` the diagram below it. */
const codeBlock: Make = (props) => {
  let node = props.node;
  const box = el("div", "rich-code");
  const bar = el("div", "rich-code-bar");
  bar.contentEditable = "false";
  const lang = el("input", "rich-code-lang");
  lang.placeholder = "language";
  lang.spellcheck = false;
  lang.setAttribute("aria-label", "Code language");
  lang.value = node.attrs.language ?? "";
  lang.readOnly = !props.editor.isEditable;
  lang.addEventListener("change", () => {
    const pos = posOf(props);
    if (pos === undefined || !props.editor.isEditable) return;
    const language = lang.value.trim() || null;
    if (language === (node.attrs.language ?? null)) return;
    props.editor.view.dispatch(props.editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language }));
  });
  lang.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lang.blur(); props.editor.commands.focus(); } });
  bar.append(lang);
  const pre = el("pre");
  const code = el("code");
  pre.append(code);
  const preview = el("div", "rich-mermaid");
  preview.contentEditable = "false";
  preview.addEventListener("click", diagramClick, true);
  box.append(bar, pre, preview);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let drawn = "";
  const draw = () => {
    const isMermaid = (node.attrs.language ?? "").toLowerCase() === "mermaid";
    preview.hidden = !isMermaid;
    if (!isMermaid) return;
    const source = node.textContent;
    if (source === drawn) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      drawn = source;
      const skip = skipReason(source);
      if (skip) { preview.textContent = skip; return; }
      drawMermaid(source, currentTheme() !== "emerald-light").then((svg) => { if (drawn === source) preview.innerHTML = svg; }, () => { preview.textContent = "Diagram did not render."; });
    }, drawn ? 500 : 0);
  };
  draw();
  return {
    dom: box,
    contentDOM: code,
    update(next) {
      if (next.type !== node.type) return false;
      node = next;
      if (document.activeElement !== lang) lang.value = node.attrs.language ?? "";
      draw();
      return true;
    },
    destroy() { clearTimeout(timer); },
    stopEvent: (e) => bar.contains(e.target as globalThis.Node) || preview.contains(e.target as globalThis.Node),
    ignoreMutation: (m) => !code.contains((m as MutationRecord).target),
  };
};

const VIEWS: Record<string, Make> = {
  image, embed, wikiLink, mathInline: math(false), mathBlock: math(true), footnoteRef, rawInline, rawBlock, callout, codeBlock,
};

/** The schema's extensions with their views. */
export function withViews(extensions: AnyExtension[], env: ViewEnv): AnyExtension[] {
  return extensions.map((ext) => {
    const make = VIEWS[ext.name];
    if (!make) return ext;
    return (ext as AnyExtension & { extend: (c: object) => AnyExtension }).extend({ addNodeView: () => (props: NodeViewRendererProps) => make(props, env) });
  });
}

/** Select the atom at `pos` (used after inserting one). */
export function selectAt(editor: Editor, pos: number) {
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}
