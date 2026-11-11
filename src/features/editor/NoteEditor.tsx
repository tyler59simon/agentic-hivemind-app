import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { deleteDraft, getDraft, putDraft } from "../../lib/drafts";
import { classify, type Problem } from "../../lib/errors";
import { domainOf, read, taxonomy, taxonomyPlan, update } from "../../lib/lm";
import { rewriteWikilinks } from "../../lib/note";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { toast } from "../../ui/toast";
import { useWorkspace, type Tab } from "../../workspace/store";
import { useNoteLinks } from "../links/useLinks";
import { PlanDialog } from "../plans/PlanDialog";
import { noteQuery } from "../viewer/NoteView";
import { MarkdownEditor } from "./MarkdownEditor";
import { MergeDialog } from "./MergeDialog";
import { PropertiesForm } from "./PropertiesForm";
import { changedPayload, fieldsOf, isDirty, isEmpty, precheck, type Fields } from "./save";
import { useTitles } from "./useTitles";

interface EditState { base: Fields; rev: string; mine: Fields; version: number }
type Banner =
  | { kind: "restored" | "draft-old"; at: string }
  | { kind: "outside" }
  | { kind: "problems"; problems: string[] }
  | { kind: "error"; problem: Problem };

/** A banner for an LM refusal, with the one action that fixes it when there is one. */
export function ProblemBanner({ problem, onRedact, onAddTags }: { problem: Problem; onRedact: () => void; onAddTags: (tags: string[]) => void }) {
  if (problem.kind === "credential") {
    return <div className="banner error">{problem.message}<div className="actions"><button onClick={onRedact}>Save with the secret redacted</button></div></div>;
  }
  if (problem.kind === "unknown-tags") {
    return (
      <div className="banner error">
        These tags are not in the taxonomy yet: {problem.tags.join(", ")}.
        <div className="actions"><button onClick={() => onAddTags(problem.tags)}>Add them to the taxonomy…</button></div>
      </div>
    );
  }
  if (problem.kind === "private") return <div className="banner error">Living Memory refused text the user marked private: {problem.message}</div>;
  return <div className="banner error">{problem.message}</div>;
}

