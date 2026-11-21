// Obsidian syntax for micromark (NS-3B), written to the rules of the Live editor's `richSyntax`
// (`src/features/editor/rich/syntax.ts`) so Rich and Live see the same constructs:
// - `==highlight==` pairs like GFM strikethrough with exactly two marks;
// - `%%comment%%`: every `%%` may open or close, and the nearest pairs win;
// - `$x$` and `$$x$$` inside a paragraph: no space after the opening mark, none before the closing one, and no digit
//   right after a closing `$` (so "$5 and $6" stays text);
// - a line starting with `$$` opens display math that runs to the next line ending in `$$` (`$$ x $$` on one line is
//   a block too), or to the end of its container;
// - `[[target]]` and `![[target]]` are single tokens (no line break, `[` or `]` inside).
import { markdownLineEnding, markdownLineEndingOrSpace, asciiDigit } from "micromark-util-character";
import { splice } from "micromark-util-chunked";
import type { Code, Construct, Effects, Event, Extension, State, Token, TokenizeContext } from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    obsidianMath: "obsidianMath";
    obsidianMathFence: "obsidianMathFence";
    obsidianMathValue: "obsidianMathValue";
    obsidianInlineMath: "obsidianInlineMath";
    obsidianWiki: "obsidianWiki";
    obsidianEmbed: "obsidianEmbed";
    obsidianHighlight: "obsidianHighlight";
    obsidianHighlightText: "obsidianHighlightText";
    obsidianHighlightSequence: "obsidianHighlightSequence";
    obsidianHighlightTemporary: "obsidianHighlightTemporary";
    obsidianComment: "obsidianComment";
    obsidianCommentSequence: "obsidianCommentSequence";
    obsidianCommentTemporary: "obsidianCommentTemporary";
    obsidianCommentText: "obsidianCommentText";
  }
  interface Token {
    /** Display math whose closing `$$` was found. */
    _closed?: boolean;
  }
}

const DOLLAR = 36, BACKSLASH = 92, EQUALS = 61, PERCENT = 37, LEFT = 91, RIGHT = 93, BANG = 33;

/** A line ending that continues the construct: the next line is not a lazy continuation of a paragraph. */
const nonLazyContinuation: Construct = {
  partial: true,
  tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const self = this;
    const lineStart: State = (code) => (self.parser.lazy[self.now().line] ? nok(code) : ok(code));
    return (code) => {
      if (code === null) return nok(code);
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return lineStart;
    };
  },
};

const charOf = (code: Code) => (code === null ? "" : code === -2 ? "\t" : code < 0 ? " " : String.fromCharCode(code));

/** `$$` display math. Its value is everything between the opening `$$` and the closing one (or the end), line breaks
 *  included, so a block is written back exactly as it was read. */
const mathFlow: Construct = {
  name: "obsidianMath",
  concrete: true,
  tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const self = this;
    let token: Token;
    let line = "";
    let first = true;
    const done: State = (code) => {
      effects.exit("obsidianMath");
      return ok(code);
    };
    const lineEnd: State = (code) => {
      const rest = line.trimEnd();
      const closes = first ? rest.length > 2 && rest.endsWith("$$") : rest.endsWith("$$");
      first = false;
      if (closes) {
        token._closed = true;
        return done(code);
      }
      if (code === null) return done(code);
      return effects.attempt(nonLazyContinuation, lineStart, done)(code);
    };
    const inLine: State = (code) => {
      if (code === null || markdownLineEnding(code)) {
        effects.exit("obsidianMathValue");
        return lineEnd(code);
      }
      line += charOf(code);
      effects.consume(code);
      return inLine;
    };
    const lineStart: State = (code) => {
      line = "";
      if (code === null || markdownLineEnding(code)) return lineEnd(code);
      effects.enter("obsidianMathValue");
      return inLine(code);
    };
    const second: State = (code) => {
      if (code !== DOLLAR) return nok(code);
      effects.consume(code);
      effects.exit("obsidianMathFence");
      // As a check whether a `$$` line interrupts a paragraph, the opening is enough.
      if (self.interrupt) return ok;
      return lineStart;
    };
    return (code) => {
      if (code !== DOLLAR) return nok(code);
      token = effects.enter("obsidianMath");
      effects.enter("obsidianMathFence");
      effects.consume(code);
      return second;
    };
  },
};

