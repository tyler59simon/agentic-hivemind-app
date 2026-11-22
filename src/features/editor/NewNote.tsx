import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { deleteDraft, getDraft, putDraft } from "../../lib/drafts";
import { classify } from "../../lib/errors";
import { capture, domains, taxonomy, taxonomyAdd, type CapturePayload, type NoteType } from "../../lib/lm";
import { defaultTags, template } from "../../lib/note";
import { NOT_CAPTURED, typeOptions, useNoteTypes } from "../../lib/noteTypes";
import { recordOperation } from "../../lib/oplog";
import { useApp } from "../../store";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useWorkspace, type Tab } from "../../workspace/store";
import { DirectDialog } from "../plans/DirectDialog";
import { mergeTags } from "../projects/wizard";
import { noteQuery } from "../viewer/NoteView";
import { MarkdownEditor } from "./MarkdownEditor";
import { currentStore, noteDraftKey } from "./noteSessions";
import { ProblemBanner } from "./NoteEditor";
import { TagPicker } from "./PropertiesForm";
import { fieldsOf, precheck, type Fields } from "./save";
import { useTitles } from "./useTitles";

const draftKey = (tab: Tab) => `new-${tab.id}`;

/** A note that does not exist yet. Saving captures it; the tab then becomes that note. */
export function NewNote({ tab }: { tab: Tab }) {
  const client = useQueryClient();
  const appDomain = useApp((s) => s.domain);
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const tax = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  const types = useNoteTypes();
  const { updateTab, setDirty, openNote } = useWorkspace();
  const [domain, setDomain] = useState(tab.init?.domain ?? appDomain ?? "");
  const initialType: NoteType = tab.init?.type ?? "knowledge";
  const [f, setF] = useState<Fields>({ title: tab.init?.title ?? "", body: template(initialType, types.def(initialType)), type: initialType, tags: [], context: "", review_by: "", files: [] });
  const [version, setVersion] = useState(1);
  const [banner, setBanner] = useState<ReactNode>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [saving, setSaving] = useState(false);
  const titles = useTitles(domain);
  const touchedTags = useRef(false);
  const fRef = useRef(f);
  fRef.current = f;
  const blank = template(f.type, types.def(f.type));
  const shownTemplate = useRef(f.body);

  // Suggested tags follow the type until the user picks tags themselves.
  useEffect(() => {
    if (tax.data && !touchedTags.current) setF((x) => ({ ...x, tags: mergeTags(defaultTags(x.type, tax.data.tags, types.def(x.type)), tab.init?.tags ?? []) }));
  }, [tax.data, f.type, types]);
  // The type's definition can arrive from Living Memory after the tab opened: an untouched body follows it.
  useEffect(() => {
    const last = shownTemplate.current;
    shownTemplate.current = blank;
    if (blank !== last && fRef.current.body === last) { setF((x) => ({ ...x, body: blank })); setVersion((v) => v + 1); }
  }, [blank]);
  useEffect(() => { getDraft(draftKey(tab)).then((d) => { if (d) { setF(d.mine); if (d.domain) setDomain(d.domain); setVersion((v) => v + 1); } }).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const started = f.title.trim() !== (tab.init?.title ?? "") || f.body !== blank;
  useEffect(() => { setDirty(tab.id, started); updateTab(tab.id, { title: f.title || "New note" }); }, [started, f.title, tab.id, setDirty, updateTab]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (started) putDraft({ key: draftKey(tab), domain, mine: fRef.current, savedAt: new Date().toISOString() }).catch(() => {});
    }, 1000);
    return () => clearTimeout(timer);
  }, [f, domain, started, tab]);
  // Leaving the page within the debounce would drop the last edits: write them on unmount, unless the note was saved.
  const saved = useRef(false);
  const flush = useRef(() => {});
  flush.current = () => { if (started && !saved.current) putDraft({ key: draftKey(tab), domain, mine: fRef.current, savedAt: new Date().toISOString() }).catch(() => {}); };
  useEffect(() => () => flush.current(), []);

  const changeType = (type: NoteType) => {
    // Swap the starting template only if the body is still untouched.
    const fresh = f.body === blank;
    const next = template(type, types.def(type));
    if (fresh) shownTemplate.current = next;
    setF({ ...f, type, body: fresh ? next : f.body });
    if (fresh) setVersion((v) => v + 1);
  };

  /** The note exists now. `sent` is the exact text the save request carried: anything typed after it (the editor stays
   *  open while the request runs) is kept as an unsaved draft of the new note, which its editor then opens with. */
  const finish = async (ref: string, title: string, mode: "live" | "reading", sent?: Fields, store?: string) => {
    saved.current = true;
    deleteDraft(draftKey(tab)).catch(() => {});
    let later = false;
    if (sent && JSON.stringify(fRef.current) !== JSON.stringify(sent)) {
      later = true;
      let base = sent;
      let baseRevision = "unknown";
      try {
        const made = await client.fetchQuery({ ...noteQuery(ref), staleTime: 0 });
        base = fieldsOf(made);
        baseRevision = made.revision;
      } catch { /* the draft is then merged against what was sent when it is saved */ }
      // Read the buffer once more now: there was typing while the note was fetched. The draft belongs to the store the note was saved in.
      if (store === undefined) toast("The text typed while saving could not be kept as a draft.", "warn");
      else putDraft({ key: noteDraftKey(store, ref), ref, store, baseRevision, base, mine: fRef.current, savedAt: new Date().toISOString() }).catch(() => toast("The text typed while saving could not be kept as a draft.", "warn"));
    }
    setDirty(tab.id, false);
    updateTab(tab.id, { kind: "note", ref, mode: later ? "live" : mode, title, init: undefined });
    ["list", "links", "domains"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
  };

  const save = async (extra: Partial<CapturePayload> = {}, redact = false) => {
    const problems = precheck(f, tax.data?.tags ?? [], true, types.def(f.type));
    if (!domain) problems.unshift("Choose a domain.");
    const unknown = f.tags.filter((t) => tax.data && !tax.data.tags.includes(t));
    if (unknown.length) return setBanner(<ProblemBanner problem={{ kind: "unknown-tags", message: "", tags: unknown }} onRedact={() => {}} onAddTags={addTags} />);
    if (problems.length) return setBanner(<div className="banner error"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>);
    setSaving(true);
    setDialog(null);
    const sent = f;
    const store = currentStore();
    try {
      const payload: CapturePayload = { title: f.title.trim(), body: f.body, tags: f.tags, type: f.type, ...extra };
      if (f.context.trim()) payload.context = f.context.trim();
      if (f.review_by) payload.review_by = f.review_by;
      const files = f.files.map((x) => x.trim()).filter(Boolean);
      if (files.length) payload.files = files;
      const r = await capture(domain, payload, { redact });
      recordOperation(r.operation_id);
      const ref = `${r.domain ?? domain}:${r.id}`;
      r.quality_warnings?.forEach((w) => toast(w, "warn"));
      if (r.status === "created") { toast("Saved to Living Memory."); await finish(ref, payload.title, "live", sent, store); }
      else if (r.status === "promoted") { toast(r.hint ?? "The same note existed in another project, so it moved to the global domain.", "warn"); await finish(ref, payload.title, "reading", sent, store); }
      else { toast("Living Memory already has this note; showing it.", "warn"); finish(ref, payload.title, "reading"); }
    } catch (e) {
      const p = classify(e);
      if (p.kind === "similar") {
        setDialog(
          <Modal title="A similar note already exists" onClose={() => setDialog(null)}>
            <p>Living Memory found “{p.title}”, which looks like the same subject. Update it if the fact moved on, replace it if this supersedes it, or save a separate note if they are genuinely different.</p>
            <div className="actions">
              <button onClick={() => { setDialog(null); if (p.ref) openNote(p.ref, { split: true, mode: "live", title: p.title }); }}>Open it to update</button>
              <button onClick={() => save({ supersedes: p.ref ? [p.ref] : [] })}>Save as its replacement</button>
              <button className="primary" onClick={() => save({ allow_similar: true })}>Save as a separate note</button>
            </div>
          </Modal>,
        );
      } else setBanner(<ProblemBanner problem={p} onRedact={() => save(extra, true)} onAddTags={addTags} />);
    } finally { setSaving(false); }
  };

  const addTags = (tags: string[]) => setDialog(
    <DirectDialog title="Add tags to the taxonomy" run={() => taxonomyAdd(tags)} applyLabel="Add tags" onClose={() => setDialog(null)}
      intro={<p>Living Memory only accepts registered tags. This adds {tags.join(", ")} to the taxonomy, then your note can be saved.</p>}
      onApplied={() => { client.invalidateQueries({ queryKey: ["taxonomy"] }); setBanner(null); }} />,
  );

  return (
    <article className="note editing">
      <div className="note-head">
        <input className="title-input" autoFocus value={f.title} placeholder="Title" aria-label="Title" onChange={(e) => setF({ ...f, title: e.target.value })} />
        <button className="primary" disabled={saving} onClick={() => save()} title="Save (Ctrl+S)">{saving ? "Saving…" : "Save"}</button>
      </div>
      <dl className="properties editable">
        <div><dt>Domain</dt><dd>
          <select value={domain} onChange={(e) => setDomain(e.target.value)}>
            {!domain && <option value="">Choose…</option>}
            {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
          </select>
        </dd></div>
        <div><dt>Type</dt><dd>
          <select value={f.type} onChange={(e) => changeType(e.target.value as NoteType)}>{typeOptions(types.active, f.type, NOT_CAPTURED).map((t) => <option key={t}>{t}</option>)}</select>
        </dd></div>
        <div><dt>Tags</dt><dd><TagPicker tags={f.tags} taxonomy={tax.data?.tags ?? []} onChange={(tags) => { touchedTags.current = true; setF({ ...f, tags }); }} /></dd></div>
      </dl>
      {banner}
      {dialog}
      <MarkdownEditor doc={f.body} docVersion={version} live titles={titles} onChange={(body) => setF((x) => ({ ...x, body }))} onSave={() => save()}
        onOpenLink={() => toast("Save the note first, then Ctrl+click its links.")} />
    </article>
  );
}
