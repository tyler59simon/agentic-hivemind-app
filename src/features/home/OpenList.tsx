// The open list: tasks and milestones by due date, then the undated tasks by note or page. Ticking a task writes it back through
// `tickTask` and offers Undo; a milestone row opens the milestones dialog.
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Flag } from "lucide-react";
import { useState } from "react";
import { classify } from "../../lib/errors";
import type { Milestone } from "../../lib/executive";
import { refreshStore } from "../../lib/refresh";
import { toast } from "../../ui/toast";
import { OwnerChip } from "../people/OwnerChip";
import { refreshLists } from "../notes/pageWrite";
import type { TaskItem } from "../notes/taskList";
import { displayText } from "../notes/tasks";
import { openSource, tickTask } from "../notes/useTaskItems";
import type { Entry, HomeSections, UndatedGroup } from "./home";

/** Tick a task and offer Undo. Tracks in-flight and recently-ticked IDs so concurrent clicks and re-index lag cannot double-tick. */
export function useTick() {
  const client = useQueryClient();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const update = (setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, id: string, add: boolean) => {
    setter((prev) => {
      const next = new Set(prev);
      if (add) next.add(id); else next.delete(id);
      return next;
    });
  };
  const tick = async (t: TaskItem, next: boolean): Promise<void> => {
    if (busy.has(t.id) || (next && ticked.has(t.id))) return;
    update(setBusy, t.id, true);
    if (!next) update(setTicked, t.id, false);
    try {
      const state = await tickTask(t, next);
      if (next) {
        update(setTicked, t.id, true);
        setTimeout(() => update(setTicked, t.id, false), 1500);
      }
      // The line is ticked now, in a page whose hash has changed: undo checks the line, not the hash it was listed at.
      if (next && state !== "unsaved") toast(`Done: ${displayText(t.text)}`, "info", { label: "Undo", run: () => void tick({ ...t, done: true, sha256: undefined }, false) });
    } catch (e) {
      update(setTicked, t.id, false);
      toast(classify(e).message, "error");
    } finally {
      update(setBusy, t.id, false);
      refreshLists(client);
      void refreshStore(client);
    }
  };
  return { tick, isBusy: (id: string) => busy.has(id) || ticked.has(id), isTicked: (id: string) => ticked.has(id) };
}

type Tick = ReturnType<typeof useTick>;

function TaskRow({ t, today, ticks }: { t: TaskItem; today: string; ticks: Tick }) {
  const overdue = !!t.due && t.due < today;
  const done = ticks.isTicked(t.id);
  return (
    <li>
      <input type="checkbox" checked={done} disabled={ticks.isBusy(t.id)} aria-label={`Tick ${displayText(t.text)}`} onChange={() => void ticks.tick(t, true)} />
      <span className="task-text">{displayText(t.text)}</span>
      {t.priority && <span className="chip small" title="Priority">{t.priority}</span>}
      {t.owner && <OwnerChip owner={t.owner} />}
      {t.due && <span className={`chip small${overdue ? " overdue" : ""}`} title="Due date">{t.due}</span>}
      <button className="link task-page" onClick={() => openSource(t)} title={t.kind === "action" ? "Open the note" : `Open ${t.path}`}>{t.title || t.path}</button>
    </li>
  );
}

function MilestoneRow({ m, today, onOpen }: { m: Milestone; today: string; onOpen: (m: Milestone) => void }) {
  const overdue = m.status === "missed" || (!!m.due && m.due < today);
  return (
    <li className="milestone-row">
      <Flag size="1.1em" aria-label="Milestone" />
      <button className="link task-text" onClick={() => onOpen(m)} title="Open the milestone">{m.title}</button>
      {m.status === "at_risk" && <span className="chip small" title="Marked at risk">at risk</span>}
      {m.due && <span className={`chip small${overdue ? " overdue" : ""}`} title="Due date">{m.due}</span>}
    </li>
  );
}

/** The rows of some entries: a checkbox for a task, a flag for a milestone. */
export function EntryRows({ entries, today, ticks, onMilestone }: { entries: Entry[]; today: string; ticks: Tick; onMilestone: (m: Milestone) => void }) {
  return (
    <ul className="task-list">
      {entries.map((e) => e.kind === "task"
        ? <TaskRow key={e.task.id} t={e.task} today={today} ticks={ticks} />
        : <MilestoneRow key={`milestone:${e.milestone.id}`} m={e.milestone} today={today} onOpen={onMilestone} />)}
    </ul>
  );
}

function Undated({ group, today, ticks }: { group: UndatedGroup; today: string; ticks: Tick }) {
  const [open, setOpen] = useState(false);
  const Caret = open ? ChevronDown : ChevronRight;
  return (
    <li className="undated-group">
      <button className="link-row undated-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Caret size="1.1em" aria-hidden />
        <strong>{group.title}</strong>
        <span className="muted small">{group.count} · {group.where}</span>
      </button>
      {open
        ? <ul className="task-list">{group.items.map((t) => <TaskRow key={t.id} t={t} today={today} ticks={ticks} />)}</ul>
        : <p className="muted small undated-first">{displayText(group.first.text)}{group.count > 1 ? ` (+${group.count - 1} more)` : ""}</p>}
    </li>
  );
}

function Group({ label, children, count }: { label: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="task-group">
      <h3>{label} <span className="muted small">{count}</span></h3>
      {children}
    </div>
  );
}

/** The open work of one scope by section. `empty` is said when nothing is open. */
export function OpenList({ sections, today, ticks, onMilestone, empty }: { sections: HomeSections; today: string; ticks: Tick; onMilestone: (m: Milestone) => void; empty: string }) {
  const soon = [...sections.today, ...sections.week];
  const none = !sections.overdue.length && !soon.length && !sections.later.length && !sections.undated.length;
  const rows = (entries: Entry[]) => <EntryRows entries={entries} today={today} ticks={ticks} onMilestone={onMilestone} />;
  if (none) return <p className="muted">{empty}</p>;
  return (
    <>
      <Group label="Overdue" count={sections.overdue.length}>{rows(sections.overdue)}</Group>
      <Group label="Today and this week" count={soon.length}>{rows(soon)}</Group>
      <Group label="Later" count={sections.later.length}>{rows(sections.later)}</Group>
      <Group label="No due date" count={sections.undated.length}>
        <ul className="task-list undated-list">{sections.undated.map((g) => <Undated key={g.key} group={g} today={today} ticks={ticks} />)}</ul>
      </Group>
    </>
  );
}
