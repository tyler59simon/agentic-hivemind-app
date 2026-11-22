// The Tasks view of the Notes page (NS-7B): every `- [ ]` and `- [x]` line of the folder notebooks' pages (from the index) and
// of Living Memory notebook pages (`doc tasks`), and the open action items of Living Memory work notes. Ticking one writes
// back: a page through a checked save of that one line, an action item through `check`.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { lmContainer } from "../../documents/adapters/lmdoc";
import { useConnection, useDocsEnabled, useDocsSearch } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { check, docTasks, domainOf, lmNotebooksQuery, openWork } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { INDEX_KEY, indexTasks } from "../../lib/noteindex";
import { useApp } from "../../store";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { openPage } from "./actions";
import { refreshLists } from "./pageWrite";
import { filterTasks, groupTasks, itemOf, sortTasks, type DoneFilter, type DueFilter, type Grouping, type TaskItem } from "./taskList";
import { displayText, isoDate } from "./tasks";
import { setTaskDone } from "./writes";

const ACTIONS = "@actions";

/** The tasks of every source, as rows. A source that cannot answer is said apart, so the others still show. */
function useTaskItems(done: DoneFilter) {
  const docs = useDocsEnabled();
  const search = useDocsSearch();
  const actionsOn = useConnection((s) => s.commands.includes("open"));
  const folders = useQuery(notebooksQuery());
  const living = useQuery({ ...lmNotebooksQuery(), enabled: docs });
  const folder = useQuery({ queryKey: [INDEX_KEY, "tasks", done], queryFn: () => indexTasks({ done: done === "all" ? undefined : done === "done" }) });
  const lm = useQuery({ queryKey: ["lm-tasks", done], queryFn: () => docTasks({ open: done === "open" }), enabled: search });
  const actions = useQuery({ queryKey: ["lm-actions"], queryFn: () => openWork({ allDomains: true, limit: 200 }), enabled: actionsOn && done !== "done" });

  const items = useMemo<TaskItem[]>(() => {
    const names = new Map((folders.data ?? []).map((n) => [n.id, n.title]));
    const lmNames = new Map((living.data?.notebooks ?? []).map((n) => [lmContainer(n.domain, n.notebook), `${n.domain} · ${n.title}`]));
    const out: TaskItem[] = (folder.data ?? []).map((t) => itemOf({
      id: `${t.notebook}:${t.path}:${t.line}`, kind: "line", notebook: t.notebook, notebookTitle: names.get(t.notebook) ?? t.notebook, path: t.path, title: t.title,
      line: t.line, done: t.done, text: t.text, sha256: t.sha256,
    }, t.due));
    for (const t of lm.data ?? []) {
      const id = lmContainer(t.domain, t.notebook);
      out.push(itemOf({ id: `${id}:${t.path}:${t.line}`, kind: "line", notebook: id, notebookTitle: lmNames.get(id) ?? `${t.domain} · ${t.notebook}`, path: t.path, title: t.title, line: t.line, done: t.done, text: t.text }, t.due));
    }
    for (const a of actions.data?.items ?? []) {
      out.push(itemOf({ id: `${a.ref}:${a.index}`, kind: "action", notebook: domainOf(a.ref), notebookTitle: `${domainOf(a.ref)} · action items`, path: a.title, title: a.title, line: a.index, done: false, text: a.item, ref: a.ref, index: a.index }, null));
    }
    return out;
  }, [folder.data, lm.data, actions.data, folders.data, living.data]);

  const problems = [
    folder.error && `Folder notebooks: ${classify(folder.error).message}`,
    lm.error && `Living Memory notebooks: ${classify(lm.error).message}`,
    actions.error && `Action items: ${classify(actions.error).message}`,
  ].filter(Boolean) as string[];
  return { items, problems, loading: folder.isLoading || lm.isLoading || actions.isLoading, folders: folders.data ?? [], living: living.data?.notebooks ?? [], actionsOn, search };
}

/** Open the page (or note) a task is in. */
function openSource(t: TaskItem) {
  if (t.kind !== "action") {
    openPage({ notebook: t.notebook, path: t.path });
    return;
  }
  useApp.getState().setDomain(t.notebook);
  useWorkspace.getState().openNote(t.ref!, { title: t.title });
  useApp.getState().go({ page: "notes" }, { replace: true });
}

