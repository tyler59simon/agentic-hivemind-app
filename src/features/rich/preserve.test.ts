// NS-3B: writing a page back does not parse again what it already checked. After a large paste of lists and
// paragraphs, writing the same document again parses nothing (Codex review of b0afec0, R2-6).
import { describe, expect, it, vi } from "vitest";

vi.mock("./markdown", async (load) => {
  const real = await load<typeof import("./markdown")>();
  return { ...real, parse: vi.fn(real.parse) };
});

const markdown = await import("./markdown");
const { loadPage, markdownNodes } = await import("./fromMarkdown");
const { serialize } = await import("./preserve");
const { richSchema } = await import("./schema");

describe("writing back", () => {
  it("remembers which blocks part, past a few hundred boundaries", () => {
    const schema = richSchema();
    const { doc, original } = loadPage(schema, "Start\n");
    const pasted = markdownNodes(schema, Array.from({ length: 400 }, (_, i) => `- item ${i}\n\nText ${i}\n`).join("\n"));
    const next = doc.type.create(null, [doc.child(0), ...pasted]);
    serialize(next, original);
    const parse = vi.mocked(markdown.parse);
    parse.mockClear();
    serialize(next, original);
    expect(parse).not.toHaveBeenCalled();
  });
});
