// Markdown to mdast and back for the rich editor (NS-3B, now used by .hmdoc pages): GFM, frontmatter and Obsidian syntax, with the Obsidian nodes'
// shapes. Parsing keeps positions; writing follows the style found in the page.
import type { Literal, Parent, PhrasingContent, Root, RootContent } from "mdast";
import { fromMarkdown, type Extension as FromExtension, type CompileContext, type Token } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown, frontmatterToMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown, type Handle, type Options as ToOptions, type Unsafe } from "mdast-util-to-markdown";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { obsidian } from "./micromark/obsidian";

/** Display math: everything between the opening `$$` and the closing one, exactly as written. */
export interface MathBlock extends Literal { type: "math"; closed: boolean }
export interface InlineMath extends Literal { type: "inlineMath"; dollars: 1 | 2 }
/** `[[value]]`. */
export interface WikiLink extends Literal { type: "wikiLink" }
/** `![[value]]`. */
export interface Embed extends Literal { type: "embed" }
/** `%%...%%`, the whole source with its marks. */
export interface Comment extends Literal { type: "comment" }
export interface Highlight extends Parent { type: "highlight"; children: PhrasingContent[] }
/** Source written as it is, for what the editor holds only as text. `original` is the node it was parsed as. */
export interface Raw extends Literal { type: "raw"; original?: RootContent | PhrasingContent | null }

declare module "mdast" {
  interface RootContentMap { math: MathBlock; raw: Raw; inlineMath: InlineMath; wikiLink: WikiLink; embed: Embed; comment: Comment; highlight: Highlight }
  interface BlockContentMap { math: MathBlock; raw: Raw }
  interface PhrasingContentMap { inlineMath: InlineMath; wikiLink: WikiLink; embed: Embed; comment: Comment; highlight: Highlight; raw: Raw }
}

type Ctx = CompileContext;
const top = (cx: Ctx) => cx.stack[cx.stack.length - 1] as unknown as Record<string, unknown>;

/** In a table cell a `|` inside a link, an embed or math is escaped, since GFM ends a cell at a pipe that is not. The
 *  table reads backslashes in pairs, so `k` backslashes before a pipe are written as `2k` and then `\|`; the value
 *  holds the plain text (Codex reviews of 2392f6b, R1-6, b0afec0, R2-4, and ad6c5c5, R3-1). */
export const pipeEscape = (value: string) => value.replace(/(\\*)\|/g, (_m, bs: string) => `${bs}${bs}\\|`);
export const pipeUnescape = (text: string) => text.replace(/(\\*)\|/g, (m, bs: string) => (bs.length % 2 ? `${bs.slice(0, (bs.length - 1) / 2)}|` : m));
/** Source text in a cell (a comment, inline HTML) keeps the pipes already escaped and escapes the others (R3-2). */
const pipeProtect = (text: string) => text.replace(/(\\*)\|/g, (m, bs: string) => (bs.length % 2 ? m : `${bs}\\|`));
const inCell = (cx: Ctx) => cx.stack.some((n) => n.type === "tableCell");
const unpipe = (cx: Ctx, value: string) => (inCell(cx) ? pipeUnescape(value) : value);

const obsidianFromMarkdown: FromExtension = {
  canContainEols: ["highlight"],
  enter: {
    obsidianMath(this: Ctx, token: Token) {
      this.enter({ type: "math", value: "", closed: !!token._closed } as never, token);
      this.buffer();
    },
    obsidianInlineMath(this: Ctx, token: Token) {
      const raw = this.sliceSerialize(token);
      const dollars = raw.startsWith("$$") ? 2 : 1;
      this.enter({ type: "inlineMath", value: unpipe(this, raw.slice(dollars, -dollars)), dollars } as never, token);
    },
    obsidianWiki(this: Ctx, token: Token) { this.enter({ type: "wikiLink", value: unpipe(this, this.sliceSerialize(token).slice(2, -2)) } as never, token); },
    obsidianEmbed(this: Ctx, token: Token) { this.enter({ type: "embed", value: unpipe(this, this.sliceSerialize(token).slice(3, -2)) } as never, token); },
    obsidianHighlight(this: Ctx, token: Token) { this.enter({ type: "highlight", children: [] } as never, token); },
    // The inside of a comment is parsed (so its line endings split the paragraph's lines as usual) and then dropped:
    // the node keeps the source as written.
    obsidianComment(this: Ctx, token: Token) { this.enter({ type: "comment", value: this.sliceSerialize(token), children: [] } as never, token); },
  },
  exit: {
    obsidianMath(this: Ctx, token: Token) {
      const data = this.resume();
      const node = top(this);
      node.value = node.closed ? data.replace(/\$\$[ \t]*$/, "") : data;
      this.exit(token);
    },
    obsidianMathValue(this: Ctx, token: Token) {
      this.config.enter.data.call(this, token);
      this.config.exit.data.call(this, token);
    },
    obsidianInlineMath(this: Ctx, token: Token) { this.exit(token); },
    obsidianWiki(this: Ctx, token: Token) { this.exit(token); },
    obsidianEmbed(this: Ctx, token: Token) { this.exit(token); },
    obsidianHighlight(this: Ctx, token: Token) { this.exit(token); },
    obsidianComment(this: Ctx, token: Token) {
      delete top(this).children;
      this.exit(token);
    },
  },
};

