// TeX math drawn with KaTeX (NS-3A). KaTeX and its stylesheet load on first use, so they stay out of the main bundle.
// Until it has drawn, and when the TeX has errors KaTeX cannot show, the source shows as text.
import { useEffect, useRef } from "react";

type Katex = typeof import("katex").default;
let loading: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => m.default);
  return loading;
}

/** Draw `tex` into `el`. KaTeX's `trust` stays off, so `\href`, `\url` and HTML commands draw as text. */
export function renderMath(el: HTMLElement, tex: string, display: boolean): Promise<void> {
  el.textContent = tex;
  return loadKatex().then(
    (katex) => { katex.render(tex, el, { displayMode: display, throwOnError: false, strict: "ignore", output: "htmlAndMathml" }); },
    () => undefined,
  );
}

/** Math in the reading view: `$...$` inline, `$$...$$` as its own block. The element has no React children: KaTeX
 *  owns what is inside it. */
export function MathView({ tex, display }: { tex: string; display: boolean }) {
  const div = useRef<HTMLDivElement>(null);
  const span = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = display ? div.current : span.current;
    if (el) void renderMath(el, tex, display);
  }, [tex, display]);
  return display ? <div className="math-display" ref={div} /> : <span className="math-inline" ref={span} />;
}
