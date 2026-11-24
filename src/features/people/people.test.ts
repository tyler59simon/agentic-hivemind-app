// CON-15: where People lives, the file name and text of a new page, and which page an owner names.
import { describe, expect, it } from "vitest";
import type { Notebook } from "../../lib/notebooks";
import { matchOwner, personFileName, personOf, personPageText, resolvePeople, type Person } from "./people";

const nb = (id: string): Notebook => ({ id, path: `C:\\${id}`, title: id, added: "" });
const person = (title: string, aliases: string[] = []): Person => ({ notebook: "a", path: `People/${title}.md`, title, aliases, role: "", email: "" });

describe("resolvePeople", () => {
  it("is the first notebook whose sidecar has a people key", () => {
    const metas = { a: {}, b: { people: { folder: "Team" } }, c: { people: { folder: "Other" } } };
    expect(resolvePeople([nb("a"), nb("b"), nb("c")], metas)).toEqual({ notebook: "b", folder: "Team" });
  });
  it("defaults the folder to People and cleans it", () => {
    expect(resolvePeople([nb("a")], { a: { people: {} } })).toEqual({ notebook: "a", folder: "People" });
    expect(resolvePeople([nb("a")], { a: { people: { folder: " \\Staff\\Leads/ " } } })).toEqual({ notebook: "a", folder: "Staff/Leads" });
    expect(resolvePeople([nb("a")], { a: { people: { folder: "  " } } })).toEqual({ notebook: "a", folder: "People" });
  });
  it("is null when no notebook has it", () => {
    expect(resolvePeople([nb("a")], { a: { daily: {} } })).toBeNull();
    expect(resolvePeople([nb("a")], {})).toBeNull();
  });
});

describe("a new page", () => {
  it("keeps a plain name as the file name", () => {
    expect(personFileName("Dana Lee")).toBe("Dana Lee");
    expect(personPageText("Dana Lee")).toBe("---\nrole:\nemail:\naliases: []\n---\n# Dana Lee\n");
  });
  it("replaces characters Windows refuses and keeps the name as an alias", () => {
    expect(personFileName(' Lee/Dana: "QA"? ')).toBe("Lee-Dana- -QA--");
    expect(personFileName("a\\b*c<d>e|f")).toBe("a-b-c-d-e-f");
    expect(personPageText("R/D Lab")).toBe('---\nrole:\nemail:\naliases: ["R/D Lab"]\n---\n# R/D Lab\n');
  });
});

describe("personOf", () => {
  it("reads aliases as a string or a list, and role and email", () => {
    const row = { notebook: "a", path: "People/Dana.md", title: "Dana" };
    expect(personOf({ ...row, props: { aliases: ["D", " Dee "], role: "Lead", email: "d@x.io" } })).toMatchObject({ aliases: ["D", "Dee"], role: "Lead", email: "d@x.io" });
    expect(personOf({ ...row, props: { aliases: "D" } })).toMatchObject({ aliases: ["D"], role: "", email: "" });
    expect(personOf({ ...row, props: {} }).aliases).toEqual([]);
  });
  it("takes the file name as the title of a page with no heading", () => {
    expect(personOf({ notebook: "a", path: "People/Dana Lee.md", title: "", props: {} }).title).toBe("Dana Lee");
  });
});

describe("matchOwner", () => {
  const people = [person("Dana Lee", ["Dana"]), person("Dana", ["Dee"]), person("Sam Okafor", ["Dana"])];
  it("ignores case and outer spaces", () => {
    expect(matchOwner(people, "  sam OKAFOR ")?.title).toBe("Sam Okafor");
  });
  it("prefers a title match over an alias", () => {
    expect(matchOwner(people, "dana")?.title).toBe("Dana");
  });
  it("takes the first alias match in title order", () => {
    expect(matchOwner([person("Ana", ["Al"]), person("Bo", ["al"])], "AL")?.title).toBe("Ana");
  });
  it("matches the file name when the heading differs", () => {
    const renamed = { notebook: "a", path: "People/Dana Lee.md", title: "Dana Lee (Platform)", aliases: [], role: "", email: "" };
    expect(matchOwner([renamed], "dana lee")).toBe(renamed);
  });
  it("is null for an unknown or empty owner", () => {
    expect(matchOwner(people, "Pat")).toBeNull();
    expect(matchOwner(people, "  ")).toBeNull();
  });
});
