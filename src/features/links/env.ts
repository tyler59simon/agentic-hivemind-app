// The world a link is resolved in (NS-4A): the registered notebooks, the pages the index holds for each, and the memory notes.
import type { QueryClient } from "@tanstack/react-query";
import { list } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { pagesQuery, type IndexedPage } from "../../lib/noteindex";
import type { MemoryNote, PageEnv } from "./resolve";

/** The memory notes the resolver knows, under the key the palette uses. */
export const memoryNotesQuery = () => ({ queryKey: ["list", "*"], queryFn: () => list({ allDomains: true }) });

/** The world a link is resolved in: registered notebooks, their indexed pages and the memory notes. A source that fails
 *  to load leaves its part empty, so links still resolve inside the page's own notebook. */
export async function loadEnv(client: QueryClient, pagesStaleMs = 5_000): Promise<PageEnv> {
  const [notebooks, indexed, notes] = await Promise.all([
    client.fetchQuery({ ...notebooksQuery(), staleTime: 5_000 }).catch(() => []),
    client.fetchQuery({ ...pagesQuery(), staleTime: pagesStaleMs }).catch(() => [] as IndexedPage[]),
    client.fetchQuery({ ...memoryNotesQuery(), staleTime: 60_000 }).catch(() => null),
  ]);
  return buildEnv(notebooks, indexed, (notes?.notes ?? []).map((n) => ({ ref: n.ref, title: n.title, domain: n.domain })));
}

export function buildEnv(notebooks: { id: string; title: string }[], indexed: { notebook: string; path: string }[], memory: MemoryNote[]): PageEnv {
  const by = new Map<string, string[]>();
  for (const page of indexed) {
    const list = by.get(page.notebook);
    if (list) list.push(page.path); else by.set(page.notebook, [page.path]);
  }
  return { notebooks: notebooks.map((n) => ({ id: n.id, title: n.title })), pagesOf: (id) => by.get(id), memory };
}

