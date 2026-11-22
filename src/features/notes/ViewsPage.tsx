// The Views sub-view of the Notes page (NS-7B): saved queries of the folder notebooks, and a form to make one. A view is the
// query form's JSON in a file of a folder notebook (`.hivemind/queries/<name>.json`); it can look into any notebook. The
// same JSON in a ```query block of a page shows the table or board in the page's Reading view.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { lmContainer } from "../../documents/adapters/lmdoc";
import { useDocsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { lmNotebooksQuery } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { toast } from "../../ui/toast";
import { QueryFormFields } from "./QueryForm";
import { QueryRun } from "./QueryView";
import { deleteQueryView, formOf, newSpec, parseSpec, queryBlock, saveQueryView, specOf, viewsQuery, type QueryForm } from "./queries";

interface Picked { notebook: string; name: string }

export function ViewsPage() {
  const client = useQueryClient();
  const folders = useQuery(notebooksQuery());
  const docs = useDocsEnabled();
  const living = useQuery({ ...lmNotebooksQuery(), enabled: docs });
  const lists = useQueries({ queries: (folders.data ?? []).map((n) => viewsQuery(n.id)) });
  const saved = useMemo(() => (folders.data ?? []).flatMap((n, i) => (lists[i]?.data ?? []).map((v) => ({ notebook: n.id, notebookTitle: n.title, ...v }))), [folders.data, lists]); // eslint-disable-line react-hooks/exhaustive-deps
  const choices = useMemo(() => [
    ...(folders.data ?? []).map((n) => ({ id: n.id, title: n.title })),
    ...(living.data?.notebooks ?? []).map((n) => ({ id: lmContainer(n.domain, n.notebook), title: `${n.domain} · ${n.title}` })),
  ], [folders.data, living.data]);

  const [picked, setPicked] = useState<Picked | null>(null);
  const [form, setForm] = useState<QueryForm>(() => formOf(newSpec()));
  const [name, setName] = useState("");
  const [saveIn, setSaveIn] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  useEffect(() => { if (!saveIn && folders.data?.length) setSaveIn(folders.data[0].id); }, [folders.data, saveIn]);

  const made = useMemo(() => specOf(form), [form]);
  const open = (v: (typeof saved)[number]) => {
    setPicked({ notebook: v.notebook, name: v.name });
    setName(v.name);
    setSaveIn(v.notebook);
    const parsed = parseSpec(v.spec);
    if (parsed.ok) { setForm(formOf(parsed.spec)); setBad(null); } else setBad(`${v.name} is not a valid view: ${parsed.error}.`);
  };
  const fresh = () => { setPicked(null); setName(""); setBad(null); setForm(formOf(newSpec())); };
  const refresh = (notebook: string) => client.invalidateQueries({ queryKey: ["query-views", notebook] });

  const save = async () => {
    if (!made.ok || !name.trim() || !saveIn) return;
    try {
      await saveQueryView(saveIn, name.trim(), made.spec);
      // Saved under another name or in another notebook: the old one stays, as a copy.
      setPicked({ notebook: saveIn, name: name.trim() });
      await refresh(saveIn);
      toast(`Saved the view ${name.trim()}`);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };
  const remove = async () => {
    if (!picked) return;
    try {
      await deleteQueryView(picked.notebook, picked.name);
      await refresh(picked.notebook);
      fresh();
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
        <header className="views-head"><h1>Views</h1><button type="button" onClick={fresh}>New view</button></header>
        {!folders.data?.length && <p className="muted small pad">Saved views are kept in a folder notebook. Add one to save a view; you can still build and run a query here.</p>}
        {(folders.data?.length ?? 0) > 0 && !saved.length && <p className="muted small pad">No saved views yet.</p>}
        <ul>
          {saved.map((v) => (
            <li key={`${v.notebook}:${v.name}`}>
              <button type="button" className={`link-row${picked?.notebook === v.notebook && picked.name === v.name ? " on" : ""}`} onClick={() => open(v)}>{v.name} <span className="muted small">{v.notebookTitle}</span></button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="views-editor">
        <QueryFormFields form={form} onChange={setForm} notebooks={choices} />
        {bad && <p className="error small">{bad}</p>}
        {!made.ok && <p className="error small">{made.error}.</p>}
        <div className="query-save">
          <input aria-label="View name" placeholder="Name this view to save it" value={name} onChange={(e) => setName(e.target.value)} />
          {(folders.data?.length ?? 0) > 1 && (
            <select aria-label="Save in" value={saveIn} onChange={(e) => setSaveIn(e.target.value)}>
              {(folders.data ?? []).map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
            </select>
          )}
          <button type="button" className="primary" disabled={!made.ok || !name.trim() || !saveIn} onClick={() => void save()}>Save view</button>
          <button type="button" disabled={!made.ok} onClick={copyBlock} title="Copy this query as a block to paste into a page">Copy as page block</button>
          {picked && <button type="button" className="danger-text" onClick={() => void remove()}>Delete view</button>}
        </div>
        {made.ok && <QueryRun spec={made.spec} />}
      </div>
    </section>
  );
}
