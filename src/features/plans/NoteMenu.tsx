import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type ReactNode } from "react";
import { useRestoreEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { archiveNote, deleteNote, domainOf, reopenNote, resolveNote, restoreNote, supersedeNote, type NoteRow, type Receipt } from "../../lib/lm";
import { resolvable, useNoteTypes } from "../../lib/noteTypes";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { skillFromNote } from "../../lib/skills";
import { toastWriteFailure } from "../../lib/stale";
import { openInbox } from "../../store";
import { Menu } from "../../ui/Menu";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { noteQuery } from "../viewer/NoteView";
import { MergeComposer } from "./MergeComposer";
import { NotePicker } from "./NotePicker";
import { SeenDialog, type Seen } from "./DirectDialog";

/** Lifecycle actions for a note: direct, journaled writes, each confirmed in a dialog and undoable from the toast or Activity. */
export function NoteMenu({ refId, paper }: { refId: string; paper?: { white: boolean; flip: () => void } }) {
  const note = useQuery(noteQuery(refId));
  const restoreOn = useRestoreEnabled();
  const client = useQueryClient();
  const types = useNoteTypes();
  const [dialog, setDialog] = useState<ReactNode>(null);
  // The note as the page shows it now, for the supersede dialog the picker opens.
  const shown = useRef(note.data);
  shown.current = note.data;
  const closeTabsOf = (ref: string) => {
    const ws = useWorkspace.getState();
    for (const p of ws.panes) for (const t of p.tabs) if (t.ref === ref) ws.closeTab(p.id, t.id);
  };
  const n = note.data;
  if (!n) return null;
  const canResolve = resolvable(n.type, types.def(n.type));
  const close = () => setDialog(null);
  // Each dialog keeps the note as it was when the dialog opened and writes that revision (Codex review of e30902f, R1).
  const seen = (): Seen => ({ ref: refId, title: n.title, revision: n.revision });
  const restore = () => {
    restoreNote(refId, n.revision).then((r) => { recordOperation(r.operation_id); refreshStore(client); toast("Restored. The note is active and pinned."); })
      .catch((e) => toastWriteFailure(client, e));
  };
  const run = (node: ReactNode) => setDialog(node);
  /** The confirm for one write to this note. */
  const confirm = (applyLabel: string, write: (ref: string, revision: string) => Promise<Receipt>,
    text: (title: string) => { title: string; intro: ReactNode; done: string }, extra: { danger?: boolean; onApplied?: () => void } = {}) =>
    run(<SeenDialog first={[seen()]} applyLabel={applyLabel} onClose={close} {...extra} text={([s]) => text(s.title)} run={([s]) => write(s.ref, s.revision)} />);
  // The successor is written too, with the revision the picker listed it at; a stale refusal reads both notes again.
  const supersede = (t: NoteRow) => {
    const page = shown.current ?? n;
    run(<SeenDialog first={[{ ref: refId, title: page.title, revision: page.revision }, { ref: t.ref, title: t.title, revision: t.revision }]}
      applyLabel="Supersede" onClose={close} run={([s, by]) => supersedeNote(s.ref, s.revision, by)}
      text={([s, by]) => ({ title: `“${by.title}” replaces “${s.title}”`, done: `Superseded “${s.title}”.`,
        intro: <p>“{s.title}” is marked superseded and moves to the archive; “{by.title}” records that it replaces it.</p> })} />);
  };
  const items: { label: string; show: boolean; act: () => void; danger?: boolean }[] = [
    { label: "Archive…", show: n.status === "active", act: () => confirm("Archive", archiveNote, (title) => ({ title: `Archive “${title}”`, done: `Archived “${title}”.`,
      intro: <p>The note moves to the archive. It stays searchable with the archived filter and can be restored {restoreOn ? "from its page with Restore" : "by undoing this change"}.</p> })) },
    { label: "Restore", show: restoreOn && n.status === "archived", act: restore },
    { label: `Resolve ${n.type}…`, show: canResolve && n.status === "active", act: () => confirm("Resolve", resolveNote, (title) => ({ title: `Resolve “${title}”`, done: `Resolved “${title}”.`,
      intro: <p>The {n.type} is marked resolved and moves to the archive.</p> })) },
    { label: `Reopen ${n.type}…`, show: canResolve && n.status === "resolved", act: () => confirm("Reopen", reopenNote, (title) => ({ title: `Reopen “${title}”`, done: `Reopened “${title}”.`,
      intro: <p>The {n.type} becomes active again.</p> })) },
    { label: "Superseded by…", show: n.status === "active", act: () => run(
      <NotePicker title="Which note replaces this one?" domain={n.domain} exclude={refId} onClose={close} onPick={supersede} />) },
    { label: "Merge into…", show: n.status === "active", act: () => run(
      <NotePicker title="Merge this note into…" domain={n.domain} exclude={refId} onClose={close}
        onPick={(t) => setDialog(<MergeComposer source={{ ref: refId, title: n.title }} target={t} onClose={close} />)} />) },
    { label: "Make a skill…", show: n.type === "runbook" && n.status === "active", act: () => {
      skillFromNote(refId).then((p) => {
        client.invalidateQueries({ queryKey: ["skills"] });
        toast(`Skill proposal ${p.name} is waiting in the Inbox. Once approved, the skill stays in sync with this note`, "info", { label: "Open Inbox", run: () => openInbox(undefined, undefined, "skills") });
      }, (e) => toast(classify(e).message, "error"));
    } },
    { label: paper?.white ? "Theme background" : "White background", show: !!paper, act: () => { paper?.flip(); } },
    { label: "Copy reference", show: true, act: () => { navigator.clipboard.writeText(refId).then(() => toast(`Copied ${refId}`)); } },
    { label: "Delete…", show: true, danger: true, act: () => confirm("Delete", deleteNote, (title) => ({ title: `Delete “${title}”`, done: `Deleted “${title}”.`,
      intro: <p>The note file is removed.</p> }), { danger: true, onApplied: () => closeTabsOf(refId) }) },
  ];
  return (
    <>
      {/* The shared Menu, so the note's actions have the same keys as every other menu (DESK-5). */}
      <Menu className="icon-menu" align="right" label="Note actions" button="⋯">
        {(closeMenu) => (
          <>
            {items.filter((i) => i.show).map((i) => (
              <li key={i.label} role="none"><button role="menuitem" className={i.danger ? "danger-text" : ""} onClick={() => { closeMenu(); i.act(); }}>{i.label}</button></li>
            ))}
            <li className="muted small pad" role="none">{domainOf(refId)}</li>
          </>
        )}
      </Menu>
      {dialog}
    </>
  );
}
