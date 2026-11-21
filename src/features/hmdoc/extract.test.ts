// NS-3C: text extraction. The fixtures in `fixtures/` (a `.hmdoc` and the `.txt` it extracts to) are shared with the Rust
// twin of NS-4A, which must give the same text for each.
import { describe, expect, it } from "vitest";
import { extractText } from "./extract";
import { parseEnvelope, stringifyEnvelope } from "./envelope";
import { inspect } from "./validate";

// Git may check the fixtures out with CRLF line endings (core.autocrlf); the file service reads a page as LF text.
const files = Object.fromEntries(Object.entries(import.meta.glob("./fixtures/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>)
  .map(([k, v]) => [k, v.replace(/\r\n/g, "\n")]));
const names = Object.keys(files).filter((p) => p.endsWith(".hmdoc")).map((p) => p.replace(/^\.\/fixtures\/|\.hmdoc$/g, ""));

describe("extraction fixtures", () => {
  it("there are fixtures", () => {
    expect(names.sort()).toEqual(["basic", "inline", "table"]);
  });

  for (const name of names) {
    it(`${name}: the text is what the .txt beside it holds`, () => {
      const opened = parseEnvelope(files[`./fixtures/${name}.hmdoc`]);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(extractText(opened.envelope.content)).toBe(files[`./fixtures/${name}.txt`].replace(/\n$/, ""));
    });

    it(`${name}: is a file the editor can hold, written in the stable order`, () => {
      const text = files[`./fixtures/${name}.hmdoc`];
      const r = inspect(text);
      expect(r.ok).toBe(true);
      const opened = parseEnvelope(text);
      expect(opened.ok && stringifyEnvelope(opened.envelope)).toBe(text);
    });
  }
});

describe("extraction", () => {
  const text = (...blocks: unknown[]) => extractText({ type: "doc", content: blocks });
  const p = (...c: unknown[]) => ({ type: "paragraph", content: c });
  const t = (s: string) => ({ type: "text", text: s });

  it("is the same for the same page, and does not depend on marks or attributes", () => {
    const plain = text(p(t("a b")));
    expect(text(p({ type: "text", text: "a b", marks: [{ type: "bold" }] }))).toBe(plain);
    expect(text(p(t("a b")))).toBe(plain);
  });

  it("gives a formula cell its stored formula, never a value", () => {
    const cell = (s: string) => ({ type: "tableCell", content: [p(t(s))] });
    expect(text({ type: "table", content: [{ type: "tableRow", content: [cell("1"), cell("=A1+1")] }] })).toBe("1\t=A1+1");
  });

  it("keeps a table cell to one field: its blocks and line breaks become spaces, with no tab inside", () => {
    const cell = { type: "tableCell", content: [p(t("one"), { type: "hardBreak" }, t("two\tthree")), p(t("four"))] };
    expect(text({ type: "table", content: [{ type: "tableRow", content: [cell, { type: "tableCell", content: [p()] }] }] })).toBe("one two three four\t");
  });

  it("leaves out empty blocks and dividers, and ends without a line break", () => {
    expect(text(p(), p(t("x")), { type: "horizontalRule" }, p(t("y")))).toBe("x\ny");
    expect(text(p())).toBe("");
  });
});
