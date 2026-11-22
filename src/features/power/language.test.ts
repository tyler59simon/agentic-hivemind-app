import { describe, expect, it } from "vitest";
import { describe as languageFor, detectIndent, languageList, PLAIN, support } from "./language";

describe("the language of a file", () => {
  it("comes from the file name", async () => {
    const names = await Promise.all(["a.py", "b.json", "c.rs", "d.ts", "e.yaml", "f.sql", "run.sh", "g.zzz", "Makefile"].map(async (f) => [f, (await languageFor(f))?.name ?? null]));
    expect(names).toEqual([["a.py", "Python"], ["b.json", "JSON"], ["c.rs", "Rust"], ["d.ts", "TypeScript"], ["e.yaml", "YAML"], ["f.sql", "SQL"], ["run.sh", "Shell"], ["g.zzz", null], ["Makefile", null]]);
  });

  it("can be chosen by name, over the file name", async () => {
    expect((await languageFor("notes.txt", "Python"))?.name).toBe("Python");
    expect((await languageFor("a.py", PLAIN))).toBeNull();
    expect((await languageFor("a.py", "No such language"))).toBeNull();
  });

  it("lists the languages the picker offers, and loads a grammar once", async () => {
    const all = await languageList();
    expect(all.length).toBeGreaterThan(50);
    expect(all.map((l) => l.name)).toEqual(expect.arrayContaining(["JavaScript", "Python", "Rust", "JSON"]));
    const json = (await languageFor("x.json"))!;
    expect(await support(json)).toBe(await support(json));
  });
});

describe("indentation", () => {
  it("is read from the first lines", () => {
    expect(detectIndent("")).toBe("No indentation");
    expect(detectIndent("a\nb\n")).toBe("No indentation");
    expect(detectIndent("a\n\tb\n\t\tc\n")).toBe("Tabs");
    expect(detectIndent("a\n  b\n    c\n  d\n")).toBe("2 spaces");
    expect(detectIndent("a\n    b\n        c\n    d\n")).toBe("4 spaces");
    expect(detectIndent("a\n   b\n")).toBe("3 spaces");
    // Mostly tabs, one space-indented line.
    expect(detectIndent("\ta\n\tb\n\tc\n  d\n")).toBe("Tabs");
    // Blank and whitespace-only lines say nothing.
    expect(detectIndent("a\n\n    \n    b\n")).toBe("4 spaces");
  });
});
