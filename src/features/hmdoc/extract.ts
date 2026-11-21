// The text of a rich page, for search and agents (NS-3C). Deterministic, so the Rust twin of NS-4A can be checked
// against the same fixtures (`fixtures/*.hmdoc` and the `.txt` beside each): the text of each block in document order,
// one block per line; a table as one line per row with its cells' texts separated by tabs; a formula cell as its stored
// formula, so no evaluator is needed; marks and attributes are left out. Lines are joined with LF, with none at the end.
type Json = { type?: unknown; text?: unknown; content?: unknown; attrs?: Record<string, unknown> | null };

const str = (v: unknown) => (typeof v === "string" ? v : "");
const kids = (n: Json): Json[] => (Array.isArray(n.content) ? (n.content as Json[]) : []);

/** Blocks whose content is inline. */
const TEXTBLOCKS = new Set(["paragraph", "heading", "codeBlock", "calloutTitle", "toggleSummary"]);

/** What an inline node contributes: its text, or the text an atom stands for. */
function inline(n: Json): string {
  switch (n.type) {
    case "text": return str(n.text);
    case "hardBreak": return "\n";
    case "wikiLink": case "embed": case "mathInline": case "rawInline": return str(n.attrs?.value);
    case "image": return str(n.attrs?.alt);
    default: return kids(n).map(inline).join("");
  }
}

function block(n: Json, out: string[]): void {
  const type = str(n.type);
  if (TEXTBLOCKS.has(type)) {
    const text = kids(n).map(inline).join("");
    if (text) out.push(text);
  } else if (type === "table") {
    for (const row of kids(n)) {
      out.push(kids(row).map((cell) => {
        const parts: string[] = [];
        for (const b of kids(cell)) block(b, parts);
        // A cell is one field: its blocks and line breaks become spaces, and tabs never appear inside it.
        return parts.join(" ").replace(/\s+/g, " ").trim();
      }).join("\t"));
    }
  } else if (type === "mathBlock") {
    const text = str(n.attrs?.value).trim();
    if (text) out.push(text);
  } else if (type === "rawBlock") {
    const text = str(n.attrs?.value).replace(/\s+$/, "");
    if (text) out.push(text);
  } else {
    for (const c of kids(n)) block(c, out);
  }
}

/** The text of a document's `content` node. */
export function extractText(content: unknown): string {
  const out: string[] = [];
  block(content as Json, out);
  return out.join("\n");
}
