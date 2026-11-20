import { openUrl } from "@tauri-apps/plugin-opener";
import { isValidElement, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { useTheme } from "../lib/theme";

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
  if (/<img\b|\bimg\s*:/i.test(source)) return "Diagrams with images are not drawn.";
  return null;
}

let nextId = 0;

/** Draw off-screen so Mermaid's scratch SVG, which it measures labels in, never lengthens the page. */
async function draw(id: string, source: string, dark: boolean): Promise<string> {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default", maxTextSize: MAX_SOURCE,
    // Natural width inside the scroll box: a wide flowchart scrolls instead of shrinking its labels.
    flowchart: { useMaxWidth: false }, sequence: { useMaxWidth: false }, state: { useMaxWidth: false },
  });
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden";
  document.body.appendChild(box);
  try { return (await mermaid.render(id, source, box)).svg; } finally { box.remove(); }
}

/** A diagram link never navigates the app window: web links open in the system browser, others do nothing. */
function onDiagramClick(e: MouseEvent<HTMLDivElement>) {
  const link = (e.target as Element).closest("a");
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute("href") ?? link.getAttribute("xlink:href");
  if (href && /^https?:/i.test(href)) openUrl(href).catch(() => undefined);
}

/** A Mermaid diagram drawn as SVG. The mermaid package loads on first use, so it stays out of the main bundle.
 *  Until it has drawn, and when it cannot be drawn, the source shows as a code block. */
export function Mermaid({ source }: { source: string }) {
  const dark = useTheme() !== "emerald-light";
  const skip = skipReason(source);
  // Each result remembers what it was drawn from, so a changed source never shows the previous picture.
  const [drawn, setDrawn] = useState<{ key: string; svg: string | null }>({ key: "", svg: null });
  const key = `${dark}:${source}`;
  useEffect(() => {
    if (skip) return;
    let live = true;
    draw(`mermaid-${++nextId}`, source, dark)
      .then((svg) => { if (live) setDrawn({ key, svg }); })
      .catch(() => { if (live) setDrawn({ key, svg: null }); });
    return () => { live = false; };
  }, [key, skip]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = drawn.key === key ? drawn : null;
  if (!skip && current?.svg) {
    return <div className="mermaid-diagram" onClickCapture={onDiagramClick} dangerouslySetInnerHTML={{ __html: current.svg }} />;
  }
  const note = skip ?? (current ? "Diagram did not render." : null);
  return (
    <>
      <pre><code className="language-mermaid">{source}</code></pre>
      {note && <p className="muted">{note}</p>}
    </>
  );
}

/** react-markdown `pre` override: draws ```mermaid blocks and leaves other code blocks as they are. */
export const MermaidPre: Components["pre"] = ({ node: _node, children, ...rest }) => {
  const source = mermaidSource(children);
  return source === null ? <pre {...rest}>{children}</pre> : <Mermaid source={source} />;
};
