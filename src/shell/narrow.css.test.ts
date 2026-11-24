// @ts-expect-error no @types/node package (as in vite.config.ts); vitest empties CSS imports, so the file is read directly
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css: string = readFileSync(new URL("../App.css", import.meta.url), "utf8");
const narrow = css.slice(css.indexOf("@media (max-width: 960px)"));
const narrowRules = narrow.slice(0, narrow.indexOf("\n}\n"));

describe("the icon-only sidebar under 960 px (DESK-WIN)", () => {
  it("hides the labels on the sidebar but not in a menu opened from it (Codex review, DESK-R1)", () => {
    const hide = narrowRules.split("\n").find((l) => l.includes("clip: rect(0 0 0 0)"))!;
    expect(hide).toContain(".sidebar .grow:not(.menu-list .grow)");
    expect(hide).not.toMatch(/\.sidebar \.grow[,{ ]/);
  });
});
