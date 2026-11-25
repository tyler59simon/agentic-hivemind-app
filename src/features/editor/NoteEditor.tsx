import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { classify, type Problem } from "../../lib/errors";
import { domainOf, LM_READ_LIMIT, taxonomy, taxonomyAdd, update } from "../../lib/lm";
import { useNoteTypes } from "../../lib/noteTypes";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { toast } from "../../ui/toast";
import { useWorkspace, type Tab } from "../../workspace/store";
import { useNoteLinks } from "../links/useLinks";
import { DirectDialog } from "../plans/DirectDialog";
import { noteQuery } from "../viewer/NoteView";
import { MarkdownEditor } from "./MarkdownEditor";
import { MergeDialog } from "./MergeDialog";
import {
  acquire, currentStore, editSession, followNote, getSession, loadSession, patchSession, replaceEdit, resolveLegacy, savedNote, sessionKey,
  useNoteSessions, type Banner, type EditState,
} from "./noteSessions";
import { rewriteIncoming } from "./rewriteIncoming";
import { PropertiesForm } from "./PropertiesForm";
import { changedPayload, fieldsOf, isDirty, isEmpty, precheck, type Fields } from "./save";
import { useTitles } from "./useTitles";

const TOO_LONG = `This note is now longer than ${LM_READ_LIMIT.toLocaleString("en-US")} characters, and Living Memory gives Hivemind only the start of it, so Hivemind cannot save changes to its text without deleting the rest. Edit the note in its file, or save a copy of your text.`;

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

/** `head` is where the title field and Save button are drawn (the note page's header). The text, banner and draft belong
 *  to the note's session (`noteSessions.ts`), shared by every pane that shows the note in Edit. */
