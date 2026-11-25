// The page rail's Related section for a page of a folder notebook (NS-4B): the five pages nearest in meaning, from the
// vectors in Hivemind's index, and the three memory notes Living Memory finds for the page's title and its first words.
import { useQuery } from "@tanstack/react-query";
import type { FileRef } from "../../documents/keys";
import { search } from "../../lib/lm";
import { relatedQuery } from "../../lib/noteindex";
import { useApp } from "../../store";
import { isRelatedNote } from "../search/groups";
import { SemanticHint } from "../search/SemanticHint";
import { openPage } from "../notes/actions";
import { openMemoryNote } from "./follow";

const MEMORY_NOTES = 3;

export function RelatedPages({ file }: { file: FileRef }) {
  const domain = useApp((s) => s.domain);
  const related = useQuery(relatedQuery(file.notebook, file.path));
  const words = related.data?.query.trim() ?? "";
  const notes = useQuery({
    queryKey: ["search", domain, words, "related"],
    queryFn: () => search({ query: words, domain: domain!, scope: "fallback", limit: MEMORY_NOTES }),
    enabled: !!domain && words.length > 0,
  });
  if (related.isLoading) return <p className="muted pad">Loading…</p>;
  const pages = related.data?.pages ?? [];
  // Living Memory fills the list up with notes that match nothing; only the near ones are related.
  const memory = (notes.data?.results ?? []).filter(isRelatedNote).slice(0, MEMORY_NOTES);
  const state = related.data?.meaning ?? "off";
  return (
    <div className="links-panel">
      <section className="links-section">
        <h3>Pages <span className="muted">{pages.length}</span></h3>
        {pages.map((p) => (
          <button key={`${p.notebook}:${p.path}`} className="back-row" title={p.path}
            onClick={(e) => openPage({ notebook: p.notebook, path: p.path }, { split: e.ctrlKey || e.metaKey })}>
            <span className="back-title">{p.title}{p.notebook !== file.notebook && <span className="muted small"> · {p.path}</span>}</span>
            {p.snippet && <span className="back-context muted small">{p.snippet}</span>}
          </button>
        ))}
        {state === "ready" && !pages.length && <p className="muted small">No page is close enough in meaning to this one.</p>}
        <SemanticHint state={state} />
      </section>
      <section className="links-section">
        <h3>Memory notes <span className="muted">{memory.length}</span></h3>
        {memory.map((n) => (
          <button key={n.id} className="back-row" title={n.title}
            onClick={(e) => openMemoryNote({ ref: n.id, title: n.title, domain: n.domain }, e.ctrlKey || e.metaKey)}>
            <span className="back-title">{n.title}</span>
            {n.snippet && <span className="back-context muted small">{n.snippet}</span>}
          </button>
        ))}
        {!memory.length && !notes.isLoading && <p className="muted small">{domain ? "No memory note comes close to this page." : "Pick a memory domain to see related memory notes."}</p>}
      </section>
    </div>
  );
}
