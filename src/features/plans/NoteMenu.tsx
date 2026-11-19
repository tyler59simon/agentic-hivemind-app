import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChangesEnabled, useRestoreEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { archiveNote, domainOf, plan, reopenNote, resolveNote, restoreNote, supersedeNote } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { skillFromNote } from "../../lib/skills";
import { openReview } from "../../store";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { useChangeIntent } from "../changes/intent";
import { changesQuery } from "../changes/useChanges";
import { noteQuery } from "../viewer/NoteView";
import { MergeComposer } from "./MergeComposer";
import { NotePicker } from "./NotePicker";
import { DirectDialog } from "./DirectDialog";
import { PlanDialog } from "./PlanDialog";

/** Lifecycle actions for a note. Delete and merge are reviewed Living Memory plans; the rest are direct, journaled writes with Undo. */
export function NoteMenu({ refId }: { refId: string }) {
  const note = useQuery(noteQuery(refId));
  const changesOn = useChangesEnabled();
  const restoreOn = useRestoreEnabled();
  const client = useQueryClient();
  const all = useQuery({ ...changesQuery(), enabled: changesOn });
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const box = useRef<HTMLDivElement>(null);
  const closeTabsOf = (ref: string) => {
    const ws = useWorkspace.getState();
    for (const p of ws.panes) for (const t of p.tabs) if (t.ref === ref) ws.closeTab(p.id, t.id);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);
  const n = note.data;
  if (!n) return null;
  const adoptable = changesOn && n.type === "plan" && n.status === "active" && !(all.data?.changes ?? []).some((c) => c.brief === refId);
  const close = () => setDialog(null);
  const restore = () => {
    setOpen(false);
    restoreNote(refId).then((r) => { recordOperation(r.operation_id); refreshStore(client); toast("Restored. The note is active and pinned."); })
      .catch((e) => toast(classify(e).message, "error"));
  };
  const run = (node: ReactNode) => { setOpen(false); setDialog(node); };
  const items: { label: string; show: boolean; act: () => void; danger?: boolean }[] = [
    { label: "Archive…", show: n.status === "active", act: () => run(
      <DirectDialog title={`Archive “${n.title}”`} run={() => archiveNote(refId)} applyLabel="Archive" done={`Archived “${n.title}”.`} onClose={close}
        intro={<p>The note moves to the archive. It stays searchable with the archived filter and can be restored {restoreOn ? "from its page with Restore" : "by undoing this change"}.</p>} />) },
    { label: "Restore", show: restoreOn && n.status === "archived", act: restore },
    { label: "Resolve bug…", show: n.type === "bug" && n.status === "active", act: () => run(
      <DirectDialog title={`Resolve “${n.title}”`} run={() => resolveNote(refId)} applyLabel="Resolve" done={`Resolved “${n.title}”.`} onClose={close}
        intro={<p>The bug is marked resolved and moves to the archive.</p>} />) },
    { label: "Reopen bug…", show: n.type === "bug" && n.status === "resolved", act: () => run(
      <DirectDialog title={`Reopen “${n.title}”`} run={() => reopenNote(refId)} applyLabel="Reopen" done={`Reopened “${n.title}”.`} onClose={close}
        intro={<p>The bug becomes active again.</p>} />) },
    { label: "Superseded by…", show: n.status === "active", act: () => run(
      <NotePicker title="Which note replaces this one?" domain={n.domain} exclude={refId} onClose={close}
        onPick={(t) => setDialog(<DirectDialog title={`“${t.title}” replaces “${n.title}”`} applyLabel="Supersede" onClose={close}
          run={() => supersedeNote(refId, t.id)} done={`Superseded “${n.title}”.`}
          intro={<p>“{n.title}” is marked superseded and moves to the archive; “{t.title}” records that it replaces it.</p>} />)} />) },
    { label: "Merge into…", show: n.status === "active", act: () => run(
      <NotePicker title="Merge this note into…" domain={n.domain} exclude={refId} onClose={close}
        onPick={(t) => setDialog(<MergeComposer source={{ ref: refId, title: n.title }} target={t} onClose={close} />)} />) },
    { label: "Adopt as change…", show: adoptable, act: () => { setOpen(false); useChangeIntent.getState().open({ mode: "adopt", ref: refId, title: n.title }); } },
    { label: "Make a skill…", show: n.type === "runbook" && n.status === "active", act: () => {
      setOpen(false);
      skillFromNote(refId).then((p) => {
        client.invalidateQueries({ queryKey: ["skills"] });
        toast(`Skill proposal ${p.name} is waiting in Review`, "info", { label: "Open Review", run: () => openReview() });
      }, (e) => toast(classify(e).message, "error"));
    } },
    { label: "Copy reference", show: true, act: () => { setOpen(false); navigator.clipboard.writeText(refId).then(() => toast(`Copied ${refId}`)); } },
    { label: "Delete…", show: true, danger: true, act: () => run(
      <PlanDialog title={`Delete “${n.title}”`} make={() => plan("delete", refId)} applyLabel="Delete" danger onClose={close}
        onApplied={() => closeTabsOf(refId)}
        intro={<p>The note file is removed. The change is journaled, so it can be undone from the Activity view.</p>} />) },
  ];
  return (
    <div className="menu" ref={box}>
      <button className="ghost" aria-label="Note actions" onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <ul className="menu-list" role="menu">
          {items.filter((i) => i.show).map((i) => (
            <li key={i.label}><button role="menuitem" className={i.danger ? "danger-text" : ""} onClick={i.act}>{i.label}</button></li>
          ))}
          <li className="muted small pad">{domainOf(refId)}</li>
        </ul>
      )}
      {dialog}
    </div>
  );
}
