// Pick a file of the board's notebook to put on it (NS-7C): a page, a picture or a PDF. Dragging a page from the tree does
// the same; this is for keyboard use and for pictures and PDFs, which the tree hands to their own program on a click.
import { useMemo, useState } from "react";
import { Modal } from "../../ui/Modal";

const LIMIT = 60;

export function FilePicker({ files, onPick, onClose }: { files: string[]; onPick: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => !q || f.toLowerCase().includes(q)).slice(0, LIMIT);
  }, [files, query]);
  return (
    <Modal title="Add a file to the board" onClose={onClose}>
      {files.length === 0
        ? <p className="muted">This board has no notebook files to add.</p>
        : (
          <>
            <input autoFocus aria-label="Search files" placeholder="Search this notebook's files" value={query} onChange={(e) => setQuery(e.target.value)} />
            {shown.length === 0 && <p className="muted">No file matches.</p>}
            <ul className="plain-list hm-pick-list" aria-label="Files">
              {shown.map((f) => <li key={f}><button className="link-row" onClick={() => onPick(f)}>{f}</button></li>)}
            </ul>
          </>
        )}
      <div className="actions"><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
