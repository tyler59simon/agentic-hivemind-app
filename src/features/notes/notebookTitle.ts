import { useQuery } from "@tanstack/react-query";
import { notebooksQuery } from "../../lib/notebooks";

/** What to call the notebook a page belongs to: its title, or undefined for a loose file or a notebook not in the list. */
export function useNotebookTitle(container: string | undefined, enabled = true): string | undefined {
  const folders = useQuery({ ...notebooksQuery(), enabled: enabled && !!container });
  return container ? folders.data?.find((n) => n.id === container)?.title : undefined;
}
