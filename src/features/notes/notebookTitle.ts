import { useQuery } from "@tanstack/react-query";
import { parseLm } from "../../documents/adapters/lmdoc";
import { lmNotebooksQuery, type DocNotebook } from "../../lib/lm";
import { notebooksQuery, type Notebook } from "../../lib/notebooks";

/** What to call the notebook a page belongs to: a folder notebook's title, or a Living Memory notebook's domain and
 *  title as the tree groups them ("demo · Release plans"), never its container id (NS-2C UI pass). */
export function notebookTitle(container: string, folders: Notebook[] | undefined, lm: DocNotebook[] | undefined): string | undefined {
  const ref = parseLm(container);
  if (!ref) return folders?.find((n) => n.id === container)?.title;
  const title = lm?.find((n) => n.domain === ref.domain && n.notebook === ref.notebook)?.title ?? ref.notebook;
  return `${ref.domain} · ${title}`;
}

/** `notebookTitle` for a page's container, asking only the list that can hold it. */
export function useNotebookTitle(container: string | undefined, enabled = true): string | undefined {
  const lm = !!container && !!parseLm(container);
  const folders = useQuery({ ...notebooksQuery(), enabled: enabled && !!container && !lm });
  const docs = useQuery({ ...lmNotebooksQuery(), enabled: enabled && lm });
  return container ? notebookTitle(container, folders.data, docs.data?.notebooks) : undefined;
}
