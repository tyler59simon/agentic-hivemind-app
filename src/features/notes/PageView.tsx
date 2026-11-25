import { openUrl } from "@tauri-apps/plugin-opener";
import { isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MathView } from "../../ui/Math";
import { Mermaid, mermaidSource } from "../../ui/Mermaid";
import { useWorkspace } from "../../workspace/store";
import type { EmbedPage } from "../editor/rich/context";
import { section, splitSize } from "../editor/rich/parse";
import { MATH_MARK, prepare, remarkCallouts, remarkEmbeds, remarkHighlights, WIKI_PICTURE } from "../editor/rich/reading";
import { remarkWikilinks, WIKI_PREFIX } from "../viewer/remarkWikilinks";
import { findFile, pictureUrl } from "./pictures";
import { QueryBlock } from "./QueryView";
import { folderOf } from "../../lib/notebooks";
import { scrollBehavior } from "../../lib/motion";

const PLUGINS = [remarkGfm, remarkEmbeds, remarkWikilinks, remarkHighlights, remarkCallouts];
const keepUrl = (url: string) => (url.startsWith(WIKI_PREFIX) || url.startsWith(WIKI_PICTURE) ? url : defaultUrlTransform(url));

/** Follow a `[[link]]`; `from` is the path of the page it is in when that is an embedded page, so it resolves from that
 *  page's folder (Codex review of 398b956, P2). */
export type Follow = (target: string, split: boolean, from?: string) => void;

/** Where a page's pictures load from: the grant's prefix, the page's folder under it, and the notebook's files (for
 *  `![[picture.png]]`). */
export interface Pictures { base?: string; folder: string; files?: string[] }

/** The page `![[Page]]` names, drawn read-only inside the page. Its own embeds show as links, so a page that embeds
 *  itself shows once. */
function Embed({ target, heading, read, onLink, pictures }: {
  target: string; heading?: string; read: (target: string) => Promise<EmbedPage | null>;
  onLink: Follow; pictures?: Pictures;
}) {
  const [page, setPage] = useState<EmbedPage | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    read(target).then((p) => { if (live) setPage(p); }, () => { if (live) setPage(null); });
    return () => { live = false; };
  }, [target, read]);
  const name = heading ? `${target} › ${heading}` : target;
  const text = page ? section(page.text, heading) : null;
  return (
    <div className="page-embed">
      <div className="page-embed-head">
        <span>{name}</span>
        <button type="button" className="link" onClick={(e) => onLink(target, e.ctrlKey || e.metaKey)}>Open</button>
      </div>
      {page === undefined ? <p className="muted">Loading…</p>
        : !page ? <p className="muted">No page is named {target}.</p>
          : text === null ? <p className="muted">{page.title} has no heading {heading}.</p>
            : <PageView text={text} tabId={`embed-${target}`} onLink={(t, split) => onLink(t, split, page.path)}
              pictures={pictures && { ...pictures, folder: folderOf(page.path) }} nested />}
    </div>
  );
}

/** A Markdown page as it reads. `[[links]]` call `onLink`; web links open in the browser; nothing else navigates the app.
 *  Pictures beside the page load through `hmfile` from `pictures.base` (the grant's prefix), relative to `folder`.
 *  Callouts, highlights, math, picture widths and `![[embeds]]` render as in Live (NS-3A); `embed` reads an embedded
 *  page, and without it an embed shows as a link. */