/** `$x$` or `$$x$$` in text, one token. */
const mathText: Construct = {
  name: "obsidianInlineMath",
  tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    let width = 1;
    let prev: Code = null;
    let beforeDollar: Code = null;
    const closeDone: State = (code) => {
      effects.exit("obsidianInlineMath");
      return ok(code);
    };
    const closeSingle: State = (code) => (code !== null && asciiDigit(code) ? nok(code) : closeDone(code));
    const closeSecond: State = (code) => {
      if (code !== DOLLAR) {
        // A lone `$` inside `$$...$$` is part of the math.
        prev = DOLLAR;
        return inside(code);
      }
      if (markdownLineEndingOrSpace(beforeDollar)) return nok(code);
      effects.consume(code);
      return closeDone;
    };
    const escaped: State = (code) => {
      if (code === null) return nok(code);
      effects.consume(code);
      prev = code;
      return inside;
    };
    const inside: State = (code) => {
      if (code === null) return nok(code);
      if (code === BACKSLASH) {
        effects.consume(code);
        prev = code;
        return escaped;
      }
      if (code === DOLLAR) {
        if (width === 1) {
          if (markdownLineEndingOrSpace(prev)) return nok(code);
          effects.consume(code);
          return closeSingle;
        }
        beforeDollar = prev;
        effects.consume(code);
        return closeSecond;
      }
      effects.consume(code);
      prev = code;
      return inside;
    };
    const opened: State = (code) => {
      if (code === null || code === DOLLAR || markdownLineEndingOrSpace(code)) return nok(code);
      return inside(code);
    };
    const open: State = (code) => {
      if (code === DOLLAR) {
        width = 2;
        effects.consume(code);
        return opened;
      }
      return opened(code);
    };
    const previous = this.previous;
    return (code) => {
      // `\$` never opens; as in Live, neither does a `$` right after a backslash that was itself escaped.
      if (code !== DOLLAR || previous === BACKSLASH) return nok(code);
      effects.enter("obsidianInlineMath");
      effects.consume(code);
      return open;
    };
  },
};

/** `[[target]]`, or `![[target]]` with `embed`. */
function wiki(embed: boolean): Construct {
  const type = embed ? "obsidianEmbed" : "obsidianWiki";
  return {
    name: type,
    add: "before",
    tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
      let size = 0;
      const closeSecond: State = (code) => {
        if (code !== RIGHT) return nok(code);
        effects.consume(code);
        effects.exit(type);
        return ok;
      };
      const inside: State = (code) => {
        if (code === RIGHT && size > 0) {
          effects.consume(code);
          return closeSecond;
        }
        if (code === null || code === LEFT || code === RIGHT || markdownLineEnding(code)) return nok(code);
        effects.consume(code);
        size++;
        return inside;
      };
      const second: State = (code) => {
        if (code !== LEFT) return nok(code);
        effects.consume(code);
        return inside;
      };
      const first: State = (code) => {
        if (code !== LEFT) return nok(code);
        effects.consume(code);
        return second;
      };
      return (code) => {
        effects.enter(type);
        if (!embed) return first(code);
        if (code !== BANG) return nok(code);
        effects.consume(code);
        return first;
      };
    },
  };
}

type Pairing = { marker: number; span: "obsidianHighlight" | "obsidianComment"; flanking: boolean };

