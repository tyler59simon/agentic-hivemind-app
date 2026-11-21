// Markdown syntax the rich page editor adds to CodeMirror's GFM parser (NS-3A): ==highlight==, %%comments%%, $inline
// math$ and $$display math$$ blocks. They become syntax nodes, so code spans and fences keep them out for free.
import { tags as t } from "@lezer/highlight";
import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";

const EQ = 61, PERCENT = 37, DOLLAR = 36, BACKSLASH = 92;
const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~¡‐-‧]/;

/** A two-character delimiter run like `~~`, with GFM strikethrough's rules for opening and closing. */
function pair(name: string, mark: string, code: number) {
  const delim = { resolve: name, mark };
  return {
    name,
    parse(cx: InlineContext, next: number, pos: number) {
      if (next !== code || cx.char(pos + 1) !== code || cx.char(pos + 2) === code) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
      const pBefore = punctuation.test(before), pAfter = punctuation.test(after);
      return cx.addDelimiter(delim, pos, pos + 2, !sAfter && (!pAfter || sBefore || pBefore), !sBefore && (!pBefore || sAfter || pAfter));
    },
    after: "Emphasis",
  };
}

/** `%%`: Obsidian comments may have spaces inside the marks (`%% note %%`), so every run opens and closes. Delimiters
 *  pair by the identity of their type object, so it is one constant. */
const COMMENT = { resolve: "Comment", mark: "CommentMark" };
function comment(cx: InlineContext, next: number, pos: number): number {
  if (next !== PERCENT || cx.char(pos + 1) !== PERCENT) return -1;
  return cx.addDelimiter(COMMENT, pos, pos + 2, true, true);
}

/** `$x$` or `$$x$$` inside a paragraph: the opening `$` is not followed by a space, the closing one not preceded by a
 *  space nor followed by a digit (so "$5 and $6" stays text), and `\$` never counts. */
function inlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR || cx.char(pos - 1) === BACKSLASH) return -1;
  const width = cx.char(pos + 1) === DOLLAR ? 2 : 1;
  const start = pos + width;
  if (start >= cx.end || /\s/.test(cx.slice(start, start + 1)) || cx.char(start) === DOLLAR) return -1;
  for (let i = start; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === BACKSLASH) { i++; continue; }
    if (c !== DOLLAR) continue;
    if (width === 2 && cx.char(i + 1) !== DOLLAR) continue;
    if (/\s/.test(cx.slice(i - 1, i))) return -1;
    if (width === 1 && /\d/.test(cx.slice(i + 1, i + 2))) return -1;
    const end = i + width;
    return cx.addElement(cx.elt("InlineMath", pos, end, [cx.elt("InlineMathMark", pos, start), cx.elt("InlineMathMark", i, end)]));
  }
  return -1;
}

const opensMath = (line: Line) => line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR && line.indent < 4;

/** A `$$` line starts a display-math block that runs to the next line ending in `$$` (or the end of the page, like an
 *  unclosed fence). `$$ x $$` on one line is a block too. */
function blockMath(cx: BlockContext, line: Line): boolean {
  if (!opensMath(line)) return false;
  const from = cx.lineStart + line.pos;
  const marks = [cx.elt("BlockMathMark", from, from + 2)];
  const rest = line.text.slice(line.pos + 2).trimEnd();
  if (rest.length > 2 && rest.endsWith("$$")) {
    const end = cx.lineStart + line.pos + 2 + rest.length;
    marks.push(cx.elt("BlockMathMark", end - 2, end));
    cx.nextLine();
    cx.addElement(cx.elt("BlockMath", from, end, marks));
    return true;
  }
  let end = cx.lineStart + line.text.length;
  while (cx.nextLine()) {
    const text = line.text.trimEnd();
    end = cx.lineStart + line.text.length;
    if (text.endsWith("$$")) {
      const close = cx.lineStart + text.length;
      marks.push(cx.elt("BlockMathMark", close - 2, close));
      end = close;
      cx.nextLine();
      break;
    }
  }
  cx.addElement(cx.elt("BlockMath", from, end, marks));
  return true;
}

export const richSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: t.special(t.content) },
    { name: "HighlightMark", style: t.processingInstruction },
    { name: "Comment", style: t.comment },
    { name: "CommentMark", style: t.comment },
    { name: "InlineMath", style: t.special(t.string) },
    { name: "InlineMathMark", style: t.processingInstruction },
    { name: "BlockMath", block: true, style: t.special(t.string) },
    { name: "BlockMathMark", style: t.processingInstruction },
  ],
  parseInline: [
    pair("Highlight", "HighlightMark", EQ),
    { name: "Comment", parse: comment, after: "Emphasis" },
    { name: "InlineMath", parse: inlineMath, before: "Escape" },
  ],
  parseBlock: [{ name: "BlockMath", parse: blockMath, endLeaf: (_cx, line) => opensMath(line), before: "FencedCode" }],
};
