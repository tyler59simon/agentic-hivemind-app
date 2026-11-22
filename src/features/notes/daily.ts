// Daily notes and templates (NS-7A), as pure functions: date formatting with Moment-style tokens (the ones Obsidian uses),
// the daily page's path and the date a path names, the settings a notebook resolves to, and template expansion. Dates are
// the local time zone: "today" changes at local midnight.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The week of the year that starts on Sunday and holds January 1 as its first week, which is Moment's `w` for English
 *  (Obsidian's default). */
function localWeek(d: Date): number {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const day = Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 86_400_000);
  return Math.floor((day + jan1.getDay()) / 7) + 1;
}

/** The ISO 8601 week number (weeks start on Monday, week 1 holds the first Thursday), Moment's `W`. */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

/** The tokens `formatDate` knows, longest first within a letter; `[text]` is copied as it is. */
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|dd|d|WW|W|ww|w|HH|H|hh|h|mm|m|ss|s|A|a|Q/g;

/** `date` as Moment would write it with `format`: YYYY YY MMMM MMM MM M DD D dddd ddd dd d (day of the week) WW W (ISO week)
 *  ww w (week of the year, from Sunday) HH H hh h mm m ss s A a Q, and `[text]` for letters that are not tokens. Other
 *  characters, `/` and `-` included, are kept. */
export function formatDate(date: Date, format: string): string {
  const hours12 = date.getHours() % 12 || 12;
  const out: Record<string, string> = {
    YYYY: pad(date.getFullYear(), 4), YY: pad(date.getFullYear() % 100), MMMM: MONTHS[date.getMonth()], MMM: MONTHS[date.getMonth()].slice(0, 3),
    MM: pad(date.getMonth() + 1), M: String(date.getMonth() + 1), DD: pad(date.getDate()), D: String(date.getDate()),
    dddd: DAYS[date.getDay()], ddd: DAYS[date.getDay()].slice(0, 3), dd: DAYS[date.getDay()].slice(0, 2), d: String(date.getDay()),
    WW: pad(isoWeek(date)), W: String(isoWeek(date)), ww: pad(localWeek(date)), w: String(localWeek(date)),
    HH: pad(date.getHours()), H: String(date.getHours()), hh: pad(hours12), h: String(hours12),
    mm: pad(date.getMinutes()), m: String(date.getMinutes()), ss: pad(date.getSeconds()), s: String(date.getSeconds()),
    A: date.getHours() < 12 ? "AM" : "PM", a: date.getHours() < 12 ? "am" : "pm", Q: String(Math.floor(date.getMonth() / 3) + 1),
  };
  return format.replace(TOKEN, (m, literal: string | undefined) => (literal !== undefined ? literal : out[m]));
}

/** What a notebook's daily notes and templates are set to. */
export interface DailySettings {
  /** The folder daily pages live in ("" is the notebook's top level). */
  folder: string;
  /** The date format of a daily page's name, without `.md`; it may hold `/` for folders (`YYYY/MM/YYYY-MM-DD`). */
  format: string;
  /** The page a new daily page starts from, or null for an empty page. */
  template: string | null;
  /** The folder templates are kept in. */
  templates: string;
  /** The inbox page Quick capture adds to. */
  inbox: string;
}

export const DEFAULT_DAILY: DailySettings = { folder: "Daily", format: "YYYY-MM-DD", template: null, templates: "Templates", inbox: "Inbox.md" };

/** The settings as stored: the `daily` object of a notebook's sidecar (folder notebooks) or `settings` (Living Memory
 *  notebooks). Any field may be missing, and a field of the wrong kind is ignored. */
export type StoredDaily = Partial<{ folder: string; format: string; template: string | null; templates: string; inbox: string }>;

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const clean = (v: string | undefined) => v?.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/** What an Obsidian vault says (`.obsidian/daily-notes.json` and `templates.json`), read-only. */
export interface ObsidianSettings { daily?: unknown; templates?: unknown }

/** The settings a notebook works with. A value the user set in Hivemind wins, then the vault's own Obsidian setting, then
 *  the default. A folder notebook's older top-level `templates` and `inbox` (the fields of Notebook settings) count as
 *  stored too, after the `daily` object's own. */
export function resolveDaily(stored: unknown, top: { templates?: unknown; inbox?: unknown } = {}, obsidian: ObsidianSettings = {}): DailySettings {
  const mine = (stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}) as Record<string, unknown>;
  const od = (obsidian.daily && typeof obsidian.daily === "object" ? obsidian.daily : {}) as Record<string, unknown>;
  const ot = (obsidian.templates && typeof obsidian.templates === "object" ? obsidian.templates : {}) as Record<string, unknown>;
  const pick = (...values: (string | undefined)[]) => values.find((v) => v !== undefined);
  const template = pick(clean(text(mine.template)), clean(text(od.template)));
  return {
    folder: pick(clean(text(mine.folder)), clean(text(od.folder))) ?? DEFAULT_DAILY.folder,
    format: pick(text(mine.format)?.trim() || undefined, text(od.format)?.trim() || undefined) ?? DEFAULT_DAILY.format,
    template: template || null,
    templates: pick(clean(text(mine.templates)) || undefined, clean(text(top.templates)) || undefined, clean(text(ot.folder)) || undefined) ?? DEFAULT_DAILY.templates,
    inbox: pick(clean(text(mine.inbox)) || undefined, clean(text(top.inbox)) || undefined) ?? DEFAULT_DAILY.inbox,
  };
}

