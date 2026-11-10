import { openUrl } from "@tauri-apps/plugin-opener";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Markdown for summaries and agent text. A link never navigates the app window: web links open in the system browser. */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children: label }) => (
        <a href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:/i.test(href)) openUrl(href).catch(() => undefined); }}>{label}</a>
      ),
    }}>
      {children}
    </ReactMarkdown>
  );
}
