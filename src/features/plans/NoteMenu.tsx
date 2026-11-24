import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useRestoreEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { archiveNote, domainOf, plan, reopenNote, resolveNote, restoreNote, supersedeNote } from "../../lib/lm";
import { resolvable, useNoteTypes } from "../../lib/noteTypes";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { skillFromNote } from "../../lib/skills";
import { openInbox } from "../../store";
import { Menu } from "../../ui/Menu";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { noteQuery } from "../viewer/NoteView";
import { MergeComposer } from "./MergeComposer";
import { NotePicker } from "./NotePicker";
import { DirectDialog } from "./DirectDialog";
import { PlanDialog } from "./PlanDialog";

/** Lifecycle actions for a note. Delete and merge are reviewed Living Memory plans; the rest are direct, journaled writes with Undo. */
export function NoteMenu({ refId, paper }: { refId: string; paper?: { white: boolean; flip: () => void } }) {
  const note = useQuery(noteQuery(refId));
  const restoreOn = useRestoreEnabled();
  const client = useQueryClient();
  const types = useNoteTypes();
  const [dialog, setDialog] = useState<ReactNode>(null);
  const closeTabsOf = (ref: string) => {
    const ws = useWorkspace.getState();
    for (const p of ws.panes) for (const t of p.tabs) if (t.ref === ref) ws.closeTab(p.id, t.id);
  };
  const n = note.data;
  if (!n) return null;
  const canResolve = resolvable(n.type, types.def(n.type));
  const close = () => setDialog(null);
  const restore = () => {
    restoreNote(refId).then((r) => { recordOperation(r.operation_id); refreshStore(client); toast("Restored. The note is active and pinned."); })
      .catch((e) => toast(classify(e).message, "error"));
  };
  const run = (node: ReactNode) => setDialog(node);
  const items: { label: string; show: boolean; act: () => void; danger?: boolean }[] = [
    { label: "Archive…", show: n.status === "active", act: () => run(
      <DirectDialog title={`Archive “${n.title}”`} run={() => archiveNote(refId)} applyLabel="Archive" done={`Archived “${n.title}”.`} onClose={close}
        intro={<p>The note moves to the archive. It stays searchable with the archived filter and can be restored {restoreOn ? "from its page with Restore" : "by undoing this change"}.</p>} />) },
    { label: "Restore", show: restoreOn && n.status === "archived", act: restore },
    { label: `Resolve ${n.type}…`, show: canResolve && n.status === "active", act: () => run(
      <DirectDialog title={`Resolve “${n.title}”`} run={() => resolveNote(refId)} applyLabel="Resolve" done={`Resolved “${n.title}”.`} onClose={close}
        intro={<p>The {n.type} is marked resolved and moves to the archive.</p>} />) },
    { label: `Reopen ${n.type}…`, show: canResolve && n.status === "resolved", act: () => run(
      <DirectDialog title={`Reopen “${n.title}”`} run={() => reopenNote(refId)} applyLabel="Reopen" done={`Reopened “${n.title}”.`} onClose={close}
        intro={<p>The {n.type} becomes active again.</p>} />) },
    { label: "Superseded by…", show: n.status === "active", act: () => run(
      <NotePicker title="Which note replaces this one?" domain={n.domain} exclude={refId} onClose={close}
        onPick={(t) => setDialog(<DirectDialog title={`“${t.title}” replaces “${n.title}”`} applyLabel="Supersede" onClose={close}
          run={() => supersedeNote(refId, t.id)} done={`Superseded “${n.title}”.`}
          intro={<p>“{n.title}” is marked superseded and moves to the archive; “{t.title}” records that it replaces it.</p>} />)} />) },
    { label: "Merge into…", show: n.status === "active", act: () => run(
      <NotePicker title="Merge this note into…" domain={n.domain} exclude={refId} onClose={close}
        onPick={(t) => setDialog(<MergeComposer source={{ ref: refId, title: n.title }} target={t} onClose={close} />)} />) },
    { label: "Make a skill…", show: n.type === "runbook" && n.status === "active", act: () => {
      skillFromNote(refId).then((p) => {
        client.invalidateQueries({ queryKey: ["skills"] });
        toast(`Skill proposal ${p.name} is waiting in the Inbox`, "info", { label: "Open Inbox", run: () => openInbox(undefined, undefined, "skills") });
      }, (e) => toast(classify(e).message, "error"));
    } },
    { label: paper?.white ? "Theme background" : "White background", show: !!paper, act: () => { paper?.flip(); } },
    { label: "Copy reference", show: true, act: () => { navigator.clipboard.writeText(refId).then(() => toast(`Copied ${refId}`)); } },
    { label: "Delete…", show: true, danger: true, act: () => run(
      <PlanDialog title={`Delete “${n.title}”`} make={() => plan("delete", refId)} applyLabel="Delete" danger onClose={close}
        onApplied={() => closeTabsOf(refId)}
        intro={<p>The note file is removed. The change is journaled, so it can be undone from the Activity view.</p>} />) },
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