export function PageView({ text, tabId, onLink, pictures, embed, nested }: {
  text: string; tabId: string; onLink: Follow;
  pictures?: Pictures; embed?: (target: string) => Promise<EmbedPage | null>; nested?: boolean;
}) {
  const reveal = useWorkspace((s) => s.reveal);
  useEffect(() => {
    if (!nested && reveal?.tabId === tabId) document.getElementById(`${tabId}-l${reveal.line}`)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }, [reveal, tabId, nested]);
  const prepared = useMemo(() => prepare(text), [text]);
  // Headings read the line map through a ref, so a text change does not make new component types, which would remount
  // every embed (Codex re-review of fd7109e).
  const sourceLine = useRef(prepared.sourceLine);
  sourceLine.current = prepared.sourceLine;
  const { base, folder = "", files } = pictures ?? {};
  const components = useMemo<Components>(() => {
    const pictures: Pictures = { base, folder, files };
    const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"): Components["h1"] =>
      ({ node, children }) => <Tag id={nested ? undefined : `${tabId}-l${sourceLine.current((node?.position?.start.line ?? 1) - 1)}`}>{children}</Tag>;
    const link = (href: string | undefined, children: ReactNode) => {
      if (href?.startsWith(WIKI_PREFIX)) {
        const target = decodeURIComponent(href.slice(WIKI_PREFIX.length));
        return <a href="#" className="wikilink" onClick={(e) => { e.preventDefault(); onLink(target, e.ctrlKey || e.metaKey); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onLink(target, true); } }}>{children}</a>;
      }
      return <a href={href} onClick={(e) => {
        e.preventDefault();
        if (!href) return;
        if (/^https?:/i.test(href)) openUrl(href).catch(() => undefined);
      }}>{children}</a>;
    };
    return {
      a: ({ href, children }) => link(href, children),
      img: ({ alt, src }) => {
        const raw = typeof src === "string" ? src : undefined;
        const { text: label, width, height } = splitSize(alt ?? "");
        let url: string | null;
        if (raw?.startsWith(WIKI_PICTURE)) {
          const found = findFile(decodeURIComponent(raw.slice(WIKI_PICTURE.length)), pictures?.files ?? []);
          url = found ? pictureUrl(found, pictures?.base, "") : null;
        } else url = pictureUrl(raw, pictures?.base, pictures?.folder ?? "");
        return url
          ? <img src={url} alt={label} loading="lazy" width={width} height={height} />
          : <span className="muted" title={raw}>[{label || "image"}]</span>;
      },
      code: ({ node: _node, className, children, ...rest }) => {
        const source = String(children ?? "");
        if (source.startsWith(MATH_MARK)) return <MathView tex={source.slice(MATH_MARK.length)} display={false} />;
        return <code className={className} {...rest}>{children}</code>;
      },
      pre: ({ node: _node, children, ...rest }) => {
        if (isValidElement<{ className?: string; children?: ReactNode }>(children) && children.props.className?.split(" ").includes("language-math")) {
          return <MathView tex={String(children.props.children ?? "").replace(/\n$/, "")} display />;
        }
        // A ```query block is a saved query (NS-7B), drawn as the table or board it asks for.
        if (isValidElement<{ className?: string; children?: ReactNode }>(children) && children.props.className?.split(" ").includes("language-query")) {
          return <QueryBlock source={String(children.props.children ?? "").replace(/\n$/, "")} />;
        }
        const diagram = mermaidSource(children);
        return diagram === null ? <pre {...rest}>{children}</pre> : <Mermaid source={diagram} />;
      },
      div: ({ node: _node, children, ...rest }) => {
        const props = rest as Record<string, unknown>;
        const target = typeof props["data-embed"] === "string" ? props["data-embed"] : null;
        if (target === null) return <div {...rest}>{children}</div>;
        const heading = (props["data-heading"] as string) || undefined;
        if (!embed || nested) {
          return <p><a href="#" className="wikilink" onClick={(e) => { e.preventDefault(); onLink(target, e.ctrlKey || e.metaKey); }}>{heading ? `${target} › ${heading}` : target}</a></p>;
        }
        return <Embed target={target} heading={heading} read={embed} onLink={onLink} pictures={pictures} />;
      },
      h1: heading("h1"), h2: heading("h2"), h3: heading("h3"), h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
    };
  }, [tabId, onLink, base, folder, files, embed, nested]);
  const body = text.trim()
    ? <Markdown remarkPlugins={PLUGINS} components={components} urlTransform={keepUrl}>{prepared.text}</Markdown>
    : nested ? null : <p className="muted">This page is empty. Press <kbd>Ctrl</kbd>+<kbd>E</kbd> to write.</p>;
  if (nested) return <div className="markdown">{body}</div>;
  return (
    <article className="note page-view doc-column">
      <div className="markdown">{body}</div>
    </article>
  );
}