const micromarkExtensions = [gfm(), frontmatter(["yaml", "toml"]), obsidian()];
const mdastExtensions = [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml", "toml"]), obsidianFromMarkdown];

/** A page's Markdown as mdast, with positions. */
export function parse(text: string): Root {
  return fromMarkdown(text, { extensions: micromarkExtensions, mdastExtensions });
}

/** How a page writes what the writer chooses: list markers, emphasis, fences, rules and headings. */
export interface Style {
  bullet: "-" | "*" | "+";
  bulletOrdered: "." | ")";
  emphasis: "*" | "_";
  strong: "*" | "_";
  fence: "`" | "~";
  rule: "-" | "*" | "_";
  ruleRepetition: number;
  ruleSpaces: boolean;
  listItemIndent: "one" | "tab" | "mixed";
  setext: boolean;
  incrementListMarker: boolean;
  /** A hard line break as two trailing spaces or a backslash. */
  hardBreak: "spaces" | "backslash";
}

export const DEFAULT_STYLE: Style = {
  bullet: "-", bulletOrdered: ".", emphasis: "*", strong: "*", fence: "`", rule: "-", ruleRepetition: 3, ruleSpaces: false,
  listItemIndent: "one", setext: false, incrementListMarker: true, hardBreak: "backslash",
};

const peek = (mark: string) => () => mark;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/** A node written as its source. Inside a table cell, `value` nodes escape their pipes as Obsidian writes
 *  `[[Page\|alias]]` in tables, and `source` nodes (comments, inline source) escape the pipes not yet escaped. */
const literal = (wrap: (v: string, node: any) => string, mark: string, pipes: "value" | "source" | "none" = "none"): Handle => Object.assign(
  (node: Literal, _parent: unknown, state: Parameters<Handle>[2]) => {
    const cell = pipes !== "none" && state.stack.includes("tableCell");
    const value = cell ? (pipes === "value" ? pipeEscape(node.value) : pipeProtect(node.value)) : node.value;
    return wrap(value, node);
  },
  { peek: peek(mark) },
) as unknown as Handle;

const highlight: Handle = Object.assign(
  (node: Highlight, _parent: unknown, state: Parameters<Handle>[2], info: Parameters<Handle>[3]) => {
    const tracker = state.createTracker(info);
    let value = tracker.move("==");
    value += tracker.move(state.containerPhrasing(node as never, { before: value, after: "=", ...tracker.current() }));
    value += tracker.move("==");
    return value;
  },
  { peek: peek("=") },
) as Handle;

const handlers: Record<string, Handle> = {
  math: literal((v, node: MathBlock) => `$$${v}${node.closed ? "$$" : ""}`, "$"),
  inlineMath: literal((v, node: InlineMath) => `${"$".repeat(node.dollars)}${v}${"$".repeat(node.dollars)}`, "$", "value"),
  wikiLink: literal((v) => `[[${v}]]`, "[", "value"),
  embed: literal((v) => `![[${v}]]`, "!", "value"),
  comment: literal((v) => v, "%", "source"),
  raw: literal((v) => v, "", "source"),
  highlight,
};

/** Text characters that would start Obsidian syntax, escaped when a block is written strictly. */
const obsidianUnsafe: Unsafe[] = [
  { character: "=", after: "=", inConstruct: "phrasing" },
  { character: "%", after: "%", inConstruct: "phrasing" },
  { character: "$", inConstruct: "phrasing" },
  { atBreak: true, character: "$", after: "\\$" },
];

/** Text exactly as typed: the relaxed writer, used only when parsing its output again gives the same block. */
const plainText: Handle = (node: { value: string }) => node.value;

const spacesBreak: Handle = () => "  \n";

/** One block (or a run of blocks) as Markdown in `style`, without the final line break. `relaxed` leaves text
 *  unescaped. `overrides` set per-block choices such as a list's own marker. */
export type Overrides = Partial<ToOptions> & { tablePipeAlign?: boolean };

export function stringify(nodes: RootContent[], style: Style, relaxed: boolean, { tablePipeAlign, ...overrides }: Overrides = {}): string {
  const { hardBreak, ...choices } = style;
  const options: ToOptions = {
    ...choices,
    bulletOther: style.bullet === "-" ? "*" : "-",
    fences: true,
    extensions: [gfmToMarkdown({ tablePipeAlign }), frontmatterToMarkdown(["yaml", "toml"]), { handlers, unsafe: relaxed ? [] : obsidianUnsafe }],
    ...overrides,
  };
  if (relaxed) options.handlers = { ...(options.handlers ?? {}), text: plainText };
  if (hardBreak === "spaces") options.handlers = { ...(options.handlers ?? {}), break: spacesBreak };
  const out = toMarkdown({ type: "root", children: nodes } as Root, options);
  return out.endsWith("\n") ? out.slice(0, -1) : out;
}
