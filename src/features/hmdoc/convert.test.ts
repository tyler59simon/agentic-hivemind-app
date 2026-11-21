// NS-3C: every page of NS-3B's corpus and this repository's docs converts to a rich page that opens for editing, writes
// the same text when it is written again, and exports to Markdown without failing.
import { describe, expect, it } from "vitest";
import { convertMarkdown } from "./convert";
import { stringifyDocument } from "./envelope";
import { exportMarkdown } from "./toMarkdown";
import { inspect } from "./validate";

const corpus = import.meta.glob("../rich/corpus/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const docs = import.meta.glob("/docs/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const pages = Object.entries({ ...corpus, ...docs }).map(([k, v]) => [k, v.replace(/\r\n/g, "\n")] as const);

describe("convert the corpus to rich pages", () => {
  it("has pages to convert", () => expect(pages.length).toBeGreaterThan(20));

  it.each(pages)("%s opens, rewrites identically and exports", (_name, text) => {
    const file = convertMarkdown(text, "Page");
    const read = inspect(file);
    if (!read.ok) throw new Error(read.reason);
    expect(stringifyDocument(read.doc, read.envelope.meta)).toBe(file);
    expect(() => exportMarkdown(read.doc, read.envelope.meta)).not.toThrow();
  });
});
