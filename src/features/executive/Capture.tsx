// Quick capture (paste anything, Hivemind extracts what is worth keeping) and the review of a capture batch. Nothing reaches
// Living Memory or an existing record until the user accepts an item; replacing an existing note asks once more.
import { useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { classify } from "../../lib/errors";
import { extract, ITEM_KINDS, listRecords, putRecord, type CaptureBatch, type CaptureItem, type ItemKind, type Milestone } from "../../lib/executive";
import { addAction, capture, read, type Project } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { writeFailure } from "../../lib/stale";
import { setLeaveGuard, useApp } from "../../store";
import { Confirm, Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { NoteLink } from "../preview/NoteLink";
import { acceptKey, acceptWrite, blocked, hasAction, KIND_LABEL, pendingItems, planWrite, replaceable, type Context, type Write } from "./items";
import { isoToday } from "./commitments";
import { useNotes, useRecords, useStoreFacts } from "./useExecutive";

const KEPT_KEY = "hivemind.executive.capture";
const kept = () => { try { return localStorage.getItem(KEPT_KEY) ?? ""; } catch { return ""; } };
const keep = (text: string) => { try { localStorage.setItem(KEPT_KEY, text); } catch { /* not kept */ } };

/** The universal input: meeting notes, a conversation, a document, loose thoughts. */
export function CaptureDialog({ projects, project, onClose }: { projects: Project[]; project?: Project; onClose: () => void }) {
  const client = useQueryClient();
  const [text, setText] = useState(kept);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState(project?.slug ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const batch = await extract(text, scope || null, label.trim() || undefined);
      keep("");
      if (batch) client.setQueryData<CaptureBatch[]>(["executive", "capture"], (prev) => [batch, ...(prev ?? []).filter((b) => b.id !== batch.id)]);
      onClose();
      if (!batch) toast("Nothing worth keeping was found in that text.");
      else useApp.getState().go({ page: "home", capture: batch.id });
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="Capture" onClose={onClose} wide locked={busy}>
      <div className="exec-form" onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && !busy) { e.preventDefault(); run(); } }}>
        <p className="muted small">Paste meeting notes, a conversation or a document, or type what is on your mind. Hivemind pulls out decisions, commitments, risks, status, milestones and facts worth keeping. You review each one before anything is saved.</p>
        <textarea className="exec-capture-text" autoFocus rows={14} value={text} placeholder="Notes from the platform sync: we agreed to..." disabled={busy}
          onChange={(e) => { setText(e.target.value); keep(e.target.value); }} />
        <div className="exec-row">
          <label className="field grow"><span>Where it is from</span><input value={label} placeholder="Platform sync, 19 Nov" onChange={(e) => setLabel(e.target.value)} disabled={busy} /></label>
          <label className="field"><span>Project</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={busy}>
              <option value="">Decide per item</option>
              {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={run} disabled={busy || !text.trim()} title="Ctrl+Enter">
            {busy ? <><LoaderCircle className="spin" size="1em" aria-hidden /> Reading</> : <><Sparkles size="1em" aria-hidden /> Extract</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** What planning a write needs from the store. Items with no project go to the first project's domain. */
export function useWriteContext(projects: Project[], sourceLabel: string): Context & { ready: boolean } {
  const { rows } = useNotes();
  const facts = useStoreFacts();
  return {
    projects, known: facts.known, rows: rows.data?.notes ?? [], defaultDomain: projects[0]?.charter?.split(":")[0] || facts.defaultDomain,
    globalDomain: facts.globalDomain, sourceLabel, today: isoToday(),
    // Planning before the notes arrive would miss an existing commitments note and start a second one.
    ready: rows.isSuccess && facts.ready,
  };
}

/** Run one planned write. Returns what was written: a note ref or `milestone:<id>`, and the operation. Safe to repeat for a
 *  keyed write (`acceptKey`): a milestone with that id is kept as it is, Living Memory answers a keyed note with the first
 *  one, and an action item the note already has is not added again. */
/** Run a write. `retry` says it repeats a recorded write that may already have run, so an action item already there counts. */
export async function perform(write: Write, anyway?: boolean, retry?: boolean): Promise<{ ref: string; operation?: string }> {
  if (write.kind === "milestone") {
    const id = write.record.id;
    if (id && (await listRecords<Milestone>("milestone")).some((m) => m.id === id)) return { ref: `milestone:${id}` };
    return { ref: `milestone:${(await putRecord<Milestone>("milestone", write.record)).id}` };
  }
  if (write.kind === "action" && retry && hasAction((await read(write.ref)).body, write.text)) return { ref: write.ref };
  // An action write recorded before writes carried revisions has none: Living Memory refuses it, and the accept is planned again.
  const r = write.kind === "action" ? await addAction(write.ref, write.text, write.revision ?? "") : await capture(write.domain, anyway ? { ...write.payload, allow_similar: true } : write.payload);
  recordOperation(r.operation_id);
  return { ref: write.kind === "action" ? write.ref : `${r.domain ?? write.domain}:${r.id}`, operation: r.operation_id };
}

type Choice = "new" | string;

function ItemCard({ item, projects, ctx, onChange, onAccept, onReject, onRetrySave, busy, problem, unsaved }: {
  item: CaptureItem; projects: Project[]; ctx: Context & { ready: boolean }; busy: boolean; problem?: string;
  /** Written to memory, but the batch did not record it: only saving the batch is left. */
  unsaved: boolean;
  onChange: (next: CaptureItem) => void; onAccept: (replace?: string, anyway?: boolean) => void; onReject: () => void; onRetrySave: () => void;
}) {
  const [picked, setChoice] = useState<Choice>("new");
  // Only a note the item would really replace: same domain, a note kind. A changed kind or project drops a stale choice.
  const noteMatches = item.similar.filter((s) => !s.ref.startsWith("milestone:") && replaceable(item, s.ref, ctx));
  const choice = noteMatches.some((s) => s.ref === picked) ? picked : "new";
  const why = blocked(item);
  const set = (patch: Partial<CaptureItem>) => onChange({ ...item, ...patch });
  const dated = item.kind === "commitment" || item.kind === "milestone";
  const done = item.state !== "pending" || unsaved;
  // An accept that started earlier is finished as it was planned; the fields stay as they were until the user starts over.
  const resuming = !done && !!item.intent && !busy;
  // Fields are fixed while any write runs too, so what is recorded as accepted is what was written.
  const fixed = done || !!item.intent || busy;
  // A milestone keeps its id, so starting over could not change one an earlier accept already saved.
  const restartable = resuming && (item.intent?.write as Write | undefined)?.kind !== "milestone";
  return (
    <article className={`exec-item ${done ? `done ${item.state}` : ""}`}>
      <div className="exec-row">
        <select aria-label="Kind" value={item.kind} disabled={fixed} onChange={(e) => set({ kind: e.target.value as ItemKind })}>
          {ITEM_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="Project" value={item.project ?? ""} disabled={fixed} onChange={(e) => set({ project: e.target.value || null })}>
          <option value="">No project</option>
          {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
        <span className={`status-chip ${item.confidence === "high" ? "ok" : item.confidence === "medium" ? "next" : "warn"}`} title="How plainly the text states it">{item.confidence} confidence</span>
        {done && <span className={`status-chip ${item.state === "accepted" ? "ok" : ""}`}>{item.state}</span>}
      </div>
      <input className="exec-title" aria-label="Title" value={item.title} disabled={fixed} onChange={(e) => set({ title: e.target.value })} />
      <textarea aria-label="Summary" rows={2} value={item.summary} disabled={fixed} onChange={(e) => set({ summary: e.target.value })} />
      {dated && (
        <div className="exec-row">
          {item.kind === "commitment" && <label className="field grow"><span>Owner</span><input value={item.owner} disabled={fixed} onChange={(e) => set({ owner: e.target.value })} /></label>}
          <label className="field"><span>Due</span><input type="date" value={item.due} disabled={fixed} onChange={(e) => set({ due: e.target.value })} /></label>
        </div>
      )}
      {item.kind === "commitment" && !item.owner.trim() && !done && <p className="muted small">No owner was named. Add one, or it is saved without.</p>}
      {item.quote && <blockquote className="exec-quote">{item.quote}</blockquote>}
      {resuming && (
        <p className="muted small">
          An earlier accept of this item did not finish. Accept finishes it with the text it had then.
          {restartable && <>{" "}<button className="link small" onClick={() => onChange({ ...item, intent: undefined })} disabled={busy}>Start over</button> to change it first.</>}
        </p>
      )}
      {!fixed && noteMatches.length > 0 && (
        <fieldset className="exec-similar">
          <legend>This may repeat an existing note</legend>
          <label className="check"><input type="radio" checked={choice === "new"} onChange={() => setChoice("new")} /> Save as a new note</label>
          {noteMatches.map((s) => (
            <label key={s.ref} className="check"><input type="radio" checked={choice === s.ref} onChange={() => setChoice(s.ref)} /> Replace <NoteLink row={s} /></label>
          ))}
        </fieldset>
      )}
      {!done && item.similar.some((s) => s.ref.startsWith("milestone:")) && <p className="muted small">A milestone with a similar name exists: {item.similar[0].title}.</p>}
      {problem && <p className="error small">{problem}</p>}
      {!done && why && item.title.trim() && <p className="muted small">{why}</p>}
      {item.result?.ref && !item.result.ref.startsWith("milestone:") && <p className="small">Saved as <NoteLink row={{ ref: item.result.ref, title: item.title }} /></p>}
      {unsaved && (
        <div className="actions">
          <button className="primary" onClick={onRetrySave} disabled={busy}><Check size="1em" aria-hidden /> Retry save</button>
        </div>
      )}
      {!done && (
        <div className="actions">
          <button onClick={onReject} disabled={busy}><X size="1em" aria-hidden /> Skip</button>
          {problem?.startsWith("A similar note") && <button onClick={() => onAccept(undefined, true)} disabled={busy || !!why || !ctx.ready}>Save anyway</button>}
          <button className="primary" onClick={() => onAccept(choice === "new" ? undefined : choice)} disabled={busy || !!why || !ctx.ready} title={ctx.ready ? undefined : "Loading your notes"}>
            <Check size="1em" aria-hidden /> {choice === "new" ? "Accept" : "Accept and replace"}
          </button>
        </div>
      )}
    </article>
  );
}

/** Review one capture batch: edit, accept or skip each item. */
export function ReviewDialog({ id, projects, onClose }: { id: string; projects: Project[]; onClose: () => void }) {
  const client = useQueryClient();
  const batches = useRecords<CaptureBatch>("capture");
  const stored = batches.data?.find((b) => b.id === id);
  const live = useWriteContext(projects, stored?.source.label ?? "");
  // The capture's own date, not today's: a retried accept on another day must write the same note body (its idempotency key
  // only matches the same content).
  const ctx = stored ? { ...live, today: isoToday(new Date(stored.created)) } : live;
  const [edits, setEditState] = useState<Record<string, CaptureItem>>({});
  // Saves read the latest edits, not the ones of the render that started them.
  const latest = useRef(edits);
  const setEdits = (f: (e: Record<string, CaptureItem>) => Record<string, CaptureItem>) => { latest.current = f(latest.current); setEditState(latest.current); };
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  // Items written to memory whose batch save failed, with the state to save.
  const [unsaved, setUnsaved] = useState<Record<string, CaptureItem>>({});
  const [closing, setClosing] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  // Closing loses what only this dialog knows: which items memory has but the batch does not.
  const close = () => { leave.current = null; if (Object.keys(unsaved).length) setClosing(true); else onClose(); };
  const [replacing, setReplacing] = useState<{ item: CaptureItem; ref: string } | null>(null);
  const [showText, setShowText] = useState(false);
  // Back (Alt+Left), the palette and the page shortcuts leave through the same check as Close: not while an item is being
  // written, and not past unrecorded accepts without the confirm, which then finishes the move that was stopped.
  const now = useRef({ busy: false, unsaved: 0 });
  now.current = { busy: !!busy, unsaved: Object.keys(unsaved).length };
  const leave = useRef<(() => void) | null>(null);
  const leaving = useRef(false);
  useEffect(() => setLeaveGuard((proceed) => {
    if (leaving.current) return true;
    if (now.current.busy) return false;
    if (!now.current.unsaved) return true;
    leave.current = proceed;
    setClosing(true);
    return false;
  }), []);
  if ((batches.isLoading || batches.isFetching) && !stored) return <Modal title="Review capture" onClose={onClose}><p className="muted">Loading…</p></Modal>;
  if (batches.error && !stored) return <Modal title="Review capture" onClose={onClose}><p className="error">{classify(batches.error).message}</p></Modal>;
  if (!stored) return <Modal title="Review capture" onClose={onClose}><p className="muted">This capture is no longer here.</p></Modal>;
  const items = stored.items.map((i) => edits[i.id] ?? i);

  // An item shows as accepted or skipped only once the batch has recorded it. The store replaces the whole batch, so saves
  // run one at a time, each from the state the one before it left.
  const save = (...next: CaptureItem[]) => {
    const run = queue.current.then(async () => {
      const changed = Object.fromEntries(next.map((n) => [n.id, n]));
      // From the batch as stored now: another review of it may have saved since this dialog's copy was read.
      const base = (await listRecords<CaptureBatch>("capture")).find((b) => b.id === stored.id) ?? stored;
      await putRecord<CaptureBatch>("capture", { ...base, items: base.items.map((i) => changed[i.id] ?? latest.current[i.id] ?? i) });
      setEdits((e) => ({ ...e, ...changed }));
    });
    queue.current = run.catch(() => undefined);
    return run;
  };

  const saveAccepted = async (done: CaptureItem) => {
    try {
      await save(done);
      setUnsaved((u) => Object.fromEntries(Object.entries(u).filter(([id]) => id !== done.id)));
    } catch (e) {
      setUnsaved((u) => ({ ...u, [done.id]: done }));
      setProblems((all) => ({ ...all, [done.id]: `Saved to memory, but this capture did not record it: ${classify(e).message} Retry save.` }));
    }
  };

  const retrySave = async (id: string) => {
    setBusy(id);
    setProblems((p) => ({ ...p, [id]: "" }));
    try { await saveAccepted(unsaved[id]); } finally { setBusy(null); }
  };

  const accept = async (item: CaptureItem, replace?: string, anyway?: boolean) => {
    setBusy(item.id);
    setProblems((p) => ({ ...p, [item.id]: "" }));
    try {
      // The exact write goes into the batch before it runs, so a retry after a crash or a closed dialog repeats that write
      // (which finds what it already wrote) rather than one planned again from fields edited since.
      const planned = acceptWrite(item, () => planWrite(item, ctx, replace, acceptKey(stored.id, item.id)), replace);
      const { superseded: replaced } = planned;
      // "Save anyway" is part of the recorded write, so a resumed accept does not ask again.
      const write = anyway && planned.write.kind === "note" ? { ...planned.write, payload: { ...planned.write.payload, allow_similar: true } } : planned.write;
      if (planned.fresh || write !== planned.write) await save({ ...item, intent: { write, superseded: replaced } });
      const result = { ...(await perform(write, anyway, !planned.fresh)), superseded: replaced };
      await saveAccepted({ ...item, intent: undefined, state: "accepted" as const, result });
      await refreshStore(client);
    } catch (e) {
      const p = classify(e);
      if (p.kind === "stale" || p.kind === "revision-required") {
        // Living Memory wrote nothing, so the recorded write is dropped: accepting again plans it from the notes as they are now.
        await save({ ...item, intent: undefined }).catch(() => undefined);
        const message = await writeFailure(client, e);
        setProblems((all) => ({ ...all, [item.id]: message }));
        return;
      }
      const repeated = p.message.includes("Idempotency key has different content");
      setProblems((all) => ({ ...all, [item.id]: p.kind === "similar" ? `A similar note exists: "${p.title ?? p.ref}". Save this one anyway, or skip it.`
        : repeated ? "This item was saved to memory earlier, with the text it had then. Skip it here; the saved note is in Activity." : p.message }));
    } finally { setBusy(null); }
  };

  const reject = (...items: CaptureItem[]) => save(...items.map((i) => ({ ...i, intent: undefined, state: "rejected" as const }))).catch((e) => toast(String(e), "error"));

  // An item already written to memory is not waiting, even before its batch save goes through.
  const pending = pendingItems(items).filter((i) => !unsaved[i.id]);
  return (
    <Modal title={`Review: ${stored.source.label}`} onClose={close} wide locked={!!busy}>
      <div className="exec-review">
        <p className="muted small">
          {items.length ? `${items.length} item${items.length === 1 ? "" : "s"} found, ${pending.length} waiting. ` : "No items were found. "}
          Accepted notes and commitments go to Living Memory; milestones stay in Hivemind.
        </p>
        {batches.error ? <p className="error small">Could not reload this capture: {classify(batches.error).message}</p> : null}
        {stored.questions.length > 0 && (
          <div className="banner"><strong>Questions to settle</strong><ul>{stored.questions.map((q) => <li key={q}>{q}</li>)}</ul></div>
        )}
        {items.map((item) => (
          <ItemCard key={item.id} item={item} projects={projects} ctx={ctx} busy={!!busy} problem={problems[item.id] || undefined} unsaved={!!unsaved[item.id]}
            onRetrySave={() => retrySave(item.id)}
            onChange={(next) => setEdits((e) => ({ ...e, [item.id]: next }))}
            onAccept={(replace, anyway) => (replace ? setReplacing({ item, ref: replace }) : accept(item, undefined, anyway))}
            onReject={() => reject(item)} />
        ))}
        <button className="link small" onClick={() => setShowText(!showText)}>{showText ? "Hide" : "Show"} the captured text</button>
        {showText && <pre className="briefing-text">{stored.text}</pre>}
        <div className="actions">
          {pending.length > 1 && <button onClick={() => reject(...pending)} disabled={!!busy}>Skip the rest</button>}
          <button className="primary" onClick={close} disabled={!!busy}>{pending.length ? "Later" : "Done"}</button>
        </div>
      </div>
      {closing && (
        <Confirm title="Close without recording?" action="Close"
          message="Some accepted items are in memory, but this capture has not recorded them. Retry save first, or they show as waiting next time."
          onAnswer={(yes) => {
            setClosing(false);
            const proceed = leave.current ?? onClose;
            leave.current = null;
            // A write may have started behind this confirm (a replace answered first): leaving now would lose its retry.
            if (yes && now.current.busy) toast("An item is still being saved. Leave once it is done.");
            else if (yes) { leaving.current = true; proceed(); }
          }} />
      )}
      {replacing && (
        <Confirm title="Replace the existing note?" action="Replace"
          message={`The new note supersedes "${replacing.item.similar.find((s) => s.ref === replacing.ref)?.title}". The old note is kept as superseded, and the change can be undone from Activity.`}
          onAnswer={(yes) => { const r = replacing; setReplacing(null); if (yes) accept(r.item, r.ref); }} />
      )}
    </Modal>
  );
}
