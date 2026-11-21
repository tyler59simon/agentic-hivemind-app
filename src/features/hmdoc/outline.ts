// The headings of a rich page, for the outline beside it (NS-3C). Read from the page's text without the editor or its
// schema: the envelope is parsed and the document walked, so the rail can list them cheaply. A heading is named by its
// order in the page (`line`, as the Markdown outline names a line), which the editor follows to move its cursor there.
import { parseEnvelope } from "./envelope";

export interface RichHeading { level: number; text: string; /** Its order among the page's headings, from 0. */ line: number }

type Json = { type?: unknown; text?: unknown; content?: unknown; attrs?: { level?: unknown } | null };

const textOf = (n: Json): string => (n.type === "text" ? String(n.text ?? "") : Array.isArray(n.content) ? (n.content as Json[]).map(textOf).join("") : "");

/** The headings of the page in `text`, in order, at any depth (a column, a toggle, a table cell). A file that is not a page
 *  the editor opens has none. */
export function richOutline(text: string): RichHeading[] {
  const opened = parseEnvelope(text);
  if (!opened.ok) return [];
  const found: RichHeading[] = [];
  const walk = (n: Json) => {
    if (n.type === "heading") {
      const level = typeof n.attrs?.level === "number" ? n.attrs.level : 1;
      found.push({ level, text: textOf(n).trim(), line: found.length });
      return;
    }
    if (Array.isArray(n.content)) for (const c of n.content as Json[]) walk(c);
  };
  walk(opened.envelope.content as Json);
  return found;
}
