// Daily pages and templates that need a notebook (NS-7A): the settings a notebook resolves to, making a day's page from its
// template, and reading a template. No workspace or tab code here, so the Quick capture window can use it too.
import { parseLm } from "../../documents/adapters/lmdoc";
import { createDoc, readDoc } from "../../documents/io";
import { docNotebooks } from "../../lib/lm";
import { listNotebooks, notebookMeta, obsidianSetting, pageTitle } from "../../lib/notebooks";
import { dailyPath, expandTemplate, resolveDaily, templatePath, type DailySettings } from "./daily";

/** A notebook's name and daily settings. */
export interface NotebookInfo {
  title: string;
  settings: DailySettings;
  /** Whether Hivemind can store daily settings for it: a folder notebook always, a Living Memory notebook only when its Living
   *  Memory reports notebook settings (NS-7A). */
  editable: boolean;
  /** The settings as stored, for the settings dialog. */
  stored: Record<string, unknown> | undefined;
}

/** The notebook's name and what its daily notes and templates are set to. A Living Memory notebook reads them from its
 *  `settings`, a folder notebook from its sidecar, falling back to the vault's own Obsidian settings. Without a setting
 *  anywhere the defaults apply. */
export async function loadNotebookInfo(notebook: string): Promise<NotebookInfo> {
  const lm = parseLm(notebook);
  if (lm) {
    const row = (await docNotebooks()).notebooks.find((n) => n.domain === lm.domain && n.notebook === lm.notebook);
    const stored = row?.settings?.daily;
    return {
      title: row?.title ?? lm.notebook, settings: resolveDaily(stored), editable: row?.settings !== undefined,
      stored: stored && typeof stored === "object" ? (stored as Record<string, unknown>) : undefined,
    };
  }
  const [meta, books] = await Promise.all([notebookMeta(notebook).catch(() => ({} as Awaited<ReturnType<typeof notebookMeta>>)), listNotebooks().catch(() => [])]);
  // A vault with no Obsidian settings, or damaged ones, simply has none.
  const [daily, templates] = await Promise.all([
    obsidianSetting(notebook, "daily-notes.json").catch(() => null),
    obsidianSetting(notebook, "templates.json").catch(() => null),
  ]);
  return {
    title: books.find((b) => b.id === notebook)?.title ?? "", settings: resolveDaily(meta.daily, { templates: meta.templates, inbox: meta.inbox }, { daily, templates }),
    editable: true, stored: meta.daily && typeof meta.daily === "object" ? meta.daily : undefined,
  };
}

/** The query that holds a notebook's `NotebookInfo`; settings dialogs invalidate it by the `daily-settings` key. */
export const dailyQuery = (notebook: string) => ({ queryKey: ["daily-settings", notebook], queryFn: () => loadNotebookInfo(notebook) });

/** The day a page was made for: where it is, whether this call made it, and where `{{cursor}}` was in its text. */
export interface DailyPage { path: string; created: boolean; text: string; cursor: number | null; missingTemplate: string | null }

/** The page of `date` in `notebook`, made from the daily template when it does not exist yet; one that exists is left alone.
 *  A template that cannot be read gives an empty page, and says so in `missingTemplate`. */
export async function ensureDaily(notebook: string, date: Date, info?: NotebookInfo): Promise<DailyPage> {
  const { title, settings } = info ?? await loadNotebookInfo(notebook);
  const path = dailyPath(settings, date);
  let text = "";
  let cursor: number | null = null;
  let missingTemplate: string | null = null;
  if (settings.template) {
    try {
      const template = await readDoc({ notebook, path: templatePath(settings.template) });
      ({ text, cursor } = expandTemplate(template.text, { title: pageTitle(path), date, notebook: title }));
    } catch {
      missingTemplate = settings.template;
    }
  }
  try {
    await createDoc(notebook, path, text);
    return { path, created: true, text, cursor, missingTemplate };
  } catch (e) {
    // The page was there already (Living Memory and Rust both say it exists).
    if (!/exists/i.test(String(e instanceof Error ? e.message : e))) throw e;
    return { path, created: false, text: "", cursor: null, missingTemplate: null };
  }
}