export function TasksView() {
  const client = useQueryClient();
  const [done, setDone] = useState<DoneFilter>("open");
  const [due, setDue] = useState<DueFilter>("any");
  const [notebook, setNotebook] = useState("");
  const [text, setText] = useState("");
  const [group, setGroup] = useState<Grouping>("none");
  const [busy, setBusy] = useState<string | null>(null);
  const { items, problems, loading, folders, living, actionsOn } = useTaskItems(done);
  const today = isoDate(new Date());
  const shown = useMemo(() => sortTasks(filterTasks(items, { notebook, due, done, text }, today)), [items, notebook, due, done, text, today]);
  const groups = useMemo(() => groupTasks(shown, group, today), [shown, group, today]);

  const tick = async (t: TaskItem, next: boolean) => {
    setBusy(t.id);
    try {
      if (t.kind === "action") await check(t.ref!, t.index!, next);
      else if (await setTaskDone({ notebook: t.notebook, path: t.path, line: t.line, done: t.done, text: t.text, sha256: t.sha256 }, next) === "unsaved") {
        toast("Ticked in the open page. It has unsaved edits, so save the page to keep the change.", "info");
      }
    } catch (e) {
      toast(classify(e).message, "error");
    } finally {
      setBusy(null);
      refreshLists(client);
    }
  };

  return (
    <section className="tasks-view" aria-label="Tasks">
      <header className="views-head">
        <h1>Tasks</h1>
        <span className="muted small">{loading ? "Reading…" : `${shown.length} of ${items.length}`}</span>
      </header>
      <div className="views-filters" aria-label="Task filters">
        <select aria-label="Notebook" value={notebook} onChange={(e) => setNotebook(e.target.value)}>
          <option value="">All notebooks</option>
          {folders.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
          {living.map((n) => <option key={lmContainer(n.domain, n.notebook)} value={lmContainer(n.domain, n.notebook)}>{n.domain} · {n.title}</option>)}
          {actionsOn && <option value={ACTIONS}>Memory action items</option>}
        </select>
        <select aria-label="Due" value={due} onChange={(e) => setDue(e.target.value as DueFilter)}>
          <option value="any">Any due date</option><option value="overdue">Overdue</option><option value="today">Due today</option>
          <option value="week">Due this week</option><option value="none">No due date</option>
        </select>
        <select aria-label="Done" value={done} onChange={(e) => setDone(e.target.value as DoneFilter)}>
          <option value="open">Open</option><option value="done">Done</option><option value="all">Open and done</option>
        </select>
        <input aria-label="Text" placeholder="Filter by text" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Group by" value={group} onChange={(e) => setGroup(e.target.value as Grouping)}>
          <option value="none">No grouping</option><option value="page">Group by page</option><option value="due">Group by due date</option><option value="notebook">Group by notebook</option>
        </select>
      </div>
      {problems.map((p) => <p key={p} className="error small pad">{p}</p>)}
      {!loading && !shown.length && <p className="muted pad">{items.length ? "No task matches these filters." : "No tasks yet. A task is a line like \"- [ ] call Ana 📅 2026-12-01\" in a page."}</p>}
      {groups.map((g) => (
        <div key={g.key} className="task-group">
          {g.label && <h2>{g.label} <span className="muted small">{g.items.length}</span></h2>}
          <ul className="task-list">
            {g.items.map((t) => {
              const overdue = !t.done && !!t.due && t.due < today;
              return (
                <li key={t.id} className={t.done ? "done" : ""}>
                  <input type="checkbox" checked={t.done} disabled={busy === t.id} aria-label={`${t.done ? "Reopen" : "Tick"} ${displayText(t.text)}`} onChange={(e) => void tick(t, e.target.checked)} />
                  <span className="task-text">{displayText(t.text)}</span>
                  {t.priority && <span className="chip small" title="Priority">{t.priority}</span>}
                  {t.due && <span className={`chip small${overdue ? " overdue" : ""}`} title="Due date">{t.due}</span>}
                  <button className="link task-page" onClick={() => openSource(t)} title={t.kind === "action" ? "Open the note" : `Open ${t.path}`}>{t.title || t.path}</button>
                  <span className="muted small task-notebook">{t.notebookTitle}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