/** The settings to store after the user edited the daily fields: what is already stored keeps its other fields, a blank
 *  field is dropped (so the default or Obsidian's setting applies again). */
export function dailyPatch(stored: unknown, edits: StoredDaily): Record<string, unknown> {
  const base = (stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(edits)) {
    const v = typeof value === "string" ? (key === "format" ? value.trim() : clean(value)) : value;
    if (v) base[key] = v; else delete base[key];
  }
  return base;
}

const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** The path of the daily page for `date`. */
export function dailyPath(settings: DailySettings, date: Date): string {
  return join(settings.folder, `${formatDate(date, settings.format)}.md`);
}

/** The path of the template page named by a setting: Obsidian writes it without the extension. */
export function templatePath(name: string): string {
  return /\.(md|markdown)$/i.test(name) ? name : `${name}.md`;
}

/** The date a daily page's path names, or null when the path is not a daily page under these settings. The format is turned
 *  into a pattern for its year, month and day, and the date found must write the same path back, so a page that only looks
 *  similar is not taken for one. A format with no year, month or day has no date to find. */
export function dailyDateOf(settings: DailySettings, path: string): Date | null {
  const prefix = settings.folder ? `${settings.folder}/` : "";
  if (!path.toLowerCase().startsWith(prefix.toLowerCase()) || !/\.md$/i.test(path)) return null;
  const name = path.slice(prefix.length, -3);
  const parts: string[] = [];
  let pattern = "";
  let last = 0;
  for (const m of settings.format.matchAll(TOKEN)) {
    pattern += settings.format.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    last = m.index + m[0].length;
    const token = m[1] !== undefined ? null : m[0];
    if (token === null) pattern += m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (token === "YYYY") { parts.push("YYYY"); pattern += "(\\d{4})"; }
    else if (token === "YY") { parts.push("YY"); pattern += "(\\d{2})"; }
    else if (token === "MM" || token === "M") { parts.push("M"); pattern += token === "MM" ? "(\\d{2})" : "(\\d{1,2})"; }
    else if (token === "MMMM" || token === "MMM") { parts.push("MMM"); pattern += "([A-Za-z]+)"; }
    else if (token === "DD" || token === "D") { parts.push("D"); pattern += token === "DD" ? "(\\d{2})" : "(\\d{1,2})"; }
    else pattern += "[^/]+?";
  }
  pattern += settings.format.slice(last).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`^${pattern}$`, "i").exec(name);
  if (!found || !parts.includes("D") || !(parts.includes("M") || parts.includes("MMM")) || !(parts.includes("YYYY") || parts.includes("YY"))) return null;
  let year = 0, month = 0, day = 0;
  parts.forEach((p, i) => {
    const v = found[i + 1];
    if (p === "YYYY") year = Number(v);
    else if (p === "YY") year = 2000 + Number(v);
    else if (p === "M") month = Number(v);
    else if (p === "MMM") month = MONTHS.findIndex((n) => n.toLowerCase().startsWith(v.toLowerCase().slice(0, 3))) + 1;
    else day = Number(v);
  });
  const date = new Date(year, month - 1, day);
  return month >= 1 && date.getMonth() === month - 1 && date.getDate() === day && dailyPath(settings, date).toLowerCase() === path.toLowerCase() ? date : null;
}

/** The day before or after `date` (steps of whole days, so a change of clocks does not skip or repeat one). */
export const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** What a template can use. `project` is the picked project's name, or empty. */
export interface TemplateContext { title: string; date: Date; notebook: string; project?: string }

/** `{{name}}` and `{{name:FORMAT}}` of the variables a template may hold. */
const VARIABLE = /\{\{(title|date|time|notebook|project|cursor)(?::([^{}]*))?\}\}/g;

/** A template with its variables filled: `{{title}}`, `{{date}}` (YYYY-MM-DD) and `{{date:FORMAT}}`, `{{time}}` (HH:mm) and
 *  `{{time:FORMAT}}`, `{{notebook}}`, `{{project}}`, and `{{cursor}}`, which is removed and says where the cursor goes. A
 *  variable that is not known, or a known one given a format it does not take, is left as written. `cursor` is a position
 *  in the returned text, or null when the template has none. */
export function expandTemplate(template: string, ctx: TemplateContext): { text: string; cursor: number | null } {
  let out = "";
  let last = 0;
  let cursor: number | null = null;
  for (const m of template.matchAll(VARIABLE)) {
    const [whole, name, format] = m;
    out += template.slice(last, m.index);
    last = m.index + whole.length;
    if (name === "date") out += formatDate(ctx.date, format || "YYYY-MM-DD");
    else if (name === "time") out += formatDate(ctx.date, format || "HH:mm");
    else if (format !== undefined) out += whole;
    else if (name === "cursor") cursor ??= out.length;
    else out += name === "title" ? ctx.title : name === "notebook" ? ctx.notebook : ctx.project ?? "";
  }
  return { text: out + template.slice(last), cursor };
}

/** The line and column (both from 0) of `offset` in `text`, for placing a cursor. */
export function lineAndColumn(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, col: offset - (before.lastIndexOf("\n") + 1) };
}

/** The templates in `entries`' pages under the templates folder (Markdown pages, by path). */
export function templatesIn(paths: string[], folder: string): string[] {
  const prefix = folder ? `${folder.toLowerCase()}/` : "";
  return paths.filter((p) => /\.(md|markdown)$/i.test(p) && p.toLowerCase().startsWith(prefix)).sort((a, b) => a.localeCompare(b));
}
