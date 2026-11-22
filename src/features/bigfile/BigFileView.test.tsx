// @vitest-environment jsdom
// NS-6B: the large file viewer and the hex view over a model of Rust's `bigfile_*` commands.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOTAL = 1_000_000;
let prefix = "line";
const textOf = (n: number) => (n === 10 || n === 1500 || n === 999_999 ? `line ${n} NEEDLE here` : `${prefix} ${n}`);
const hits = [10, 1500, 999_999].map((line) => ({ line, start: `line ${line} `.length, end: `line ${line} NEEDLE`.length }));
const sent: { cmd: string; args: Record<string, unknown> }[] = [];
let size = 60_000_000;
let lines = TOTAL;
let binary = false;
let failOpen = "";
const listeners: { name: string; cb: (e: { payload: unknown }) => void }[] = [];
const emit = (name: string, payload: Record<string, unknown>) => act(async () => { for (const l of listeners.filter((x) => x.name === name)) l.cb({ payload: { handle: "h1", scanned: size, size, lines, done: true, reset: false, ...payload } }); });

const window_ = (first: number, count: number) => ({
  first, lines: Array.from({ length: Math.max(0, Math.min(count, lines - first)) }, (_, i) => ({ number: first + i, text: textOf(first + i), cut: false })),
  total: lines, indexed: true, size,
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    const entry = { name, cb };
    listeners.push(entry);
    return () => { listeners.splice(listeners.indexOf(entry), 1); };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, a: Record<string, unknown>) => {
    sent.push({ cmd, args: a });
    switch (cmd) {
      case "bigfile_open":
        if (failOpen) throw new Error(failOpen);
        return { handle: "h1", size, encoding: "UTF-8", bom: false, binary, first: window_(0, 120) };
      case "bigfile_lines": return window_(a.first as number, a.count as number);
      case "bigfile_search": {
        const [line, col, forward] = [a.line as number, a.col as number, a.forward as boolean];
        const after = (h: { line: number; start: number }) => h.line > line || (h.line === line && h.start >= col);
        const before = (h: { line: number; start: number }) => h.line < line || (h.line === line && h.start < col);
        const found = forward ? hits.find(after) : [...hits].reverse().find(before);
        const wrap = forward ? hits[0] : hits[hits.length - 1];
        return { hit: found ?? wrap, wrapped: !found, cancelled: false };
      }
      case "bigfile_bytes": {
        const [offset, len] = [a.offset as number, a.len as number];
        return Array.from({ length: Math.max(0, Math.min(len, size - offset)) }, (_, i) => (offset + i) % 256);
      }
      case "bigfile_find_bytes": return [4096 + 5, false];
      case "bigfile_close": return null;
    }
    return null;
  }),
}));

const { BigFileView } = await import("./BigFileView");
const { HexView } = await import("./HexView");

let root: Root | null = null;
let el: HTMLElement;
const settle = () => act(async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); });
const ref = { notebook: "nb-1", path: "huge.log" };

