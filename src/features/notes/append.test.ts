// NS-7A: where an appended line goes (an existing heading, a missing one, Windows line endings), and that a folder notebook's
// page is appended to by Rust. Hosted notebook pages were retired by CON-18.
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendToPage, captureLine, insertUnder } from "./append";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ created: false })) }));
afterEach(() => { vi.mocked(invoke).mockClear(); });

describe("where an appended line goes", () => {
  it("is the end of an existing section, before the blank line that precedes the next heading", () => {
    const page = "# Day\n\n## Captured\n\n- 09:00 first\n\n## Notes\n\ntext\n";
    expect(insertUnder(page, "## Captured", "- 10:00 second")).toBe("# Day\n\n## Captured\n\n- 09:00 first\n- 10:00 second\n\n## Notes\n\ntext\n");
    expect(insertUnder("## Captured\n\n- a\n", "## Captured", "- b")).toBe("## Captured\n\n- a\n- b\n");
    expect(insertUnder("## Captured\n- a", "## Captured", "- b")).toBe("## Captured\n- a\n- b\n");
    // Case, closing hashes and deeper headings: a deeper heading belongs to the section, a heading of the same level ends it.
    expect(insertUnder("## captured ##\n- a\n### Sub\n- s\n## Next\n", "## Captured", "- b")).toBe("## captured ##\n- a\n### Sub\n- s\n- b\n## Next\n");
  });

  it("is a blank line and the line, in a section that has nothing yet", () => {
    expect(insertUnder("## Captured\n\n## Next\n", "## Captured", "- a")).toBe("## Captured\n\n- a\n\n## Next\n");
    expect(insertUnder("## Captured\n## Next\n", "## Captured", "- a")).toBe("## Captured\n\n- a\n\n## Next\n");
    expect(insertUnder("## Captured\n", "## Captured", "- a")).toBe("## Captured\n\n- a\n");
  });

  it("is a new heading at the end of the page when the page has none", () => {
    expect(insertUnder("# Day\n\ntext\n", "## Captured", "- a")).toBe("# Day\n\ntext\n\n## Captured\n\n- a\n");
    expect(insertUnder("text", "## Captured", "- a")).toBe("text\n\n## Captured\n\n- a\n");
    expect(insertUnder("text\n\n\n", "## Captured", "- a")).toBe("text\n\n## Captured\n\n- a\n");
    expect(insertUnder("", "## Captured", "- a")).toBe("## Captured\n\n- a\n");
    // A heading of another level or text is another heading, and one inside a code block is not a heading.
    expect(insertUnder("# Captured\n", "## Captured", "- a")).toBe("# Captured\n\n## Captured\n\n- a\n");
    expect(insertUnder("```\n## Captured\n```\n", "## Captured", "- a")).toBe("```\n## Captured\n```\n\n## Captured\n\n- a\n");
  });

  it("is the end of the page with no heading", () => {
    expect(insertUnder("- a\n", null, "- b")).toBe("- a\n- b\n");
    expect(insertUnder("- a", null, "- b")).toBe("- a\n- b\n");
    expect(insertUnder("", null, "- b")).toBe("- b\n");
  });

  it("keeps Windows line endings", () => {
    expect(insertUnder("# Day\r\n\r\n## Captured\r\n\r\n- a\r\n\r\n## Notes\r\n", "## Captured", "- b")).toBe("# Day\r\n\r\n## Captured\r\n\r\n- a\r\n- b\r\n\r\n## Notes\r\n");
    expect(insertUnder("# Day\r\n", "## Captured", "- b")).toBe("# Day\r\n\r\n## Captured\r\n\r\n- b\r\n");
    expect(insertUnder("- a\r\n", null, "- b")).toBe("- a\r\n- b\r\n");
  });

  it("refuses a heading that is not one", () => {
    expect(() => insertUnder("x", "Captured", "- a")).toThrow(/Markdown heading/);
    expect(() => insertUnder("x", "#hashtag", "- a")).toThrow(/Markdown heading/);
  });
});

describe("a captured line", () => {
  it("is the time, the title and the summary, with details under it", () => {
    expect(captureLine("14:05", "Call Ann", "About the plan.", "ask for the date\n- bring notes\n\n")).toBe("- 14:05 Call Ann: About the plan.\n  - ask for the date\n  - bring notes");
    expect(captureLine("14:05", "", "Just this", "")).toBe("- 14:05 Just this");
    expect(captureLine("14:05", "Only a title", "  ", "")).toBe("- 14:05 Only a title");
    expect(captureLine("2026-11-22 14:05", "T", "first\nsecond", "")).toBe("- 2026-11-22 14:05 T: first\n  second");
  });
});

describe("appending to a page", () => {
  it("sends a folder notebook's page to Rust", async () => {
    await appendToPage("nb-12345678", "Daily/2026-11-22.md", "## Captured", "- a");
    expect(invoke).toHaveBeenCalledWith("notebook_append", { notebook: "nb-12345678", path: "Daily/2026-11-22.md", heading: "## Captured", text: "- a" });
  });
});
