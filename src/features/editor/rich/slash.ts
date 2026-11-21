// The slash menu of the page editor (NS-3A): `/` at the start of a line lists blocks to insert, filtered as the user
// types. Picking one removes the `/word` and inserts the block's Markdown.
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import * as C from "./commands";

export interface SlashItem { label: string; detail: string; run: (state: EditorState) => TransactionSpec }

export const SLASH_ITEMS: SlashItem[] = [
  { label: "Heading 1", detail: "#", run: (s) => C.setHeading(s, 1) },
  { label: "Heading 2", detail: "##", run: (s) => C.setHeading(s, 2) },
  { label: "Heading 3", detail: "###", run: (s) => C.setHeading(s, 3) },
  { label: "Bulleted list", detail: "-", run: (s) => C.toggleLinePrefix(s, "bullet") },
  { label: "Numbered list", detail: "1.", run: (s) => C.toggleLinePrefix(s, "number") },
  { label: "Task", detail: "- [ ]", run: (s) => C.toggleLinePrefix(s, "task") },
  { label: "Quote", detail: ">", run: (s) => C.toggleLinePrefix(s, "quote") },
  { label: "Callout", detail: "> [!note]", run: (s) => C.insertCallout(s) },
  { label: "Table", detail: "| |", run: C.insertTable },
  { label: "Code block", detail: "```", run: (s) => C.insertBlock(s, "```\n\n```", 4) },
  { label: "Math block", detail: "$$", run: (s) => C.insertBlock(s, "$$\n\n$$", 3) },
  { label: "Mermaid diagram", detail: "```mermaid", run: C.insertMermaid },
  { label: "Divider", detail: "---", run: C.insertRule },
];

/** The menu opens on a `/` that is the first thing on its line. */
export function slashSource(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = ctx.state.sliceDoc(line.from, ctx.pos);
  const m = /^(\s*)\/([\w ]*)$/.exec(before);
  if (!m) return null;
  const slash = line.from + m[1].length;
  const options: Completion[] = SLASH_ITEMS.map((item) => ({
    label: item.label,
    detail: item.detail,
    type: "keyword",
    apply: (view: EditorView, _c: Completion, _from: number, to: number) => {
      view.dispatch({ changes: { from: slash, to }, selection: { anchor: slash } });
      view.dispatch(item.run(view.state));
    },
  }));
  return { from: slash + 1, options, validFor: /^[\w ]*$/ };
}
