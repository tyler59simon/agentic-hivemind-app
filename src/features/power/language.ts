// The language of a text file (NS-6A): found from its file name through `@codemirror/language-data`, which is loaded the
// first time one is needed, with a choice in the status line to override it.
import { LanguageDescription, type LanguageSupport } from "@codemirror/language";

/** The name the picker gives to no language at all. */
export const PLAIN = "Plain text";

let list: Promise<readonly LanguageDescription[]> | null = null;
/** Every language CodeMirror can load, by name and extension. */
export const languageList = () => (list ??= import("@codemirror/language-data").then((m) => m.languages));

/** The language of `fileName`, or null for plain text. `override` is a name from the picker; `PLAIN` forces none. */
export async function describe(fileName: string, override?: string): Promise<LanguageDescription | null> {
  const all = await languageList();
  if (override === PLAIN) return null;
  if (override) return all.find((l) => l.name === override) ?? null;
  return LanguageDescription.matchFilename(all, fileName);
}

const loaded = new Map<LanguageDescription, Promise<LanguageSupport>>();
/** The editor support of `description`, loaded once. */
export const support = (description: LanguageDescription) => {
  let found = loaded.get(description);
  if (!found) { found = description.load(); loaded.set(description, found); }
  return found;
};

/** How a file is indented, read from its first lines: what the status line shows. */
export function detectIndent(text: string): string {
  let tabs = 0, spaces = 0, seen = 0;
  const deltas = new Map<number, number>();
  let previous = 0;
  for (const line of text.slice(0, 200_000).split("\n")) {
    if (!line.trim()) continue;
    if (++seen > 2000) break;
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead.startsWith("\t")) tabs++;
    else if (lead.length) spaces++;
    const width = lead.startsWith("\t") ? 0 : lead.length;
    const delta = Math.abs(width - previous);
    if (width && delta) deltas.set(delta, (deltas.get(delta) ?? 0) + 1);
    previous = width;
  }
  if (!tabs && !spaces) return "No indentation";
  if (tabs >= spaces) return "Tabs";
  const common = [2, 3, 4, 8].map((n) => [n, deltas.get(n) ?? 0] as const).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return `${common[1] ? common[0] : [...deltas.keys()].sort((a, b) => a - b)[0] ?? 4} spaces`;
}