async function mount(node: React.ReactNode) {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => { root!.render(node); });
  await settle();
}
const lastRow = () => { const rows = rowNumbers(); return rows[rows.length - 1]; };
const lastCall = (cmd: string) => { const calls = sent.filter((s) => s.cmd === cmd); return calls[calls.length - 1].args; };
const rowNumbers = () => [...el.querySelectorAll<HTMLElement>(".bigfile-row")].map((r) => Number(r.dataset.line));
const type = (label: string, value: string) => act(async () => {
  const input = el.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const press = (label: string, key = "Enter", init: KeyboardEventInit = {}) => act(async () => {
  el.querySelector(`[aria-label="${label}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
});
const click = (label: string) => act(async () => { (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click(); });
const scroller = () => el.querySelector<HTMLElement>(".bigfile")!;
const scrollTo = (top: number) => act(async () => { const s = scroller(); s.scrollTop = top; s.dispatchEvent(new Event("scroll")); });
const status = () => el.querySelector("[role=toolbar] [role=status]")!.textContent;

beforeEach(() => { prefix = "line"; sent.length = 0; listeners.length = 0; size = 60_000_000; lines = TOTAL; binary = false; failOpen = ""; });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  el?.remove();
});

describe("the large file viewer", () => {
  it("draws only the rows in view, however many lines the file has", async () => {
    await mount(<BigFileView file={ref} />);
    const drawn = rowNumbers();
    expect(drawn[0]).toBe(1);
    expect(drawn.length).toBeGreaterThan(10);
    expect(drawn.length).toBeLessThan(60);
    expect(el.querySelector<HTMLElement>(".bigfile-space")!.style.height).toBe("8000000px");
    expect(el.querySelector(".bigfile-row .bigfile-text")!.textContent).toBe("line 0");
    expect(el.textContent).toContain("1,000,000 lines");
    expect(el.textContent).toContain("UTF-8");
    // The first window came with the open call; only what scrolling reaches is asked for.
    expect(sent.filter((s) => s.cmd === "bigfile_lines").every((s) => (s.args.first as number) >= 100)).toBe(true);
  });

  it("jumps to a line", async () => {
    await mount(<BigFileView file={ref} />);
    await type("Jump to line", "500,000");
    await press("Jump to line");
    await settle();
    const drawn = rowNumbers();
    expect(drawn).toContain(500_000);
    expect(drawn[0]).toBeGreaterThan(499_990);
    expect(el.querySelector(`[data-line="500000"] .bigfile-text`)!.textContent).toBe("line 499999");
    // A line past the end says how many there are, and a word that is not a number is asked for again.
    await type("Jump to line", "9,999,999");
    await press("Jump to line");
    expect(status()).toContain("1,000,000 lines");
    await type("Jump to line", "abc");
    await press("Jump to line");
    expect(status()).toBe("Type a line number");
  });

  it("scrolls with the scroll bar", async () => {
    await mount(<BigFileView file={ref} />);
    await scrollTo(4_000_000);
    expect(rowNumbers()[0]).toBeGreaterThan(450_000);
    expect(rowNumbers()[0]).toBeLessThan(550_000);
    await scrollTo(0);
    expect(rowNumbers()[0]).toBe(1);
  });

  it("searches forward and back, with the matches marked, and goes on from the other end", async () => {
    await mount(<BigFileView file={ref} />);
    await type("Search", "NEEDLE");
    await click("Next match");
    expect(status()).toBe("Line 11");
    expect(rowNumbers()).toContain(11);
    expect(el.querySelector(".bigfile-text mark.now")!.textContent).toBe("NEEDLE");
    // The next search starts at the end of this match.
    await click("Next match");
    expect(status()).toBe("Line 1,501");
    expect(sent.filter((s) => s.cmd === "bigfile_search").map((s) => [s.args.line, s.args.col, s.args.forward])).toEqual([[0, 0, true], [10, hits[0].end, true]]);
    await click("Next match");
    expect(status()).toBe("Line 1,000,000");
    await click("Next match");
    expect(status()).toBe("Line 11 (went on from the start)");
    await click("Previous match");
    expect(status()).toBe("Line 1,000,000 (went on from the end)");
    await click("Previous match");
    expect(status()).toBe("Line 1,501");
    // Enter is next, Shift+Enter previous.
    await press("Search");
    expect(status()).toBe("Line 1,000,000");
    await press("Search", "Enter", { shiftKey: true });
    expect(status()).toBe("Line 1,501");
    // The pattern and its options go to Rust as typed.
    await click("Regular expression");
    await click("Match case");
    await click("Next match");
    const last = lastCall("bigfile_search");
    expect([last.pattern, last.regex, last.case, last.forward]).toEqual(["NEEDLE", true, true, true]);
  });

  it("does not search for an empty or invalid pattern", async () => {
    await mount(<BigFileView file={ref} />);
    expect((el.querySelector("[aria-label='Next match']") as HTMLButtonElement).disabled).toBe(true);
    await type("Search", "(");
    await click("Regular expression");
    await click("Next match");
    expect(status()).toBe("This is not a valid pattern");
    expect(sent.some((s) => s.cmd === "bigfile_search")).toBe(false);
  });

  it("follows the end of a growing file, and stops following when the user scrolls away", async () => {
    await mount(<BigFileView file={ref} />);
    await click("Follow");
    expect(lastRow()).toBe(TOTAL);
    lines = TOTAL + 500;
    await emit("bigfile-grew", { lines });
    await settle();
    expect(lastRow()).toBe(TOTAL + 500);
    expect(el.textContent).toContain("1,000,500 lines");
    expect(el.querySelector(`[data-line="${TOTAL + 500}"] .bigfile-text`)!.textContent).toBe(`line ${TOTAL + 499}`);
    await scrollTo(1_000_000);
    expect(el.querySelector("[aria-pressed='true']")).toBeNull();
    lines = TOTAL + 600;
    await emit("bigfile-grew", { lines });
    expect(lastRow()).not.toBe(TOTAL + 600);
  });

  it("starts again from the top when the file was truncated or replaced", async () => {
    await mount(<BigFileView file={ref} />);
    await scrollTo(4_000_000);
    lines = 40;
    size = 900;
    prefix = "fresh";
    await emit("bigfile-grew", { lines, size, reset: true });
    await scrollTo(0);
    await settle();
    // Rows from the top, read again: none of what was read before is shown.
    expect(rowNumbers().slice(0, 3)).toEqual([1, 2, 3]);
    expect(el.querySelector(".bigfile-row .bigfile-text")!.textContent).toBe("fresh 0");
    expect(el.textContent).toContain("40 lines");
  });

  it("shows the encoding the reset reports when the file was replaced by one in another encoding", async () => {
    await mount(<BigFileView file={ref} />);
    expect(el.textContent).toContain("UTF-8");
    await emit("bigfile-grew", { lines: 40, size: 900, reset: true, encoding: "UTF-16 LE", bom: true, binary: false });
    expect(el.textContent).toContain("UTF-16 LE with BOM");
  });

  it("shows indexing progress until the index is done", async () => {
    await mount(<BigFileView file={ref} />);
    expect(el.querySelector("[role=progressbar]")).toBeNull();
    await emit("bigfile-progress", { scanned: 15_000_000, done: false, lines: 250_000 });
    expect(el.querySelector("[role=progressbar]")!.getAttribute("aria-valuenow")).toBe("25");
    expect(el.textContent).toContain("250,000 so far lines");
    await emit("bigfile-progress", { scanned: size, done: true });
    expect(el.querySelector("[role=progressbar]")).toBeNull();
  });

  it("copies the lines picked by their numbers", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => { written.push(t); } }, configurable: true });
    await mount(<BigFileView file={ref} />);
    expect((el.querySelector("[aria-label='Copy lines']") as HTMLButtonElement).disabled).toBe(true);
    await click("Select line 3");
    await act(async () => { el.querySelector<HTMLElement>("[aria-label='Select line 6']")!.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
    await click("Copy lines");
    await settle();
    expect(written).toEqual(["line 2\nline 3\nline 4\nline 5"]);
  });

  it("closes the file's handle when it goes, and says why a file did not open", async () => {
    await mount(<BigFileView file={ref} />);
    await act(async () => { root!.unmount(); });
    root = null;
    expect(sent.filter((s) => s.cmd === "bigfile_close").map((s) => s.args.handle)).toEqual(["h1"]);
    expect(listeners).toHaveLength(0);
    failOpen = "huge.log is in a protected place";
    el.remove();
    await mount(<BigFileView file={ref} />);
    expect(el.textContent).toContain("protected place");
  });

  it("marks a file that is not text", async () => {
    binary = true;
    await mount(<BigFileView file={ref} />);
    expect(el.textContent).toContain("Not a text file");
  });
});

describe("the hex view", () => {
  const hexRows = () => [...el.querySelectorAll<HTMLElement>(".hex-row")];

  it("shows offset, bytes and text for the rows in view only", async () => {
    size = 200 * 1024 * 1024;
    await mount(<HexView file={ref} />);
    const rows = hexRows();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(60);
    expect(rows[0].querySelector(".hex-offset")!.textContent).toBe("00000000");
    expect([...rows[0].querySelectorAll(".hex-byte")].map((b) => b.textContent).join(" ")).toBe("00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f");
    expect(rows[2].querySelector(".hex-offset")!.textContent).toBe("00000020");
    // 0x20 to 0x2f: printable ASCII shows as itself, the rest as dots.
    expect(rows[2].querySelector(".hex-text")!.textContent).toBe(" !\"#$%&'()*+,-./");
    expect(rows[0].querySelector(".hex-text")!.textContent).toBe("................");
  });

  it("jumps to an offset, in hex or decimal", async () => {
    size = 200 * 1024 * 1024;
    await mount(<HexView file={ref} />);
    await type("Jump to offset", "0x10000");
    await press("Jump to offset");
    await settle();
    let offsets = hexRows().map((r) => r.dataset.offset);
    expect(offsets).toContain(String(0x10000));
    expect(el.querySelector(`[data-offset="${0x10000}"] .hex-offset`)!.textContent).toBe("00010000");
    await type("Jump to offset", "1048576");
    await press("Jump to offset");
    await settle();
    offsets = hexRows().map((r) => r.dataset.offset);
    expect(offsets).toContain(String(1048576));
    await type("Jump to offset", "zz");
    await press("Jump to offset");
    expect(status()).toBe("Type an offset: 0x1f40 or 8000");
  });

  it("searches for bytes typed as hex or text and marks the match", async () => {
    size = 200 * 1024 * 1024;
    await mount(<HexView file={ref} />);
    await type("Search bytes", "05 06 07");
    await click("Next match");
    await settle();
    const call = lastCall("bigfile_find_bytes");
    expect([call.needle, call.forward]).toEqual([[5, 6, 7], true]);
    expect(status()).toBe("Offset 0x1005");
    const marked = [...el.querySelectorAll(".hex-byte.now")].map((b) => b.textContent);
    expect(marked).toEqual(["05", "06", "07"]);
    // Previous searches before the match.
    await click("Previous match");
    expect(lastCall("bigfile_find_bytes")).toMatchObject({ offset: 0x1005, forward: false });
    // Text is sent as UTF-8 bytes; something that is not hex is not sent.
    await click("Search for text");
    await type("Search bytes", "Hi");
    await click("Next match");
    expect(lastCall("bigfile_find_bytes").needle).toEqual([72, 105]);
    await click("Search for text");
    await type("Search bytes", "xyz");
    const before = sent.length;
    await click("Next match");
    expect(status()).toBe("Type bytes as hex, such as de ad be ef");
    expect(sent.length).toBe(before);
  });

  it("closes its handle", async () => {
    await mount(<HexView file={ref} />);
    await act(async () => { root!.unmount(); });
    root = null;
    expect(sent.some((s) => s.cmd === "bigfile_close")).toBe(true);
  });
});
