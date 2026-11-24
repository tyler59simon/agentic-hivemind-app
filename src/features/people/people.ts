// People (CON-15): one Markdown page per person in a folder of a folder notebook. Which notebook and folder is the `people`
// key of that notebook's sidecar (`.hivemind/notebook.json`). Task owners are plain text and are matched to a page by its
// title or its `aliases` property. Pure, so the hooks and views only draw.
import type { Notebook, NotebookMeta } from "../../lib/notebooks";

export const DEFAULT_PEOPLE_FOLDER = "People";

/** Where the People pages live. */
export interface PeopleLocation { notebook: string; folder: string }

/** One person's page, as the index lists it. `aliases` are other names the page answers to. */
export interface Person { notebook: string; path: string; title: string; aliases: string[]; role: string; email: string }

/** A folder name as the sidecar may hold it: forward slashes, no outer slashes or spaces. */
export const cleanFolder = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "");

/** The People location: the first notebook (in list order) whose sidecar has a `people` key. The folder is cleaned, and is
 *  "People" when it is missing or empty. */
export function resolvePeople(notebooks: Notebook[], metas: Record<string, NotebookMeta | undefined>): PeopleLocation | null {
  for (const nb of notebooks) {
    const people = metas[nb.id]?.people;
    if (people && typeof people === "object" && !Array.isArray(people)) {
      return { notebook: nb.id, folder: cleanFolder((people as { folder?: unknown }).folder) || DEFAULT_PEOPLE_FOLDER };
    }
  }
  return null;
}

/** The file name (without `.md`) for a person: the characters Windows refuses in a name become `-`. */
export const personFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "-").trim();

/** The text of a new person's page. When the file name had to differ from the name, `aliases` keeps the name. */
export function personPageText(name: string): string {
  const shown = name.trim();
  const aliases = personFileName(shown) !== shown ? `[${JSON.stringify(shown)}]` : "[]";
  return `---\nrole:\nemail:\naliases: ${aliases}\n---\n# ${shown}\n`;
}

/** A person from an index row's properties. */
export function personOf(row: { notebook: string; path: string; title: string; props: Record<string, string | string[]> }): Person {
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []).map((a) => a.trim()).filter(Boolean);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  return { notebook: row.notebook, path: row.path, title: row.title.trim() || stemOf(row.path), aliases: list(row.props.aliases), role: one(row.props.role), email: one(row.props.email) };
}

/** A page's file name without its folder and extension. */
const stemOf = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");

/** The person an owner names: ignoring case and outer spaces, a page title or file name wins, then the first page (in title
 *  order) that lists the owner as an alias. */
export function matchOwner(people: Person[], owner: string): Person | null {
  const key = owner.trim().toLowerCase();
  if (!key) return null;
  const byTitle = people.find((p) => p.title.trim().toLowerCase() === key || stemOf(p.path).toLowerCase() === key);
  if (byTitle) return byTitle;
  return people.find((p) => p.aliases.some((a) => a.toLowerCase() === key)) ?? null;
}
