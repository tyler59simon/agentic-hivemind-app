// NS-7A: where an appended line goes (an existing heading, a missing one, Windows line endings), and how a Living Memory page
// is appended to: read, changed and written against the revision read, retried on a stale revision, refused when read cut off.
import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LM_READ_LIMIT, setTransport, type Invoke } from "../../lib/lm";
import { appendToLmPage, appendToPage, ATTEMPTS, captureLine, insertUnder } from "./append";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ created: false })) }));
afterEach(() => { setTransport(invoke as Invoke); vi.mocked(invoke).mockClear(); });

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

const hex = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
const where = { domain: "demo", notebook: "daily" };
const fail = (code: number, errCode: string, message: string) => ({ exit_code: code, result: null, error: { code: errCode, message } });

/** A fake Living Memory with one page. `pages` is what `doc read` answers in turn (the last one repeats), `writes` is what
 *  `doc write` was sent, and `stale` how many writes it refuses as stale. */
function memory(pages: string[], opts: { truncated?: boolean; stale?: number; revision?: string } = {}) {
  const writes: { body: string; expected: string }[] = [];
  const argvs: string[][] = [];
  let reads = 0;
  let stale = opts.stale ?? 0;
  setTransport(async (cmd, args) => {
    const argv = args.argv as string[];
    argvs.push(argv);
    if (argv[1] === "read") {
      const text = pages[Math.min(reads++, pages.length - 1)];
      return { exit_code: 0, error: null, result: { ...where, path: "Day.md", text, revision: opts.revision ?? await hex(text), size: text.length, updated: "2026-11-22T00:00:00Z", truncated: !!opts.truncated } };
    }
    if (argv[1] === "write") {
      writes.push({ body: args.body as string, expected: argv[argv.indexOf("--expected-revision") + 1] });
      if (stale-- > 0) return fail(6, "stale", "Stale revision");
      return { exit_code: 0, error: null, result: { operation_id: "op", revision: "new" } };
    }
    if (argv[1] === "create") return { exit_code: 0, error: null, result: { operation_id: "op", revision: "new" } };
    throw new Error(`unexpected ${cmd} ${argv.join(" ")}`);
  });
  return { writes, argvs, reads: () => reads };
}

describe("appending to a Living Memory page", () => {
  it("writes the page with the line added, against the revision it read", async () => {
    const page = "# Day\n\n## Captured\n\n- a\n";
    const m = memory([page]);
    expect(await appendToLmPage(where, "Day.md", "## Captured", "- b")).toEqual({ created: false });
    expect(m.writes).toEqual([{ body: "# Day\n\n## Captured\n\n- a\n- b\n", expected: await hex(page) }]);
    expect(m.argvs.find((a) => a[1] === "write")).toEqual(["doc", "write", "--expected-revision", await hex(page), "--include-private", "--", "demo", "daily", "Day.md"]);
  });

  it("keeps a page's Windows line endings and byte order mark", async () => {
    const page = "﻿# Day\r\n\r\n## Captured\r\n\r\n- a\r\n\r\n## Notes\r\n";
    const m = memory([page]);
    await appendToLmPage(where, "Day.md", "## Captured", "- b");
    expect(m.writes[0].body).toBe("﻿# Day\r\n\r\n## Captured\r\n\r\n- a\r\n- b\r\n\r\n## Notes\r\n");
  });

  it("reads the page again when its revision went stale, and adds the line to what is there now", async () => {
    const first = "# Day\n\n## Captured\n\n- a\n";
    const second = "# Day, edited\n\n## Captured\n\n- a\n- theirs\n";
    const m = memory([first, second], { stale: 1 });
    const seen: number[] = [];
    await appendToLmPage(where, "Day.md", "## Captured", "- mine", (attempt) => { seen.push(attempt); });
    expect(seen).toEqual([1, 2]);
    expect(m.writes.map((w) => w.body)).toEqual(["# Day\n\n## Captured\n\n- a\n- mine\n", "# Day, edited\n\n## Captured\n\n- a\n- theirs\n- mine\n"]);
    expect(m.writes[1].expected).toBe(await hex(second));
  });

  it("gives up after three attempts and says so", async () => {
    const m = memory(["x\n"], { stale: 99 });
    await expect(appendToLmPage(where, "Day.md", null, "- a")).rejects.toThrow(/kept changing/);
    expect(m.writes).toHaveLength(ATTEMPTS);
    expect(ATTEMPTS).toBe(3);
  });

  it("refuses a page Living Memory gave only the start of, and writes nothing", async () => {
    const text = "x".repeat(LM_READ_LIMIT);
    const m = memory([text], { truncated: true });
    await expect(appendToLmPage(where, "Day.md", "## Captured", "- a")).rejects.toThrow(/too long for Hivemind to add to/);
    expect(m.writes).toEqual([]);
    expect(m.reads()).toBe(1);
  });

  it("refuses a page that is not text it can save back unchanged", async () => {
    let m = memory(["a\r\nb\n"]);
    await expect(appendToLmPage(where, "Day.md", null, "- a")).rejects.toThrow(/mixes line-ending/);
    expect(m.writes).toEqual([]);
    // Bytes that were not UTF-8 come back with replacement characters: the revision is not the text's.
    m = memory(["caf�\n"], { revision: "0".repeat(64) });
    await expect(appendToLmPage(where, "Day.md", null, "- a")).rejects.toThrow(/not UTF-8/);
    expect(m.writes).toEqual([]);
  });

  it("makes the page when it is missing, and reads again when another writer made it first", async () => {
    const created: string[] = [];
    let reads = 0;
    setTransport(async (_cmd, args) => {
      const argv = args.argv as string[];
      if (argv[1] === "read") {
        reads++;
        return reads === 1 ? fail(2, "invalid", "not_found: no page Day.md") : { exit_code: 0, error: null, result: { ...where, path: "Day.md", text: "# Day\n", revision: await hex("# Day\n"), size: 6, updated: "", truncated: false } };
      }
      if (argv[1] === "create") {
        created.push(args.body as string);
        return fail(2, "invalid", "Day.md already exists");
      }
      return { exit_code: 0, error: null, result: { operation_id: "op", revision: "new" } };
    });
    expect(await appendToLmPage(where, "Day.md", "## Captured", "- a")).toEqual({ created: false });
    expect(created).toEqual(["## Captured\n\n- a\n"]);
    expect(reads).toBe(2);
  });

  it("makes a missing page with the heading and the line", async () => {
    const created: string[] = [];
    setTransport(async (_cmd, args) => {
      const argv = args.argv as string[];
      if (argv[1] === "read") return fail(2, "invalid", "not_found: no page Inbox.md");
      created.push(args.body as string);
      return { exit_code: 0, error: null, result: { operation_id: "op", revision: "new" } };
    });
    expect(await appendToLmPage(where, "Inbox.md", null, "- a")).toEqual({ created: true });
    expect(created).toEqual(["- a\n"]);
  });
});

describe("appending to a page of either kind", () => {
  it("sends a folder notebook's page to Rust, and a Living Memory page through the doc commands", async () => {
    await appendToPage("nb-12345678", "Daily/2026-11-22.md", "## Captured", "- a");
    expect(invoke).toHaveBeenCalledWith("notebook_append", { notebook: "nb-12345678", path: "Daily/2026-11-22.md", heading: "## Captured", text: "- a" });
    memory(["x\n"]);
    await appendToPage("lm:demo:daily", "Day.md", null, "- a");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
