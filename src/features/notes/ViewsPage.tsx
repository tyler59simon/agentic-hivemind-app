// The Views sub-view of the Notes page (CON-13): every view Living Memory keeps. A note view is a note shown as a dashboard (its
// action items, its progress and a page that can be published); a query view is the query form's JSON (NS-7B), which Hivemind
// runs over its own index, so a table cell edit or a board drag stays here. Living Memory stores and checks both; the route's
// `ref` names the one that is open (a note view's ref, a query view's ID). The same JSON in a ```query block of a page shows
// the table or board in the page's Reading view.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useQueryViewsEnabled, useViewsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { addQueryView, removeView, updateQueryView, viewKey, type ViewRow } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { recordOperation } from "../../lib/oplog";
import { useApp } from "../../store";
import { toast } from "../../ui/toast";
import { DashboardView } from "../dashboards/DashboardView";
import { useViews } from "../dashboards/useDashboards";
import { QueryFormFields } from "./QueryForm";
import { QueryRun } from "./QueryView";
import { formOf, newSpec, parseSpec, queryBlock, specOf, type QueryForm } from "./queries";

const TITLE_MAX = 120;

const titleOf = (v: ViewRow) => (v.kind === "query" ? v.title : v.title || v.note_title || v.note.slice(0, 8));

export function ViewsPage() {
  const client = useQueryClient();
  const go = useApp((s) => s.go);
  const ref = useApp((s) => (s.route.page === "notes" ? s.route.ref : undefined));
  const folders = useQuery(notebooksQuery());
  const viewsOn = useViewsEnabled();
  const savingOn = useQueryViewsEnabled();
  const { query, rows } = useViews({ fresh: true });
  const choices = useMemo(() => (folders.data ?? []).map((n) => ({ id: n.id, title: n.title })), [folders.data]);

  const picked = rows.find((r) => viewKey(r) === ref);
  const queryView = picked?.kind === "query" ? picked : undefined;
  const [form, setForm] = useState<QueryForm>(() => formOf(newSpec()));
  const [name, setName] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  // Opening a query view fills the form; "New view" (no ref) empties it. A refetch of the same view leaves the form as the user has it.
  useEffect(() => {
    if (queryView) {
      setName(queryView.title);
      const parsed = parseSpec(queryView.spec);
      if (parsed.ok) { setForm(formOf(parsed.spec)); setBad(null); } else setBad(`${queryView.title} is not a valid view: ${parsed.error}.`);
    } else if (!ref) {
      setName(""); setBad(null); setForm(formOf(newSpec()));
    }
  }, [queryView?.id, ref]); // eslint-disable-line react-hooks/exhaustive-deps

  const made = useMemo(() => specOf(form), [form]);
  const open = (key?: string) => go({ page: "notes", view: "views", ...(key ? { ref: key } : {}) }, { replace: true });
  const wrote = async (operation: string | undefined) => {
    recordOperation(operation);
    await client.invalidateQueries({ queryKey: ["views"] });
  };

  const save = async () => {
    if (!made.ok || !name.trim() || !savingOn) return;
    try {
      const saved = queryView ? await updateQueryView(queryView.id, made.spec, name.trim()) : await addQueryView(name.trim(), made.spec);
      await wrote(saved.operation_id);
      open(saved.id);
      toast(`Saved the view ${name.trim()}`);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };
  const remove = async () => {
    if (!queryView) return;
    try {
      await wrote((await removeView(queryView.id)).operation_id);
      open();
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };
  const copyBlock = () => {
    if (!made.ok) return;
    navigator.clipboard.writeText(queryBlock(made.spec)).then(() => toast("Copied a query block. Paste it into a page and read the page."), () => toast("Could not copy to the clipboard.", "error"));
  };

  return (
    <section className="views-page" aria-label="Views">
      <aside className="views-list" aria-label="Saved views">
        <header className="views-head"><h1>Views</h1><button type="button" onClick={() => open()}>New view</button></header>
        {!viewsOn && <p className="muted small pad">Saved views need a newer Living Memory, with the <code>views</code> command. You can still build and run a query here.</p>}
        {viewsOn && query.error && <p className="error small pad">{classify(query.error).message}</p>}
        {viewsOn && !query.isLoading && !query.error && !rows.length && <p className="muted small pad">No saved views yet. Save a query here, or turn on Dashboard on a note's page.</p>}
        <ul>
          {rows.map((v) => (
            <li key={viewKey(v)}>
              <button type="button" className={`link-row${viewKey(v) === ref ? " on" : ""}`} aria-current={viewKey(v) === ref} onClick={() => open(viewKey(v))}>
                {titleOf(v)} <span className="muted small">{v.kind === "query" ? "Query" : "Note"}</span>
                {v.kind === "note" && v.note_title === null && <span className="status-chip bad">note missing</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="views-editor">
        {picked?.kind === "note" ? <DashboardView key={ref} row={picked} /> : (
          <>
            <QueryFormFields form={form} onChange={setForm} notebooks={choices} />
            {bad && <p className="error small">{bad}</p>}
            {!made.ok && <p className="error small">{made.error}.</p>}
            <div className="query-save">
              <input aria-label="View name" placeholder="Name this view to save it" maxLength={TITLE_MAX} value={name} onChange={(e) => setName(e.target.value)} />
              <button type="button" className="primary" disabled={!made.ok || !name.trim() || !savingOn} onClick={() => void save()}
                title={savingOn ? undefined : "Saving a view needs a newer Living Memory (views version 2)"}>Save view</button>
              <button type="button" disabled={!made.ok} onClick={copyBlock} title="Copy this query as a block to paste into a page">Copy as page block</button>
              {queryView && <button type="button" className="danger-text" disabled={!savingOn} onClick={() => void remove()}>Delete view</button>}
            </div>
            {made.ok && <QueryRun spec={made.spec} />}
          </>
        )}
      </div>
    </section>
  );
}
