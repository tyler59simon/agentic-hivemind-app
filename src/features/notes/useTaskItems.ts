// The rows of the Tasks view and of Home: every `- [ ]` and `- [x]` line of the folder notebooks' pages (from Hivemind's own
// index) and the open action items of Living Memory work notes, each with its due date, owner and priority from `fieldsOf`. Ticking one writes back: a page through a checked save of that one line, an action item
// through `check`.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useConnection, useOpenPagesFlag } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { check, domainOf, openWork } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { INDEX_KEY, indexTasks } from "../../lib/noteindex";
import { recordOperation } from "../../lib/oplog";
import { useApp } from "../../store";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { openPage } from "./actions";
import { itemOf, type DoneFilter, type TaskItem } from "./taskList";
import { setTaskDone } from "./writes";

/** The tasks of every source, as rows. A source that cannot answer is said apart, so the others still show. */
export function useTaskItems(done: DoneFilter) {
  const actionsOn = useConnection((s) => s.commands.includes("open"));
  const openPagesFlag = useOpenPagesFlag();
  const folders = useQuery(notebooksQuery());
  const folder = useQuery({ queryKey: [INDEX_KEY, "tasks", done], queryFn: () => indexTasks({ done: done === "all" ? undefined : done === "done" }) });
  const actions = useQuery({
    queryKey: ["lm-actions", openPagesFlag],
    queryFn: () => openWork({ allDomains: true, limit: 1000, ...(openPagesFlag ? { pages: "none" as const } : {}) }),
    enabled: actionsOn && done !== "done",
  });

  const items = useMemo<TaskItem[]>(() => {
    const names = new Map((folders.data ?? []).map((n) => [n.id, n.title]));
    const out: TaskItem[] = (folder.data ?? []).map((t) => itemOf({
      id: `${t.notebook}:${t.path}:${t.line}`, kind: "line", notebook: t.notebook, notebookTitle: names.get(t.notebook) ?? t.notebook, path: t.path, title: t.title,
      line: t.line, done: t.done, text: t.text, sha256: t.sha256,
    }, t.due));
    for (const a of actions.data?.items ?? []) {
      if (a.kind === "page" || !a.ref) continue;
      out.push(itemOf({ id: `${a.ref}:${a.index}`, kind: "action", notebook: domainOf(a.ref), notebookTitle: `${domainOf(a.ref)} · action items`, path: a.title, title: a.title, line: a.index, done: false, text: a.item, ref: a.ref, index: a.index, revision: a.revision, updated: a.updated }, null));
    }
    return out;
  }, [folder.data, actions.data, folders.data]);

  const problems = [
    folder.error && `Folder notebooks: ${classify(folder.error).message}`,
    actions.error && `Action items: ${classify(actions.error).message}`,
  ].filter(Boolean) as string[];
  return { items, problems, loading: folder.isLoading || actions.isLoading, folders: folders.data ?? [], actionsOn };
}

/** What a tick did: `unsaved` when it went into an open page with unsaved edits. `revision` is an action item's note revision
 *  after the tick, for its Undo. */
export interface Ticked { state: "saved" | "unsaved"; revision?: string }

/** Tick (or clear) one task: an action item through `check` with the note revision it was listed at, a page line through a
 *  checked save of that line. Says so when the line is in an open page with unsaved edits, which stays unsaved. Throws when the
 *  write is refused (a note changed since it was listed is `stale`); the caller shows it and asks the lists to read again. */
export async function tickTask(t: TaskItem, next: boolean): Promise<Ticked> {
  if (t.kind === "action") {
    const r = await check(t.ref!, t.index!, next, t.revision ?? "");
    recordOperation(r.operation_id);
    return { state: "saved", revision: r.revisions?.[t.ref!] };
  }
  const res = await setTaskDone({ notebook: t.notebook, path: t.path, line: t.line, done: t.done, text: t.text, sha256: t.sha256 }, next);
  if (res === "unsaved") {
    toast("Ticked in the open page. It has unsaved edits, so save the page to keep the change.", "info");
    return { state: "unsaved" };
  }
  return { state: "saved" };
}

/** Open the page (or note) a task is in. */
export function openSource(t: TaskItem) {
  if (t.kind !== "action") {
    openPage({ notebook: t.notebook, path: t.path });
    return;
  }
  useApp.getState().setDomain(t.notebook);
  useWorkspace.getState().openNote(t.ref!, { title: t.title });
}
