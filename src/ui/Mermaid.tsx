import { openUrl } from "@tauri-apps/plugin-opener";
import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { documentIsDark, onDocumentLook } from "../lib/paper";

/** The diagram source when a Markdown `pre` holds one ```mermaid code block, else null. */
export function mermaidSource(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const { className, children: text } = children.props;
  if (!className?.split(" ").includes("language-mermaid")) return null;
  return String(text ?? "").replace(/\n$/, "");
}

/** Mermaid's own limit (maxTextSize); past it render() draws an error picture instead of failing. */
export const MAX_SOURCE = 50_000;

/** Why a diagram is shown as source without trying to draw it, or null to draw it. Images are refused because
 *  Mermaid waits for them inside its one shared render queue, so a slow server would hold up every diagram. */
export function skipReason(source: string): string | null {
  if (source.length > MAX_SOURCE) return "Diagram is too long to draw.";
  // Errs toward showing source: a plain label with "img:" in it is not drawn either.
  if (/<img\b|\bimg["']?\s*:/i.test(source)) return "Diagrams with images are not drawn.";
  return null;
}

const DIAGRAM_NAMES: Record<string, string> = {
  flowchart: "Flowchart diagram", graph: "Flowchart diagram", sequencediagram: "Sequence diagram", classdiagram: "Class diagram",
  statediagram: "State diagram", erdiagram: "Entity relationship diagram", gantt: "Gantt chart", pie: "Pie chart",
  journey: "User journey diagram", gitgraph: "Git graph", mindmap: "Mind map", timeline: "Timeline",
  requirementdiagram: "Requirement diagram", c4context: "C4 context diagram",
};

/** The kind of diagram, from the first keyword of its source (after front matter and comments): "Flowchart diagram",
 *  "Sequence diagram", and so on. Mermaid's own `%%{init}%%` directives start with %% and are skipped like comments. */
export function diagramName(source: string): string {
  const body = source.replace(/^\s*---\r?\n[\s\S]*?\r?\n---/, "");
  const line = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("%%"));
  const word = line?.match(/^[A-Za-z0-9]+/)?.[0];
  if (!word) return "Diagram";
  const known = DIAGRAM_NAMES[word.toLowerCase()];
  if (known) return known;
  const own = word.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `${own[0].toUpperCase()}${own.slice(1)} diagram`;
}

/** Gives Mermaid's SVG the role and name a screen reader needs: one image. Mermaid names it itself, with aria-labelledby on a
 *  `<title>`, when the source has `accTitle` (and aria-describedby on a `<desc>` for `accDescr`); that name is kept. Without
 *  one the name is the kind of diagram. Mermaid's own role and aria-roledescription ("flowchart-v2") are replaced. */
export function labelDiagram(svg: string, source: string): string {
  const open = svg.match(/^\s*<svg\b[^>]*>/);
  if (!open) return svg;
  let tag = open[0].replace(/\s(?:role|aria-roledescription)="[^"]*"/g, "");
  const named = /\saria-labelledby="/.test(tag);
  tag = tag.replace(/<svg\b/, `<svg role="img"${named ? "" : ` aria-label="${diagramName(source)}"`}`);
  return tag + svg.slice(open[0].length);
}

let nextId = 0;

/** A diagram's SVG, drawn off-screen so Mermaid's scratch SVG, which it measures labels in, never lengthens the page.
 *  The page editor's widgets call it too (NS-3A); callers check `skipReason` first. */
export async function drawMermaid(source: string, dark: boolean, id = `mermaid-${++nextId}`): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", maxTextSize: MAX_SOURCE,
    // Natural width inside the scroll box: a wide flowchart scrolls instead of shrinking its labels.
    flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false }, state: { useMaxWidth: false },
  });
  const box = document.createElement("div");
  // A real width: Gantt charts lay out their timeline from the container's offsetWidth.
  box.style.cssText = "position:fixed;left:-10000px;top:0;width:100vw;visibility:hidden";
  document.body.appendChild(box);
  try { return labelDiagram((await mermaid.render(id, source, box)).svg, source); } finally { box.remove(); }
}

/** Render Mermaid source to SVG, returning the syntax error message on failure (for standalone `.mmd` editing). */
export async function renderMermaid(source: string, dark: boolean): Promise<{ ok: true; svg: string } | { ok: false; error: string }> {
  const skip = skipReason(source);
  if (skip) return { ok: false, error: skip };
  try {
    const svg = await drawMermaid(source, dark);
    return { ok: true, svg };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A diagram link never navigates the app window: web links open in the system browser, others do nothing. */
function onDiagramClick(e: MouseEvent<HTMLDivElement>) {
  diagramClick(e.nativeEvent);
}

/** The same rule for a diagram drawn outside React. */
export function diagramClick(e: Event) {
  const link = (e.target as Element).closest("a");
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute("href") ?? link.getAttribute("xlink:href");
  if (href && /^https?:/i.test(href)) openUrl(href).catch(() => undefined);
}

/** A Mermaid diagram drawn as SVG. The mermaid package loads on first use, so it stays out of the main bundle.
 *  Until it has drawn, and when it cannot be drawn, the source shows as a code block. */
export function Mermaid({ source }: { source: string }) {
  // Dark or light follows the document the diagram is in (a white pane is light under any theme), so the answer waits for
  // the element to be in the page; nothing is drawn before it.
  const root = useRef<HTMLElement | null>(null);
  const mark = (el: HTMLElement | null) => { root.current = el; };
  const [dark, setDark] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const sync = () => setDark(documentIsDark(root.current));
    sync();
    return onDocumentLook(sync);
  }, []);
  const skip = skipReason(source);
  // Each result remembers what it was drawn from, so a changed source never shows the previous picture.
  const [drawn, setDrawn] = useState<{ key: string; svg: string | null }>({ key: "", svg: null });
  const key = `${dark}:${source}`;
  useEffect(() => {
    if (skip || dark === null) return;
    let live = true;
    drawMermaid(source, dark)
      .then((svg) => { if (live) setDrawn({ key, svg }); })
      .catch(() => { if (live) setDrawn({ key, svg: null }); });
    return () => { live = false; };
  }, [key, skip]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = drawn.key === key ? drawn : null;
  if (!skip && current?.svg) {
    return <div className="mermaid-diagram" ref={mark} onClickCapture={onDiagramClick} dangerouslySetInnerHTML={{ __html: current.svg }} />;
  }
  const note = skip ?? (current ? "Diagram did not render." : null);
  return (
    <>
      <pre ref={mark}><code className="language-mermaid">{source}</code></pre>
      {note && <p className="muted">{note}</p>}
    </>
  );
}

/** react-markdown `pre` override: draws ```mermaid blocks and leaves other code blocks as they are. */
export const MermaidPre: Components["pre"] = ({ node: _node, children, ...rest }) => {
  const source = mermaidSource(children);
  return source === null ? <pre {...rest}>{children}</pre> : <Mermaid source={source} />;
};