/** Two-mark spans resolved like GFM strikethrough: `==` with flanking rules, `%%` where every run opens and closes. */
function pairing({ marker, span, flanking }: Pairing): Construct {
  const temporary = `${span}Temporary` as "obsidianHighlightTemporary" | "obsidianCommentTemporary";
  const sequence = `${span}Sequence` as "obsidianHighlightSequence" | "obsidianCommentSequence";
  const construct: Construct = {
    name: span,
    tokenize(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
      const previous = this.previous;
      let size = 0;
      const more: State = (code) => {
        if (code === marker) {
          if (size > 1) return nok(code);
          effects.consume(code);
          size++;
          return more;
        }
        if (size < 2) return nok(code);
        const token = effects.exit(temporary);
        const before = classify(previous), after = classify(code);
        token._open = flanking ? !after || (after === 2 && Boolean(before)) : true;
        token._close = flanking ? !before || (before === 2 && Boolean(after)) : true;
        return ok(code);
      };
      // Unlike GFM strikethrough, a run may start right after a mark (`===a==` reads `==` from the second `=`), as
      // in Live.
      return (code) => {
        effects.enter(temporary);
        return more(code);
      };
    },
    // Each closing run pairs with the nearest open run before it, found on a stack, so runs that never pair cost
    // nothing (Codex review of 2392f6b, R1-15). The inside of a span keeps its events, line endings included, so a
    // comment over two lines of a paragraph parses (R1-P1).
    resolveAll(events: Event[], context: TokenizeContext): Event[] {
      const openers: number[] = [];
      for (let index = 0; index < events.length; index++) {
        const e = events[index];
        if (e[1].type !== temporary) continue;
        if (e[0] === "enter" && e[1]._close && openers.length) {
          const open = openers.pop()!;
          const o = events[open];
          o[1].type = sequence;
          e[1].type = sequence;
          const whole: Token = { type: span, start: { ...o[1].start }, end: { ...e[1].end } };
          const inner = events.slice(open + 1, index);
          const insideSpan = context.parser.constructs.insideSpan.null;
          const resolved = insideSpan ? resolveAllOf(insideSpan, inner, context) : inner;
          const text: Token = { type: span === "obsidianHighlight" ? "obsidianHighlightText" : "obsidianCommentText", start: { ...o[1].end }, end: { ...e[1].start } };
          const next: Event[] = [
            ["enter", whole, context], ["enter", o[1], context], ["exit", o[1], context],
            ["enter", text, context], ...resolved, ["exit", text, context],
            ["enter", e[1], context], ["exit", e[1], context], ["exit", whole, context],
          ];
          // In chunks: a long comment has more events than a call takes arguments (Codex review of b0afec0, R2-2).
          splice(events, open - 1, index - open + 3, next);
          index = open - 1 + next.length - 1;
          continue;
        }
        if (e[0] === "exit" && e[1]._open) openers.push(index);
      }
      for (const e of events) if (e[1].type === temporary) e[1].type = "data";
      return events;
    },
  };
  return construct;
}

/** 1 for whitespace (and the edges), 2 for punctuation, undefined otherwise: micromark's `classifyCharacter`. */
function classify(code: Code): 1 | 2 | undefined {
  if (code === null || markdownLineEndingOrSpace(code) || code === 0x3000 || code === 0xa0) return 1;
  const c = String.fromCodePoint(code);
  if (/[\p{P}\p{S}]/u.test(c)) return 2;
  return undefined;
}

function resolveAllOf(constructs: readonly { resolveAll?: Construct["resolveAll"] }[], events: Event[], context: TokenizeContext): Event[] {
  const called: unknown[] = [];
  for (const c of constructs) {
    const resolve = c.resolveAll;
    if (resolve && !called.includes(resolve)) {
      events = resolve(events, context);
      called.push(resolve);
    }
  }
  return events;
}

const highlight = pairing({ marker: EQUALS, span: "obsidianHighlight", flanking: true });
const comment = pairing({ marker: PERCENT, span: "obsidianComment", flanking: false });

/** The micromark extension: put it after GFM so `[[` and `![[` are tried before links and images. */
export function obsidian(): Extension {
  return {
    flow: { [DOLLAR]: mathFlow },
    text: {
      [DOLLAR]: mathText,
      [LEFT]: wiki(false),
      [BANG]: wiki(true),
      [EQUALS]: highlight,
      [PERCENT]: comment,
    },
    insideSpan: { null: [highlight, comment] },
    attentionMarkers: { null: [EQUALS, PERCENT] },
  };
}
