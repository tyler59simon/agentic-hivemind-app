// The Tasks view of the Notes page (NS-7B): every `- [ ]` and `- [x]` line of the folder notebooks' pages (from the index) and
// of Living Memory notebook pages (`doc tasks`), and the open action items of Living Memory work notes, read by `useTaskItems`.
// Ticking one writes back through `tickTask`.
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { lmContainer } from "../../documents/adapters/lmdoc";
import { classify } from "../../lib/errors";
import { toast } from "../../ui/toast";
import { refreshLists } from "./pageWrite";
import { filterTasks, groupTasks, sortTasks, type DoneFilter, type DueFilter, type Grouping, type TaskItem } from "./taskList";
import { displayText, isoDate } from "./tasks";
import { openSource, tickTask, useTaskItems } from "./useTaskItems";

const ACTIONS = "@actions";

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
      await tickTask(t, next);
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
                  {t.owner && <span className="chip small" title="Owner">{t.owner}</span>}
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
