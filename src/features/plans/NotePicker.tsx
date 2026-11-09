import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { list, type NoteRow } from "../../lib/lm";
import { fuzzy } from "../../lib/text";
import { Modal } from "../../ui/Modal";

/** Choose another active note in a domain (for supersede and merge). */
export function NotePicker({ title, domain, exclude, onPick, onClose }: {
  title: string; domain: string; exclude: string; onPick: (n: NoteRow) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const notes = useQuery({ queryKey: ["list", domain, "active"], queryFn: () => list({ domain, status: "active" }) });
  const shown = useMemo(() => (notes.data?.notes ?? [])
    .filter((n) => n.ref !== exclude)
    .map((n) => ({ n, s: fuzzy(query, n.title) }))
    .filter((x) => x.s !== null)
    .sort((a, b) => b.s! - a.s!)
    .slice(0, 40), [notes.data, query, exclude]);
  return (
    <Modal title={title} onClose={onClose}>
      <input autoFocus value={query} placeholder="Find a note…" onChange={(e) => setQuery(e.target.value)} />
      <ul className="pick-list">
        {shown.map(({ n }) => (
          <li key={n.ref}><button onClick={() => onPick(n)}><span>{n.title}</span><span className={`badge type-${n.type}`}>{n.type}</span></button></li>
        ))}
        {notes.data && !shown.length && <li className="muted pad">No matching notes.</li>}
      </ul>
    </Modal>
  );
}
