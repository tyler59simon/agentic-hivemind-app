// The reading view's half of NS-3A: the same constructs the rich editor renders, for react-markdown. Math and comments
// are found with the editor's own parser (`richSyntax`), so both views agree on what is math, and the source is
// rewritten before Markdown parsing: math becomes code (which keeps its backslashes), comments go. Highlights and
// callouts are remark plugins over the parsed tree.
import { GFM, parser as baseParser } from "@lezer/markdown";
import { parseCallout, parseEmbed } from "./parse";
import { richSyntax } from "./syntax";

/** Inline code that starts with this character is math. It is a private-use character, so no page has it by accident. */
export const MATH_MARK = "";

const parser = baseParser.configure([GFM, richSyntax]);

/** A code span holding `text` exactly: a backtick run longer than any inside it, and a space where it would touch one. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The text Reading mode parses, and the source line (from 0) of each of its lines (from 0), for heading anchors. */
export interface Prepared { text: string; sourceLine: (line: number) => number }

/** The page text with `$math$` as marked code spans, `$$` blocks as ```math fences, and `%%comments%%` removed. A fence
 *  keeps the quote or list it is in; the lines it adds are mapped back to the source, so the Outline's line numbers
 *  still match (Codex review of 398b956 and its re-review). */
export function prepare(text: string): Prepared {
  if (!text.includes("$") && !text.includes("%%")) return { text, sourceLine: (n) => n };
  const edits: { from: number; to: number; insert: string }[] = [];
  const lineStart = (pos: number) => text.lastIndexOf("\n", pos - 1) + 1;
  const lineEnd = (pos: number) => { const n = text.indexOf("\n", pos); return n < 0 ? text.length : n; };
  parser.parse(text).iterate({
    enter: (node) => {
      if (node.name === "InlineMath") {
        const marks = node.node.getChildren("InlineMathMark");
        if (marks.length === 2) edits.push({ from: node.from, to: node.to, insert: codeSpan(MATH_MARK + text.slice(marks[0].to, marks[1].from)) });
        return false;
      }
      if (node.name === "BlockMath") {
        const marks = node.node.getChildren("BlockMathMark");
        const inner = marks.length === 2 ? text.slice(marks[0].to, marks[1].from) : text.slice(node.from + 2, node.to);
        const longest = Math.max(2, ...[...inner.matchAll(/`+/g)].map((m) => m[0].length));
        const fence = "`".repeat(longest + 1);
        const alone = marks.length === 2
          && !text.slice(marks[0].to, lineEnd(marks[0].to)).trim()
          && /^[ \t>]*$/.test(text.slice(lineStart(marks[1].from), marks[1].from))
          && !text.slice(marks[1].to, lineEnd(marks[1].to)).trim();
        if (alone) {
          // `$$` on lines of their own: the marks become the fence in place.
          edits.push({ from: marks[0].from, to: marks[0].to, insert: `${fence}math` }, { from: marks[1].from, to: marks[1].to, insert: fence });
        } else {
          // `$$x$$`, or math sharing a line with a mark: a fence over new lines, each with the container's markers
          // (a list marker becomes spaces), so the quote or list goes on around it.
          const pre = text.slice(lineStart(node.from), node.from).replace(/[-*+]|\d+[.)]/g, (m) => " ".repeat(m.length));
          edits.push({ from: node.from, to: node.to, insert: `${fence}math\n${pre}${inner.trim()}\n${pre}${fence}` });
        }
        return false;
      }
      if (node.name === "Comment") {
        edits.push({ from: node.from, to: node.to, insert: "" });
        return false;
      }
    },
  });
  // map[k] is the source line of output line k: lines of unchanged text count one for one, lines added by an edit
  // stay on the line where it started.
  const map: number[] = [0];
  let out = "";
  let at = 0;
  let line = 0;
  const count = (s: string) => s.split("\n").length - 1;
  for (const e of edits) {
    const kept = text.slice(at, e.from);
    for (let k = 1; k <= count(kept); k++) map.push(line + k);
    line += count(kept);
    const end = line + count(text.slice(e.from, e.to));
    for (let k = 1; k <= count(e.insert); k++) map.push(Math.min(line + k, end));
    line = end;
    out += kept + e.insert;
    at = e.to;
  }
  const tail = text.slice(at);
  for (let k = 1; k <= count(tail); k++) map.push(line + k);
  return { text: out + tail, sourceLine: (n) => map[n] ?? n };
}

/** The page text Reading mode parses; see `prepare`. */
export const prepareForReading = (text: string) => prepare(text).text;

interface MdNode {
  type: string; value?: string; url?: string; alt?: string; children?: MdNode[]; data?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
}

/** `==text==` inside a text node becomes `<mark>`. */
function splitHighlights(node: MdNode): MdNode[] {
  const text = node.value ?? "";
  const out: MdNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/==(?=\S)([^=\n]*?\S)==/g)) {
    if (m.index! > at) out.push({ type: "text", value: text.slice(at, m.index) });
    out.push({ type: "highlight", data: { hName: "mark" }, children: [{ type: "text", value: m[1] }] });
    at = m.index! + m[0].length;
  }
  if (!out.length) return [node];
  if (at < text.length) out.push({ type: "text", value: text.slice(at) });
  return out;
}

