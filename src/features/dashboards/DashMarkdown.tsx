import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NoteLinks } from "../links/useLinks";
import { remarkWikilinks, WIKI_PREFIX } from "../viewer/remarkWikilinks";
import { WikiLink } from "../viewer/NoteView";

/** Markdown for a dashboard's detail, sections and callout. [[Note]] links open the note in Memory (resolved through
 *  the dashboard note's own links); web links open in the system browser. `inline` drops the paragraph wrapper and
 *  shows [[links]] as plain chips, for text inside a button. */
export function DashMarkdown({ children, links, inline }: { children: string; links: NoteLinks | null; inline?: boolean }) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children: label }) => {
      if (href?.startsWith(WIKI_PREFIX)) {
        return inline ? <span className="chip">{label}</span>
          : <WikiLink target={decodeURIComponent(href.slice(WIKI_PREFIX.length))} links={links}>{label}</WikiLink>;
      }
      return <a href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:/i.test(href)) openUrl(href).catch(() => undefined); }}>{label}</a>;
    },
    ...(inline ? { p: ({ children: c }) => <>{c}</> } : {}),
  }), [links, inline]);
  return (
    <Markdown remarkPlugins={[remarkGfm, remarkWikilinks]} components={components}
      urlTransform={(url) => (url.startsWith(WIKI_PREFIX) ? url : defaultUrlTransform(url))}>
      {children}
    </Markdown>
  );
}
