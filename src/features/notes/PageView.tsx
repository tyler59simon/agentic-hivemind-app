import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidPre } from "../../ui/Mermaid";
import { useWorkspace } from "../../workspace/store";
import { remarkWikilinks, WIKI_PREFIX } from "../viewer/remarkWikilinks";
import { pictureUrl } from "./pictures";

/** A Markdown page as it reads. `[[links]]` call `onLink`; web links open in the browser; nothing navigates the app.
 *  Pictures beside the page load through `hmfile` from `pictures.base` (the grant's prefix), relative to `folder`. */
export function PageView({ text, tabId, onLink, pictures }: {
  text: string; tabId: string; onLink: (target: string, split: boolean) => void; pictures?: { base?: string; folder: string };
}) {
  const reveal = useWorkspace((s) => s.reveal);
  useEffect(() => {
    if (reveal?.tabId === tabId) document.getElementById(`${tabId}-l${reveal.line}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [reveal, tabId]);
  const components = useMemo<Components>(() => {
    const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"): Components["h1"] =>
      ({ node, children }) => <Tag id={`${tabId}-l${(node?.position?.start.line ?? 1) - 1}`}>{children}</Tag>;
    const link = (href: string | undefined, children: ReactNode) => {
      if (href?.startsWith(WIKI_PREFIX)) {
        const target = decodeURIComponent(href.slice(WIKI_PREFIX.length));
        return <a href="#" className="wikilink" onClick={(e) => { e.preventDefault(); onLink(target, e.ctrlKey || e.metaKey); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onLink(target, true); } }}>{children}</a>;
      }
      return <a href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:/i.test(href)) openUrl(href).catch(() => undefined); }}>{children}</a>;
    };
    return {
      a: ({ href, children }) => link(href, children),
      img: ({ alt, src }) => {
        const url = pictureUrl(typeof src === "string" ? src : undefined, pictures?.base, pictures?.folder ?? "");
        return url ? <img src={url} alt={alt ?? ""} loading="lazy" /> : <span className="muted" title={typeof src === "string" ? src : undefined}>[{alt || "image"}]</span>;
      },
      pre: MermaidPre,
      h1: heading("h1"), h2: heading("h2"), h3: heading("h3"), h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
    };
  }, [tabId, onLink, pictures?.base, pictures?.folder]);
  return (
    <article className="note page-view">
      <div className="markdown">
        {text.trim() ? (
          <Markdown remarkPlugins={[remarkGfm, remarkWikilinks]} components={components}
            urlTransform={(url) => (url.startsWith(WIKI_PREFIX) ? url : defaultUrlTransform(url))}>
            {text}
          </Markdown>
        ) : <p className="muted">This page is empty. Press <kbd>Ctrl</kbd>+<kbd>E</kbd> to write.</p>}
      </div>
    </article>
  );
}
