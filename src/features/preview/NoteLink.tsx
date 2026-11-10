import type { NoteRow } from "../../lib/lm";
import { useWorkspace } from "../../workspace/store";
import { HoverPreview } from "./HoverPreview";

/** A note's title as a link: opens it as a tab (Ctrl+click in the other pane) and previews it on hover. */
export function NoteLink({ row }: { row: Pick<NoteRow, "ref" | "title"> }) {
  return (
    <HoverPreview refId={row.ref}>
      <button className="link-row" onClick={(e) => useWorkspace.getState().openNote(row.ref, { title: row.title, split: e.ctrlKey || e.metaKey })}>{row.title}</button>
    </HoverPreview>
  );
}
