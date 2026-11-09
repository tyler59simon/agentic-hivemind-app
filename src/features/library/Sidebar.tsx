import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { domains, list, NOTE_TYPES, type NoteRow } from "../../lib/lm";
import { useApp } from "../../store";

export function Sidebar() {
  const { domain, shelf, selected, setDomain, setShelf, open } = useApp();
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const notes = useQuery({
    queryKey: ["list", domain, shelf],
    queryFn: () => list({ domain: domain!, status: shelf === "active" ? "active" : "any" }),
    enabled: !!domain,
    select: (page) => ({ ...page, notes: shelf === "active" ? page.notes : page.notes.filter((n) => n.status !== "active") }),
  });
  const groups = useMemo(() => {
    const byType = new Map<string, NoteRow[]>();
    for (const note of notes.data?.notes ?? []) byType.set(note.type, [...(byType.get(note.type) ?? []), note]);
    return NOTE_TYPES.filter((t) => byType.has(t)).map((t) => [t, byType.get(t)!] as const);
  }, [notes.data]);

  return (
    <aside className="sidebar">
      <select className="domain-select" value={domain ?? ""} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
        {!domain && <option value="">Choose a domain…</option>}
        {known.data?.domains.map((d) => (
          <option key={d.name} value={d.name}>{d.name} ({d.active})</option>
        ))}
      </select>
      <div className="segmented" role="tablist">
        {(["active", "archived"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={shelf === s} className={shelf === s ? "on" : ""} onClick={() => setShelf(s)}>
            {s === "active" ? "Active" : "Archive"}
          </button>
        ))}
      </div>
      {notes.isLoading && <p className="muted pad">Loading…</p>}
      {notes.error && <p className="error pad">{String(notes.error)}</p>}
      {notes.data && !notes.data.notes.length && <p className="muted pad">No notes here.</p>}
      <nav className="tree">
        {groups.map(([type, rows]) => (
          <details key={type} open>
            <summary><span className={`badge type-${type}`}>{type}</span> <span className="muted">{rows.length}</span></summary>
            {rows.map((n) => (
              <button key={n.ref} className={`tree-item ${selected === n.ref ? "on" : ""}`} onClick={() => open(n.ref)} title={n.title}>
                {n.title}
                {n.status !== "active" && <span className="muted"> · {n.status}</span>}
              </button>
            ))}
          </details>
        ))}
      </nav>
    </aside>
  );
}
