import { useQuery } from "@tanstack/react-query";
import { outline } from "../../lib/note";
import { useWorkspace, type Tab } from "../../workspace/store";
import { noteQuery } from "../viewer/NoteView";

/** Headings of the active note; clicking one scrolls its pane there. */
export function Outline({ tab }: { tab: Tab }) {
  const note = useQuery({ ...noteQuery(tab.ref!), enabled: !!tab.ref });
  const revealLine = useWorkspace((s) => s.revealLine);
  const headings = note.data ? outline(note.data.body) : [];
  if (!headings.length) return <p className="muted pad">No headings.</p>;
  const top = Math.min(...headings.map((h) => h.level));
  return (
    <ul className="outline">
      {headings.map((h) => (
        <li key={h.line} style={{ paddingLeft: (h.level - top) * 12 }}>
          <button onClick={() => revealLine(tab.id, h.line)}>{h.text}</button>
        </li>
      ))}
    </ul>
  );
}
