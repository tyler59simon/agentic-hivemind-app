// The Tags pane of the Notes navigator (NS-4A): every `#tag` and frontmatter tag of the folder notebooks' pages, with how
// many pages use it. A tag opens the search panel filtered to it.
import { useQuery } from "@tanstack/react-query";
import { Hash } from "lucide-react";
import { tagsQuery } from "../../lib/noteindex";
import { useNotesSearch } from "../search/store";

export function TagsPane() {
  const tags = useQuery(tagsQuery());
  const byTag = useNotesSearch((s) => s.byTag);
  const list = tags.data ?? [];
  if (!list.length) return null;
  return (
    <details className="notebook-group tags-pane">
      <summary><Hash size="1em" aria-hidden /> Tags <span className="muted small">{list.length}</span></summary>
      <ul className="tag-list">
        {list.map((t) => (
          <li key={t.tag}>
            <button className="link-row" title={`Pages tagged #${t.tag}`} onClick={() => byTag(t.tag)}>#{t.tag} <span className="muted small">{t.count}</span></button>
          </li>
        ))}
      </ul>
    </details>
  );
}
