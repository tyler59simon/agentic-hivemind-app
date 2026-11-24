// The People directory (CON-15): where it lives, who is on it, and whose open tasks are whose.
import { useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { createDoc } from "../../documents/io";
import { INDEX_KEY } from "../../lib/noteindex";
import { metaQuery, notebooksQuery, setNotebookMeta, type NotebookMeta } from "../../lib/notebooks";
import { openPage } from "../notes/actions";
import { newSpec, runQuery } from "../notes/queries";
import type { TaskItem } from "../notes/taskList";
import { isoDate } from "../notes/tasks";
import { useTaskItems } from "../notes/useTaskItems";
import { matchOwner, personFileName, personOf, personPageText, resolvePeople, type PeopleLocation, type Person } from "./people";

/** The People location and the people on it, in title order. `location` is null until it is set up. */
export function usePeople() {
  const notebooks = useQuery(notebooksQuery());
  const list = notebooks.data ?? [];
  const metas = useQueries({ queries: list.map((n) => metaQuery(n.id)) });
  const found = resolvePeople(list, Object.fromEntries(list.map((n, i) => [n.id, metas[i]?.data])));
  const location = useMemo(() => found, [found?.notebook, found?.folder]); // eslint-disable-line react-hooks/exhaustive-deps
  const pages = useQuery({
    queryKey: [INDEX_KEY, "people", location?.notebook, location?.folder],
    queryFn: async () => {
      const spec = { ...newSpec(), from: { notebooks: [location!.notebook], folder: location!.folder, tag: null }, sort: [{ prop: "title", dir: "asc" as const }] };
      return (await runQuery(spec)).rows.map(personOf);
    },
    enabled: !!location,
  });
  return { notebooks: list, metas: Object.fromEntries(list.map((n, i) => [n.id, metas[i]?.data])), location, people: pages.data ?? [], loading: notebooks.isLoading || metas.some((m) => m.isLoading) || pages.isLoading };
}

/** Make the page for `name` in the People folder and open it. A page that already has that file name is opened as it is. */
export async function createPerson(client: QueryClient, location: PeopleLocation, name: string): Promise<void> {
  const path = `${location.folder}/${personFileName(name)}.md`;
  try {
    await createDoc(location.notebook, path, personPageText(name));
  } catch (e) {
    if (!/exists/i.test(String(e))) throw e;
  }
  await Promise.all([client.invalidateQueries({ queryKey: ["notebook-tree", location.notebook] }), client.invalidateQueries({ queryKey: [INDEX_KEY] })]);
  openPage({ notebook: location.notebook, path });
}

/** Make `notebook` the People notebook with `folder`, and take the setting off every other notebook that has it. */
export async function setPeopleLocation(client: QueryClient, notebooks: { id: string }[], metas: Record<string, NotebookMeta | undefined>, notebook: string, folder: string): Promise<void> {
  await setNotebookMeta(notebook, { people: { folder } });
  for (const nb of notebooks) if (nb.id !== notebook && metas[nb.id]?.people !== undefined) await setNotebookMeta(nb.id, { people: null });
  await Promise.all([client.invalidateQueries({ queryKey: ["notebook-meta"] }), client.invalidateQueries({ queryKey: [INDEX_KEY, "people"] })]);
}

/** One person's open tasks and how many of them are overdue. */
export interface Owned { person: Person; items: TaskItem[]; overdue: number }
/** An owner with no page, and the open tasks that name them. */
export interface Unmatched { owner: string; items: TaskItem[] }

/** The open tasks grouped by the person their owner names; owners with no page are listed apart. */
export function useOwnedItems() {
  const { people, location, loading: peopleLoading } = usePeople();
  const { items, problems, loading } = useTaskItems("open");
  const today = isoDate(new Date());
  const grouped = useMemo(() => {
    const owned = new Map<string, Owned>(people.map((p) => [p.path, { person: p, items: [], overdue: 0 }]));
    const unmatched = new Map<string, Unmatched>();
    for (const t of items) {
      const owner = t.owner?.trim();
      if (!owner) continue;
      const person = matchOwner(people, owner);
      if (person) {
        const row = owned.get(person.path)!;
        row.items.push(t);
        if (t.due && t.due < today) row.overdue++;
      } else {
        const row = unmatched.get(owner.toLowerCase()) ?? { owner, items: [] };
        row.items.push(t);
        unmatched.set(owner.toLowerCase(), row);
      }
    }
    return { owned: [...owned.values()], unmatched: [...unmatched.values()].sort((a, b) => a.owner.localeCompare(b.owner)) };
  }, [people, items, today]);
  return { ...grouped, location, problems, loading: loading || peopleLoading };
}