export function NoteEditor({ tab, live, head }: { tab: Tab; live: boolean; head: HTMLElement }) {
  const ref = tab.ref!;
  const client = useQueryClient();
  const note = useQuery(noteQuery(ref));
  const tax = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy });
  const types = useNoteTypes();
  const { setDirty, updateTab, openNote, openTab } = useWorkspace();
  const reveal = useWorkspace((s) => (s.reveal?.tabId === tab.id ? s.reveal : null));
  const titles = useTitles(domainOf(ref));
  const { note: links } = useNoteLinks(ref);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const linksRef = useRef(links);
  linksRef.current = links;
  // No session while Hivemind does not know its store: a note's edits and draft belong to a store.
  const store = currentStore();
  const key = store === undefined ? undefined : sessionKey(store, ref);
  const sess = useNoteSessions((s) => (key ? s.sessions[key] : undefined));
  const st = sess?.st ?? null;
  const banner = sess?.banner ?? null;
  const merging = sess?.merging ?? null;
  const saving = !!sess?.saving;
  const dirty = st ? isDirty(st.base, st.mine) : false;
  // Living Memory returned only the start of this note: a body sent back would replace the whole note, so the body is not editable.
  const tooLong = !!note.data?.truncated;
  const tooLongRef = useRef(tooLong);
  tooLongRef.current = tooLong;
  const setBanner = (b: Banner | null) => key && patchSession(key, { banner: b });

  useEffect(() => (key ? acquire(store!, ref) : undefined), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Load once per session: a stored draft wins over the saved note (it may be based on an older revision).
  useEffect(() => { if (key && note.data && sess && !sess.st && !sess.legacy) void loadSession(key, note.data); }, [key, note.data, !!sess, sess?.st, sess?.legacy]); // eslint-disable-line react-hooks/exhaustive-deps
  // Someone else saved the note: follow along if there are no local edits, else warn.
  useEffect(() => { if (key && note.data) followNote(key, note.data); }, [note.data?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setDirty(tab.id, dirty); }, [dirty, tab.id, setDirty]);
  useEffect(() => { if (st && st.mine.title) updateTab(tab.id, { title: st.mine.title }); }, [st?.mine.title, tab.id, updateTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (change: Partial<Fields>) => key && editSession(key, change);

  /** After a rename, offer to point [[Old Title]] links in other notes at the new title. */
  const offerLinkRewrite = (oldTitle: string, newTitle: string, at?: number) => {
    const sources = (linksRef.current?.incoming ?? []).filter((e) => e.kind === "link").map((e) => e.node);
    if (!sources.length) return;
    const run = async () => {
      setDialog(null);
      const { done, failed, skipped } = await rewriteIncoming(sources, oldTitle, newTitle, at);
      refreshStore(client);
      toast(`Updated links in ${done} note${done === 1 ? "" : "s"}.`);
      if (skipped.length) toast(`Not changed, too long to rewrite here (over ${LM_READ_LIMIT.toLocaleString("en-US")} characters): ${skipped.join(", ")}.`, "warn");
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
    const sess = key ? getSession(key) : undefined;
    const s = opts.state ?? sess?.st;
    if (!key || !sess || !s || sess.saving) return;
    const payload = changedPayload(s.base, s.mine);
    if (isEmpty(payload)) { toast("Nothing to save."); return; }
    if (payload.body !== undefined && tooLongRef.current) { setBanner({ kind: "error", problem: { kind: "other", message: TOO_LONG } }); return; }
    const problems = precheck(s.mine, tax.data?.tags ?? [], false, types.def(s.mine.type));
    const unknown = s.mine.tags.filter((t) => tax.data && !tax.data.tags.includes(t));
    if (unknown.length) { setBanner({ kind: "error", problem: { kind: "unknown-tags", message: "", tags: unknown } }); return; }
    if (problems.length) { setBanner({ kind: "problems", problems }); return; }
    patchSession(key, { saving: true });
    try {
      // Bound to the generation the note was read in: after Hivemind switches stores the save is refused, not sent to the new store.
      const r = await update(ref, { ...payload, expected_revision: s.rev }, { redact: opts.redact, at: sess.generation });
      recordOperation(r.operation_id);
      r.quality_warnings?.forEach((w) => toast(w, "warn"));
      r.redacted?.length && toast(`Redacted ${r.redacted.length} secret${r.redacted.length === 1 ? "" : "s"}.`, "warn");
      const fresh = await client.fetchQuery({ ...noteQuery(ref), staleTime: 0 });
      // Keeps anything typed while the save was in flight, and deletes the draft only if the saved note covers it.
      savedNote(sess.store, ref, s, fresh);
      ["list", "links", "preview", "history", "activity"].forEach((k) => client.invalidateQueries({ queryKey: [k] }));
      toast('Saved.');
      if (payload.title) offerLinkRewrite(s.base.title, payload.title, sess.generation);
    } catch (e) {
      const problem = classify(e);
      if (problem.kind === "stale") {
        try {
          const fresh = await client.fetchQuery({ ...noteQuery(ref), staleTime: 0 });
          const mine = getSession(key)?.st?.mine ?? s.mine;
          if (fresh.truncated && changedPayload(s.base, mine).body !== undefined) {
            setBanner({ kind: "error", problem: { kind: "other", message: TOO_LONG } });
            return;
          }
          patchSession(key, { merging: { base: s.base, mine, theirs: fieldsOf(fresh), rev: fresh.revision } });
        } catch (reloadError) {
          setBanner({ kind: "error", problem: classify(reloadError) });
        }
      } else setBanner({ kind: "error", problem });
    } finally { patchSession(key, { saving: false }); }
  }, [key, ref, tax.data, types, client]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTags = (tags: string[]) => setDialog(
    <DirectDialog title="Add tags to the taxonomy" run={() => taxonomyAdd(tags)} applyLabel="Add tags"
      intro={<p>Living Memory only accepts registered tags. This adds {tags.join(", ")} to the taxonomy, then your note can be saved.</p>}
      onApplied={() => { client.invalidateQueries({ queryKey: ["taxonomy"] }); setBanner(null); }} onClose={() => setDialog(null)} />,
  );

  if (sess?.legacy && note.data) {
    const n = note.data;
    return (
      <article className="note editing">
        <div className="banner warn">
          This draft was made before Hivemind recorded which store it belongs to. It holds unsaved edits from {new Date(sess.legacy.savedAt).toLocaleString()}.
          <div className="actions">
            <button onClick={() => resolveLegacy(key!, false, n)}>Throw it away</button>
            <button className="primary" onClick={() => resolveLegacy(key!, true, n)}>Keep it here</button>
          </div>
        </div>
      </article>
    );
  }
  if (note.error && !st) return <p className="error pad">{classify(note.error).message}</p>;
  if (note.isLoading || !st) return <p className="muted pad">Loading…</p>;
  const n = note.data;
  return (
    <article className="note editing file-editor doc-column">
      {createPortal(
        <div className="note-head">
          <input className="title-input" value={st.mine.title} aria-label="Title" onChange={(e) => edit({ title: e.target.value })}
            onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } }} />
          <span className={`save-state ${dirty ? "dirty" : ""}`}>{saving ? "Saving…" : dirty ? "Unsaved" : "Saved"}</span>
          <button className="primary" disabled={!dirty || saving} onClick={() => save()} title="Save (Ctrl+S)"><Save size="1.1em" aria-hidden />Save</button>
        </div>,
        head,
      )}
      {note.error && <div className="banner error">Could not refresh this note: {classify(note.error).message}</div>}
      {banner?.kind === "restored" && (
        <div className="banner">Restored unsaved edits from {new Date(banner.at).toLocaleString()}.
          {n && <div className="actions"><button onClick={() => { const f = fieldsOf(n); replaceEdit(key!, { base: f, rev: n.revision, mine: f, version: st.version + 1 }); setBanner(null); }}>Discard them</button></div>}
        </div>
      )}
      {banner?.kind === "draft-old" && <div className="banner warn">These unsaved edits from {new Date(banner.at).toLocaleString()} started from an older version of the note. Saving will ask you to merge.</div>}
      {banner?.kind === "outside" && <div className="banner warn">This note was changed outside Hivemind while you were editing. Saving will ask you to merge.</div>}
      {banner?.kind === "problems" && <div className="banner error"><ul>{banner.problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      {banner?.kind === "error" && <ProblemBanner problem={banner.problem} onRedact={() => save({ redact: true })} onAddTags={addTags} />}
      {dialog}
      {tooLong && <div className="banner warn">This note is longer than {LM_READ_LIMIT.toLocaleString("en-US")} characters. Living Memory gives Hivemind only the start of it, so the text is read-only here: saving a change to it would delete the rest. Title, tags and the other properties can still be changed.</div>}
      <details className="props-toggle">
        <summary>Properties <span className="muted small">{st.mine.type} · {st.mine.tags.join(", ")}</span></summary>
        <PropertiesForm fields={st.mine} note={n} taxonomy={tax.data?.tags ?? []} onChange={edit} />
      </details>
      <MarkdownEditor doc={st.mine.body} docVersion={st.version} follow live={live} titles={titles} reveal={reveal} readOnly={tooLong}
        onChange={(body) => edit({ body })} onSave={() => save()}
        onOpenLink={(target, split) => {
          const node = links?.out.get(target.trim().toLowerCase());
          if (node) openNote(node.ref, { split, title: node.title });
          else openTab({ kind: "new-note", init: { title: target, domain: domainOf(ref) } }, { split: true });
        }} />
      {merging && (
        <MergeDialog base={merging.base} mine={merging.mine} theirs={merging.theirs} onCancel={() => patchSession(key!, { merging: null })}
          onResolve={(merged) => {
            const next = { base: merging.theirs, rev: merging.rev, mine: merged, version: st.version + 1 };
            replaceEdit(key!, next);
            patchSession(key!, { merging: null, banner: null });
            save({ state: next });
          }} />
      )}
    </article>
  );
}
