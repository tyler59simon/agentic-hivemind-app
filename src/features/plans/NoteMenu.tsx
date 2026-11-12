import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChangesEnabled } from "../../lib/connection";
import { domainOf, mergePlan, plan, read, type Note, type NoteRow } from "../../lib/lm";
import { sections } from "../../lib/note";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { useChangeIntent } from "../changes/intent";
import { changesQuery } from "../changes/useChanges";
import { noteQuery } from "../viewer/NoteView";
import { NotePicker } from "./NotePicker";
import { PlanDialog } from "./PlanDialog";

/** Merge into another note: the target keeps its ID; this note is superseded and archived. */
function MergeComposer({ source, target, onClose }: { source: Note; target: NoteRow; onClose: () => void }) {
  const [body, setBody] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    read(target.ref).then((t) => {
      const summary = sections(source.body).summary ?? source.title;
      setBody(`${t.body}\n\n## Merged from ${source.title}\n${summary}`);
    }).catch((e) => toast(String(e), "error"));
  }, [source, target.ref]);
  if (ready && body !== null) {
    return (
      <PlanDialog title={`Merge into “${target.title}”`} make={() => mergePlan({ target: target.ref, sources: [`${source.domain}:${source.id}`], body })}
        applyLabel="Merge" onClose={onClose} />
    );
  }
  return (
    <Modal title={`Merge into “${target.title}”`} onClose={onClose} wide>
      <p>The merged note keeps “{target.title}”. “{source.title}” is marked superseded and moves to the archive. Edit the merged text, then review the plan.</p>
      {body === null ? <p className="muted">Loading…</p> : <textarea className="merge-body" value={body} onChange={(e) => setBody(e.target.value)} />}
      <div className="actions"><button onClick={onClose}>Cancel</button><button className="primary" disabled={body === null} onClick={() => setReady(true)}>Review plan…</button></div>
    </Modal>
  );
}

/** Lifecycle actions for a note. Every one is a reviewed Living Memory plan. */
export function NoteMenu({ refId }: { refId: string }) {
  const note = useQuery(noteQuery(refId));
  const changesOn = useChangesEnabled();
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
  const run = (node: ReactNode) => { setOpen(false); setDialog(node); };
  const items: { label: string; show: boolean; act: () => void; danger?: boolean }[] = [
    { label: "Archive…", show: n.status === "active", act: () => run(
      <PlanDialog title={`Archive “${n.title}”`} make={() => plan("archive", refId)} applyLabel="Archive" onClose={close}
        intro={<p>The note moves to the archive. It stays searchable with the archived filter and can be restored by undoing this change.</p>} />) },
    { label: "Resolve bug…", show: n.type === "bug" && n.status === "active", act: () => run(
      <PlanDialog title={`Resolve “${n.title}”`} make={() => plan("resolve", refId)} applyLabel="Resolve" onClose={close} />) },
    { label: "Reopen bug…", show: n.type === "bug" && n.status === "resolved", act: () => run(
      <PlanDialog title={`Reopen “${n.title}”`} make={() => plan("reopen", refId)} applyLabel="Reopen" onClose={close} />) },
    { label: "Superseded by…", show: n.status === "active", act: () => run(
      <NotePicker title="Which note replaces this one?" domain={n.domain} exclude={refId} onClose={close}
        onPick={(t) => setDialog(<PlanDialog title={`“${t.title}” replaces “${n.title}”`} applyLabel="Supersede" onClose={close}
          make={() => plan("supersede", refId, { superseded_by: t.id })}
          intro={<p>“{n.title}” is marked superseded and moves to the archive; “{t.title}” records that it replaces it.</p>} />)} />) },
    { label: "Merge into…", show: n.status === "active", act: () => run(
      <NotePicker title="Merge this note into…" domain={n.domain} exclude={refId} onClose={close}
        onPick={(t) => setDialog(<MergeComposer source={n} target={t} onClose={close} />)} />) },
    { label: "Adopt as change…", show: adoptable, act: () => { setOpen(false); useChangeIntent.getState().open({ mode: "adopt", ref: refId, title: n.title }); } },
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
