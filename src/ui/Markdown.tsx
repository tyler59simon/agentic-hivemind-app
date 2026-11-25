import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { webImageNote } from "../lib/webImage";
import { MermaidPre } from "./Mermaid";

/** Markdown for summaries and agent text. A link never navigates the app window: web links open in the system
 *  browser, and only links within the text itself (footnotes) are followed in place. No picture is drawn: a web picture
 *  is never loaded (REG-30), react-markdown drops `data:` addresses, and a path has no folder to be read from here. */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      // `node` is react-markdown's syntax node, not an attribute; the rest (a footnote's id and labels) passes through.
      a: ({ node: _node, href, children: label, ...rest }) => (
        <a {...rest} href={href} onClick={(e) => {
          if (href?.startsWith("#")) return;
          e.preventDefault();
          if (href && /^https?:/i.test(href)) openUrl(href).catch(() => undefined);
        }}>{label}</a>
      ),
      pre: MermaidPre,
      img: ({ src, alt }) => {
        const raw = typeof src === "string" ? src : "";
        const note = webImageNote(raw);
        return <span className="muted" title={raw}>[{alt || "image"}]{note ? ` ${note}` : ""}</span>;
      },
    }}>
      {children}
    </ReactMarkdown>
  );
}
