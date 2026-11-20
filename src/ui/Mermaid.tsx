import { isValidElement, useEffect, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { useTheme } from "../lib/theme";

/** The diagram source when a Markdown `pre` holds one ```mermaid code block, else null. */
export function mermaidSource(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const { className, children: text } = children.props;
  if (!className?.split(" ").includes("language-mermaid")) return null;
  return String(text ?? "").replace(/\n$/, "");
}

let nextId = 0;

/** A Mermaid diagram drawn as SVG. The mermaid package loads on first use, so it stays out of the main bundle.
 *  Until it has drawn, and when the source does not parse, the source shows as a code block. */
export function Mermaid({ source }: { source: string }) {
  const dark = useTheme() !== "emerald-light";
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const id = `mermaid-${++nextId}`;
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const out = await mermaid.render(id, source);
        if (live) { setSvg(out.svg); setFailed(false); }
      })
      .catch(() => {
        document.getElementById(`d${id}`)?.remove();   // the scratch element mermaid may leave behind on an error
        if (live) { setSvg(null); setFailed(true); }
      });
    return () => { live = false; };
  }, [source, dark]);
  if (svg) return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <>
      <pre><code className="language-mermaid">{source}</code></pre>
      {failed && <p className="muted">Diagram did not render.</p>}
    </>
  );
}

/** react-markdown `pre` override: draws ```mermaid blocks and leaves other code blocks as they are. */
export const MermaidPre: Components["pre"] = ({ node: _node, children, ...rest }) => {
  const source = mermaidSource(children);
  return source === null ? <pre {...rest}>{children}</pre> : <Mermaid source={source} />;
};