function walkHighlights(node: MdNode) {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value?.includes("==")) return splitHighlights(child);
    walkHighlights(child);
    return [child];
  });
}

export function remarkHighlights() {
  return (tree: MdNode) => walkHighlights(tree);
}

/** A blockquote whose first line is `[!type] Title` becomes a callout box; a foldable one (`-` or `+`) a `<details>`. */
function walkCallouts(node: MdNode) {
  for (const child of node.children ?? []) {
    walkCallouts(child);
    if (child.type !== "blockquote") continue;
    const para = child.children?.[0];
    const kids = para?.type === "paragraph" ? para.children ?? [] : [];
    const first = kids[0];
    if (!para || first?.type !== "text") continue;
    const value = first.value ?? "";
    const end = value.indexOf("\n");
    const callout = parseCallout(`> ${end < 0 ? value : value.slice(0, end)}`);
    if (!callout) continue;
    // The title is the whole first line, formatting included: the text after the marker and every inline node before
    // the line ends; the rest of the paragraph stays as the body (Codex review of 398b956, P3).
    const marker = /^\s*\[![^\]]+\][+-]?[ \t]*/.exec(value)?.[0] ?? "";
    const titled: MdNode[] = [];
    let rest: MdNode[] = [];
    const line = end < 0 ? value.slice(marker.length) : value.slice(marker.length, end);
    if (line) titled.push({ type: "text", value: line });
    if (end >= 0) {
      const tail = value.slice(end + 1);
      rest = [...(tail ? [{ type: "text", value: tail }] : []), ...kids.slice(1)];
    } else {
      let i = 1;
      for (; i < kids.length; i++) {
        const k = kids[i];
        if (k.type === "break") { i++; break; }
        const nl = k.type === "text" ? (k.value ?? "").indexOf("\n") : -1;
        if (nl >= 0) {
          if (nl > 0) titled.push({ type: "text", value: k.value!.slice(0, nl) });
          const tail = k.value!.slice(nl + 1);
          if (tail) rest.push({ type: "text", value: tail });
          i++;
          break;
        }
        // A node that goes on past the title line (bold over two lines) stays in the body (Codex re-review of 87a0a1f).
        if (k.position && first.position && k.position.end.line > first.position.start.line) break;
        titled.push(k);
      }
      rest = [...rest, ...kids.slice(i)];
    }
    const last = titled[titled.length - 1];
    if (last?.type === "text") last.value = (last.value ?? "").replace(/\s+$/, "");
    const shown = titled.some((n) => n.type !== "text" || n.value) ? titled : [{ type: "text", value: callout.title }];
    para.children = rest;
    const body = rest.length ? child.children! : child.children!.slice(1);
    const fold = callout.fold;
    child.data = {
      hName: fold ? "details" : "div",
      hProperties: { className: ["callout", `callout-${callout.type}`], "data-callout": callout.type, ...(fold === "+" ? { open: true } : {}) },
    };
    const title: MdNode = {
      type: "calloutTitle",
      data: { hName: fold ? "summary" : "div", hProperties: { className: ["callout-title"] } },
      children: shown,
    };
    child.children = [title, ...body];
  }
}

export function remarkCallouts() {
  return (tree: MdNode) => walkCallouts(tree);
}

/** The URL prefix of a `![[picture.png]]`: the reading view finds the file in the notebook. */
export const WIKI_PICTURE = "wikipicture:";

/** `![[picture.png]]` becomes a picture; a paragraph that is only `![[Page]]` becomes an embed (`div[data-embed]`).
 *  An embed of a page inside other text stays text, and `remarkWikilinks` then makes it a link. */
function walkEmbeds(node: MdNode) {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === "paragraph" && child.children?.length === 1 && child.children[0].type === "text") {
      const embed = parseEmbed(child.children[0].value ?? "");
      if (embed?.kind === "page") {
        return [{ type: "pageEmbed", data: { hName: "div", hProperties: { className: ["page-embed"], "data-embed": embed.target, "data-heading": embed.heading ?? "" } } }];
      }
    }
    if (child.type === "text" && child.value?.includes("![[")) {
      const text = child.value;
      const out: MdNode[] = [];
      let at = 0;
      for (const m of text.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
        const embed = parseEmbed(m[0]);
        if (embed?.kind !== "picture") continue;
        if (m.index! > at) out.push({ type: "text", value: text.slice(at, m.index) });
        const alt = embed.width ? `${embed.alt}|${embed.width}${embed.height ? `x${embed.height}` : ""}` : embed.alt;
        out.push({ type: "image", url: WIKI_PICTURE + encodeURIComponent(embed.src), alt });
        at = m.index! + m[0].length;
      }
      if (!out.length) return [child];
      if (at < text.length) out.push({ type: "text", value: text.slice(at) });
      return out;
    }
    walkEmbeds(child);
    return [child];
  });
}

export function remarkEmbeds() {
  return (tree: MdNode) => walkEmbeds(tree);
}
