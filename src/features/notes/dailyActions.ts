// What the user does with daily pages and templates on the Notes page (NS-7A): open Today or another day, and start a page
// from a template. The pages themselves are made by `dailyPages.ts`.
import type { QueryClient } from "@tanstack/react-query";
import { readDoc, treeQuery } from "../../documents/io";
import { keyOf, useDocuments } from "../../documents/store";
import type { FileRef } from "../../documents/keys";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { createUnique, openPage } from "./actions";
import { expandTemplate, lineAndColumn, templatesIn } from "./daily";
import { ensureDaily, loadNotebookInfo } from "./dailyPages";

/** Put the cursor at `cursor` (an offset in the page's text) once the page has loaded in its tab. The editor takes the line
 *  and column from the tab's reveal request. */
export function placeCursor(ref: FileRef, text: string, cursor: number) {
  const key = keyOf(ref);
  const { line, col } = lineAndColumn(text, cursor);
  const ready = () => { const s = useDocuments.getState().docs[key]?.status; return !!s && s !== "loading"; };
  const go = () => {
    const tab = useWorkspace.getState().panes.flatMap((p) => p.tabs).find((t) => t.kind === "file" && t.file && keyOf(t.file) === key);
    if (tab) useWorkspace.getState().revealLine(tab.id, line, col);
  };
  if (ready()) { go(); return; }
  const stop = useDocuments.subscribe(() => { if (ready()) { stop(); go(); } });
  setTimeout(stop, 5000);
}

/** Open the daily page of `date`, making it from the daily template when it does not exist. */
export async function openDay(client: QueryClient, notebook: string, date: Date) {
  const day = await ensureDaily(notebook, date);
  if (day.missingTemplate) toast(`The daily template ${day.missingTemplate} was not found, so the page is empty.`, "warn");
  if (day.created) client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  const ref = { notebook, path: day.path };
  openPage(ref);
  if (day.created && day.cursor !== null) placeCursor(ref, day.text, day.cursor);
  return ref;
}

export const openToday = (client: QueryClient, notebook: string) => openDay(client, notebook, new Date());

/** The templates of a notebook: the Markdown pages under its templates folder. */
export async function listTemplates(client: QueryClient, notebook: string): Promise<string[]> {
  const [{ settings }, tree] = await Promise.all([loadNotebookInfo(notebook), client.fetchQuery({ ...treeQuery(notebook), staleTime: 0 })]);
  return templatesIn(tree.entries.filter((e) => e.kind === "page").map((e) => e.path), settings.templates);
}

/** Make a page from `template` (a page of the notebook) under a free name in `folder` and open it. `{{title}}` is the page's
 *  name, `{{project}}` the picked project's name. */
export async function newPageFromTemplate(client: QueryClient, opts: { notebook: string; folder: string; template: string; title: string; project?: string }) {
  const { notebook, folder, template, project } = opts;
  const [source, info] = await Promise.all([readDoc({ notebook, path: template }), loadNotebookInfo(notebook)]);
  const now = new Date();
  let made: { text: string; cursor: number | null } = { text: "", cursor: null };
  const path = await createUnique(notebook, folder, opts.title.trim() || "Untitled", (name) => {
    made = expandTemplate(source.text, { title: name, date: now, notebook: info.title, project });
    return made.text;
  });
  client.invalidateQueries({ queryKey: ["notebook-tree", notebook] });
  const ref = { notebook, path };
  openPage(ref);
  if (made.cursor !== null) placeCursor(ref, made.text, made.cursor);
  return ref;
}
