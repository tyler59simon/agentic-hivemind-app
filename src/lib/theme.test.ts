// @ts-expect-error no @types/node package (as in vite.config.ts); vitest empties CSS imports, so the file is read directly
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prefs } from "./prefs";

const css: string = readFileSync(new URL("../App.css", import.meta.url), "utf8");

const tokens = (block: string) => new Set([...block.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));

describe("themes", () => {
  it("gives every colour token an Emerald value", () => {
    const purple = tokens(css.match(/:root \{([\s\S]*?)\n\}/)![1]);
    const emerald = tokens(css.match(/:root\[data-theme="emerald"\] \{([\s\S]*?)\n\}/)![1]);
    const colours = [...purple].filter((t) => !t.startsWith("--font-"));
    expect(colours.filter((t) => !emerald.has(t))).toEqual([]);
    expect([...emerald].filter((t) => !purple.has(t))).toEqual([]);
  });

  it("falls back to Purple when nothing is saved", () => {
    expect(prefs.theme()).toBe("purple");
  });
});
