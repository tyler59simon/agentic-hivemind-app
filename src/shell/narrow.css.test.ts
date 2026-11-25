// @ts-expect-error no @types/node package (as in vite.config.ts); vitest empties CSS imports, so the file is read directly
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css: string = readFileSync(new URL("../App.css", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // a checkout may have CRLF
const narrow = css.slice(css.indexOf("@media (max-width: 960px)"));
const narrowRules = narrow.slice(0, narrow.indexOf("\n}\n"));

describe("the icon-only sidebar under 960 px (DESK-WIN)", () => {
  it("hides the labels on the sidebar but not in a menu opened from it (Codex review, DESK-R1)", () => {
    const hide = narrowRules.split("\n").find((l) => l.includes("clip: rect(0 0 0 0)"))!;
    expect(hide).toContain(".sidebar .grow:not(.menu-list .grow)");
    expect(hide).not.toMatch(/\.sidebar \.grow[,{ ]/);
  });
});

/** The `selector { body }` rules written on one line of `text`. */
const rules = (text: string) => text.split("\n").map((l) => /^\s*(.+?) \{ (.*) \}\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ selector: m[1], body: m[2] }));
const rule = (selector: string) => rules(css).find((r) => r.selector === selector)!;
const at = (needle: string) => css.indexOf(needle);

describe("the widths the user sets (DESK-LAYOUT)", () => {
  it("reach the sidebar, the notes list and the rail through variables whose fallbacks are the old sizes", () => {
    expect(rule(".shell").body).toContain("grid-template-columns: min(var(--sidebar-w, 15.4rem), 30vw) minmax(0, 1fr)");
    expect(rule(".notes-page").body).toContain("grid-template-columns: min(var(--tree-w, 16rem), 40vw) minmax(0, 1fr)");
    expect(rule(".note-rail").body).toContain("width: var(--rail-w, clamp(15rem, 24vw, 25rem))");
  });

  it("lose to the narrow rules, which come later, and do not read the variables", () => {
    expect(narrowRules).toContain(".shell { grid-template-columns: 4.2rem minmax(0, 1fr); }");
    expect(narrowRules).toContain(".notes-page { grid-template-columns: 13rem minmax(0, 1fr); }");
    expect(narrowRules).not.toMatch(/--sidebar-w|--tree-w|--rail-w/);
    expect(at("@media (max-width: 960px)")).toBeGreaterThan(at(".shell { display: grid"));
    expect(at("@media (max-width: 960px)")).toBeGreaterThan(at(".notes-page { display: grid"));
    // The rail over the note in a narrow window has its own width and is not capped by the one beside it.
    const overlay = rule(".notes-area.narrow .note-rail").body;
    expect(overlay).toContain("width: min(22rem, 85%)");
    expect(overlay).toContain("max-width: none");
    expect(at(".notes-area.narrow .note-rail {")).toBeGreaterThan(at(".note-rail { width: var(--rail-w"));
  });

  it("hide the splitters and the collapse button where the sidebar and the notes list have their own widths", () => {
    expect(narrowRules).toContain(".sidebar-toggle, .shell > .splitter, .notes-page > .splitter { display: none; }");
  });

  it("are hidden with the regions they size in focus mode, which wins over the narrow grid", () => {
    expect(rule(".shell.focus > .sidebar, .shell.focus .topbar, .shell.focus .notebooks, .shell.focus .note-rail, .shell.focus .splitter").body).toBe("display: none;");
    expect(rule(".shell.focus").body).toBe("grid-template-columns: minmax(0, 1fr);");
    expect(at(".shell.focus {")).toBeGreaterThan(at("@media (max-width: 960px)"));
  });
});

describe("the sidebar collapsed by the user (DESK-LAYOUT)", () => {
  it("has every icons-only rule of the narrow sidebar, under .shell.collapsed", () => {
    const ours = rules(css).filter((r) => r.selector.startsWith(".shell.collapsed")).map((r) => r.body);
    const theirs = rules(narrowRules).filter((r) => !/notes-page|\.agents|\.review|splitter|sidebar-toggle/.test(r.selector));
    expect(theirs.length).toBeGreaterThan(8);
    for (const r of theirs) expect(ours, r.selector).toContain(r.body);
  });

  it("keeps the label hiding off the labels of a menu opened from the sidebar", () => {
    const hide = rules(css).find((r) => r.selector.startsWith(".shell.collapsed") && r.body.includes("clip: rect(0 0 0 0)"))!;
    expect(hide.selector).toContain(".shell.collapsed .sidebar .grow:not(.menu-list .grow)");
  });
});

describe("the splitter", () => {
  it("has a 24 px hit area that lies over the edge, so it takes no layout width, and a visible focus", () => {
    const body = rule(".splitter").body;
    expect(body).toContain("position: absolute");
    expect(body).toContain("width: 24px");
    expect(rule(".splitter:focus-visible").body).toContain("outline: 2px solid var(--accent)");
    expect(rule(".pane-gap").body).toContain("width: 0");
  });
});