/** `head` is where the title field and Save button are drawn (the note page's header). */
export function NoteEditor({ tab, live, head }: { tab: Tab; live: boolean; head: HTMLElement }) {
  const ref = tab.ref!;
  const client = useQueryClient();
  const note = useQuery(noteQuery(ref));
  const tax = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  const { setDirty, updateTab, openNote, openTab } = useWorkspace();
  const reveal = useWorkspace((s) => (s.reveal?.tabId === tab.id ? s.reveal : null));
  const titles = useTitles(domainOf(ref));
  const { note: links } = useNoteLinks(ref);
  const [st, setSt] = useState<EditState | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [merging, setMerging] = useState<{ base: Fields; mine: Fields; theirs: Fields; rev: string } | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [saving, setSaving] = useState(false);
  const stRef = useRef(st);
  stRef.current = st;
  const linksRef = useRef(links);
  linksRef.current = links;
  const dirty = st ? isDirty(st.base, st.mine) : false;

  // Load once: a stored draft wins over the saved note (it may be based on an older revision).
  useEffect(() => {
    if (!note.data || st) return;
    let alive = true;
    const fresh = fieldsOf(note.data);
    getDraft(ref).catch(() => null).then((d) => {
      if (!alive) return;
      if (d?.base && d.baseRevision && isDirty(d.base, d.mine)) {
        const current = d.baseRevision === note.data!.revision;
        setSt({ base: current ? fresh : d.base, rev: d.baseRevision, mine: d.mine, version: 1 });
        setBanner({ kind: current ? "restored" : "draft-old", at: d.savedAt });
      } else setSt({ base: fresh, rev: note.data!.revision, mine: fresh, version: 1 });
    });
    return () => { alive = false; };
  }, [note.data, st, ref]);

  // Someone else saved the note: follow along if there are no local edits, else warn.
  useEffect(() => {
    const s = stRef.current;
    if (!note.data || !s || note.data.revision === s.rev) return;
    if (!isDirty(s.base, s.mine)) {
      const f = fieldsOf(note.data);
      setSt({ base: f, rev: note.data.revision, mine: f, version: s.version + 1 });
    } else setBanner((b) => (b?.kind === "draft-old" ? b : { kind: "outside" }));
  }, [note.data?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setDirty(tab.id, dirty); }, [dirty, tab.id, setDirty]);
  useEffect(() => { if (st && st.mine.title) updateTab(tab.id, { title: st.mine.title }); }, [st?.mine.title, tab.id, updateTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = useCallback((s: EditState) => {
    if (isDirty(s.base, s.mine)) putDraft({ key: ref, ref, baseRevision: s.rev, base: s.base, mine: s.mine, savedAt: new Date().toISOString() }).catch(() => {});
    else deleteDraft(ref).catch(() => {});
  }, [ref]);
  useEffect(() => {
    if (!st) return;
    const timer = setTimeout(() => persist(st), 1000);
    return () => clearTimeout(timer);
  }, [st?.mine, persist]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (stRef.current) persist(stRef.current); }, [persist]);

  const edit = (patch: Partial<Fields>) => setSt((s) => (s ? { ...s, mine: { ...s.mine, ...patch } } : s));

  /** After a rename, offer to point [[Old Title]] links in other notes at the new title. */
  const offerLinkRewrite = (oldTitle: string, newTitle: string) => {
    const sources = (linksRef.current?.incoming ?? []).filter((e) => e.kind === "link").map((e) => e.node);
    if (!sources.length) return;
    const run = async () => {
      setDialog(null);
      let done = 0;
      const failed: string[] = [];
      for (const source of sources) {
        try {
          const n = await read(source.ref);
          const body = rewriteWikilinks(n.body, oldTitle, newTitle);
          if (body === n.body) continue;
          const r = await update(source.ref, { body, expected_revision: n.revision });
          recordOperation(r.operation_id);
          done++;
        } catch (e) { failed.push(`${source.title}: ${classify(e).message}`); }
      }
      refreshStore(client);
      toast(`Updated links in ${done} note${done === 1 ? "" : "s"}.`);
      failed.forEach((f) => toast(f, "error"));
    };
    setDialog(
      <div className="banner">
        {sources.length} note{sources.length === 1 ? " links" : "s link"} here as [[{oldTitle}]]. Living Memory does not rewrite links on rename.
        <div className="actions">
          <button onClick={() => setDialog(null)}>Leave them</button>
          <button className="primary" onClick={run}>Update {sources.length === 1 ? "it" : `all ${sources.length}`} to [[{newTitle}]]</button>
        </div>
      </div>,
    );
  };

  const save = useCallback(async (opts: { redact?: boolean; state?: EditState } = {}) => {
    const s = opts.state ?? stRef.current;
    if (!s) return;
    const payload = changedPayload(s.base, s.mine);
    if (isEmpty(payload)) { toast("Nothing to save."); return; }
    const problems = precheck(s.mine, tax.data?.tags ?? [], false);
    const unknown = s.mine.tags.filter((t) => tax.data && !tax.data.tags.includes(t));
    if (unknown.length) { setBanner({ kind: "error", problem: { kind: "unknown-tags", message: "", tags: unknown } }); return; }
    if (problems.length) { setBanner({ kind: "problems", problems }); return; }
    setSaving(true);
    try {
      const r = await update(ref, { ...payload, expected_revision: s.rev }, { redact: opts.redact });
      recordOperation(r.operation_id);
      r.quality_warnings?.forEach((w) => toast(w, "warn"));
      r.redacted?.length && toast(`Redacted ${r.redacted.length} secret${r.redacted.length === 1 ? "" : "s"}.`, "warn");
      const fresh = await client.fetchQuery({ ...noteQuery(ref), staleTime: 0 });
      const f = fieldsOf(fresh);
      // Keep anything typed while the save was in flight.
      setSt((cur) => ({ base: f, rev: fresh.revision, mine: cur && cur.mine !== s.mine ? cur.mine : f, version: (cur?.version ?? 0) + (cur && cur.mine !== s.mine ? 0 : 1) }));
      deleteDraft(ref).catch(() => {});
      setBanner(null);
      ["list", "links", "preview", "history", "activity"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
      toast("Saved.");
      if (payload.title) offerLinkRewrite(s.base.title, payload.title);
    } catch (e) {
      const problem = classify(e);
      if (problem.kind === "stale") {
        const fresh = await client.fetchQuery({ ...noteQuery(ref), staleTime: 0 });
        setMerging({ base: s.base, mine: s.mine, theirs: fieldsOf(fresh), rev: fresh.revision });
      } else setBanner({ kind: "error", problem });
    } finally { setSaving(false); }
  }, [ref, tax.data, client]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTags = (tags: string[]) => setDialog(
    <PlanDialog title="Add tags to the taxonomy" make={() => taxonomyPlan(tags)} applyLabel="Add tags"
      intro={<p>Living Memory only accepts registered tags. This adds {tags.join(", ")} to the taxonomy, then your note can be saved.</p>}
      onApplied={() => { client.invalidateQueries({ queryKey: ["taxonomy"] }); setBanner(null); }} onClose={() => setDialog(null)} />,
  );

  if (note.isLoading || !st) return <p className="muted pad">Loading…</p>;
  if (note.error) return <p className="error pad">{classify(note.error).message}</p>;
  const n = note.data!;
  return (
    <article className="note editing">
      {createPortal(
        <div className="note-head">
          <input className="title-input" value={st.mine.title} aria-label="Title" onChange={(e) => edit({ title: e.target.value })}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } }} />
          <span className={`save-state ${dirty ? "dirty" : ""}`}>{saving ? "Saving…" : dirty ? "Unsaved" : "Saved"}</span>
          <button className="primary" disabled={!dirty || saving} onClick={() => save()} title="Save (Ctrl+S)">Save</button>
        </div>,
        head,
      )}
      {banner?.kind === "restored" && (
        <div className="banner">Restored unsaved edits from {new Date(banner.at).toLocaleString()}.
          <div className="actions"><button onClick={() => { const f = fieldsOf(n); setSt({ base: f, rev: n.revision, mine: f, version: st.version + 1 }); setBanner(null); }}>Discard them</button></div>
        </div>
      )}
      {banner?.kind === "draft-old" && <div className="banner warn">These unsaved edits from {new Date(banner.at).toLocaleString()} started from an older version of the note. Saving will ask you to merge.</div>}
      {banner?.kind === "outside" && <div className="banner warn">This note was changed outside Hivemind while you were editing. Saving will ask you to merge.</div>}
      {banner?.kind === "problems" && <div className="banner error"><ul>{banner.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      {banner?.kind === "error" && <ProblemBanner problem={banner.problem} onRedact={() => save({ redact: true })} onAddTags={addTags} />}
      {dialog}
      <details className="props-toggle">
        <summary>Properties <span className="muted small">{st.mine.type} · {st.mine.tags.join(", ")}</span></summary>
        <PropertiesForm fields={st.mine} note={n} taxonomy={tax.data?.tags ?? []} onChange={edit} />
      </details>
      <MarkdownEditor doc={st.mine.body} docVersion={st.version} live={live} titles={titles} reveal={reveal}
        onChange={(body) => edit({ body })} onSave={() => save()}
        onOpenLink={(target, split) => {
          const node = links?.out.get(target.trim().toLowerCase());
          if (node) openNote(node.ref, { split, title: node.title });
          else openTab({ kind: "new-note", init: { title: target, domain: domainOf(ref) } }, { split: true });
        }} />
      {merging && (
        <MergeDialog base={merging.base} mine={merging.mine} theirs={merging.theirs} onCancel={() => setMerging(null)}
          onResolve={(merged) => {
            const next = { base: merging.theirs, rev: merging.rev, mine: merged, version: st.version + 1 };
            setSt(next);
            setMerging(null);
            setBanner(null);
            save({ state: next });
          }} />
      )}
    </article>
  );
}
