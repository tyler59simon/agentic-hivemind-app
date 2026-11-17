import { describe, expect, it } from "vitest";
import type { WikiModel, WikiNote } from "../../lib/lm";
import { azGroups, crumbs, dayGroups, folderChain, indexModel, monthGroups, monthLabel, neighbours, pathPrefix, resolveLink, resolvePage, searchNotes, shortTitle, treeKeys, treeOpen, treeRows } from "./wiki";

const note = (id: string, over: Partial<WikiNote> = {}): WikiNote => ({
  id, ref: id.slice(0, 8), title: id, type: "decision", status: "active", tags: [], files: [], updated: "2026-11-01", created: "2026-11-01",
  lead: "", body: "", out: [], backlinks: [], project: "core", section: "decisions", folder: null, filename: null, ...over,
});

const a = note("aaaaaaaa-1", { title: "Alpha", updated: "2026-11-10", tags: ["concern/cache"], lead: "first lead", body: "mentions needle" });
const b = note("bbbbbbbb-2", { title: "beta", updated: "2026-11-10" });
const c = note("cccccccc-3", { title: "Gamma", updated: "2026-10-30", lead: "needle in the lead" });
const old = note("dddddddd-4", { title: "Alpha", updated: "2026-09-01", status: "archived", retired: true });
const brief = note("eeeeeeee-5", { title: "Core brief", type: "brief", section: "overview", updated: "2026-11-12" });
const file1 = note("ffffffff-6", { title: "src/lib/a.ts: the a module", type: "knowledge", section: "code", files: ["core/src/lib/a.ts"], folder: "c-2", filename: "a.ts" });
const file2 = note("11111111-7", { title: "src/lib/b.ts: the b module", type: "knowledge", section: "code", files: ["core/src/lib/b.ts"], folder: "c-2", filename: "b.ts" });
const mine = note("22222222-8", { title: "9 lives", project: "general", section: "reference" });

const model: WikiModel = {
  domain: "demo", generated: "2026-11-17", renderer: 1, archived: true,
  notes: [a, b, c, old, brief, file1, file2, mine],
  projects: [
    {
      slug: "core", name: "Core", description: "", aliases: [], repos: ["core"], status: "active", charter: null, count: 7, updated: "2026-11-12", briefs: [brief.id], maps: [],
      sections: { overview: { notes: [brief.id], count: 1 }, decisions: { notes: [a.id, b.id, c.id, old.id], count: 4 }, code: { folders: ["c-1"], count: 2 } },
    },
    { slug: "core-extra", name: "Core extra", description: "", aliases: [], repos: [], status: "active", charter: null, count: 0, updated: "", briefs: [], maps: [], sections: { decisions: { notes: [], count: 0 } } },
    { slug: "general", name: "General", description: "", aliases: [], repos: [], status: "active", charter: null, count: 1, updated: "2026-11-01", briefs: [], maps: [], sections: { reference: { notes: [mine.id], count: 1 } } },
  ],
  folders: [
    { id: "c-1", project: "core", name: "src/lib", path: "core/src/lib", parent: null, folders: ["c-2"], notes: [], count: 2 },
    { id: "c-2", project: "core", name: "tools", path: "core/src/lib/tools", parent: "c-1", folders: [], notes: [file1.id, file2.id], count: 2 },
  ],
  sections: [
    { key: "overview", label: "Overview", blurb: "" }, { key: "decisions", label: "Decisions", blurb: "" },
    { key: "reference", label: "Reference", blurb: "" }, { key: "code", label: "Code reference", blurb: "" },
  ],
  external: { "other note": { title: "Other note", domain: "_global" } },
};
const ix = indexModel(model);

describe("resolvePage", () => {
  it("maps each address of the export to a page", () => {
    expect(resolvePage(ix, undefined).kind).toBe("main");
    expect(resolvePage(ix, "").kind).toBe("main");
    expect(resolvePage(ix, "az").kind).toBe("az");
    expect(resolvePage(ix, "recent").kind).toBe("recent");
    expect(resolvePage(ix, "p-core")).toMatchObject({ kind: "project", project: { slug: "core" } });
    expect(resolvePage(ix, "c-2")).toMatchObject({ kind: "folder", folder: { id: "c-2" } });
    expect(resolvePage(ix, "n-aaaaaaaa")).toMatchObject({ kind: "note", note: { id: a.id } });
  });

  it("finds a section when one project slug starts with another", () => {
    expect(resolvePage(ix, "s-core-decisions")).toMatchObject({ kind: "section", project: { slug: "core" }, section: { key: "decisions" } });
    expect(resolvePage(ix, "s-core-extra-decisions")).toMatchObject({ kind: "section", project: { slug: "core-extra" } });
  });

  it("answers unknown addresses with missing", () => {
    for (const at of ["n-zzzzzzzz", "p-nope", "s-core-nope", "c-99", "whatever"]) expect(resolvePage(ix, at)).toEqual({ kind: "missing", at });
  });
});

describe("titles", () => {
  it("shows a file note by its description and keeps the path", () => {
    expect(pathPrefix(file1)).toBe("src/lib/a.ts");
    expect(shortTitle(file1)).toBe("the a module");
    expect(shortTitle(a)).toBe("Alpha");
    expect(pathPrefix({ title: "Intro: what is this", files: ["x"] })).toBe("");
    expect(pathPrefix({ title: "src/a.ts: x", files: [] })).toBe("");
  });
});

describe("crumbs", () => {
  const labels = (at: string) => crumbs(ix, resolvePage(ix, at)).map((x) => x.label);
  it("lists project, section, folders and page", () => {
    expect(labels("")).toEqual(["Wiki"]);
    expect(labels("s-core-decisions")).toEqual(["Wiki", "Core", "Decisions"]);
    expect(labels("n-aaaaaaaa")).toEqual(["Wiki", "Core", "Decisions", "Alpha"]);
    expect(labels("c-2")).toEqual(["Wiki", "Core", "Code reference", "src/lib", "tools"]);
    expect(labels("n-ffffffff")).toEqual(["Wiki", "Core", "Code reference", "src/lib", "tools", "a.ts"]);
  });
  it("gives every crumb an address that resolves", () => {
    for (const x of crumbs(ix, resolvePage(ix, "n-ffffffff"))) expect(resolvePage(ix, x.at).kind).not.toBe("missing");
  });
  it("walks a folder up to its root", () => {
    expect(folderChain(ix, ix.folders.get("c-2")).map((f) => f.id)).toEqual(["c-1", "c-2"]);
  });
});

describe("neighbours", () => {
  it("walks the section in its order", () => {
    expect(neighbours(ix, a)).toEqual({ prev: undefined, next: b });
    expect(neighbours(ix, c)).toEqual({ prev: b, next: old });
  });
  it("walks the folder for a code page", () => {
    expect(neighbours(ix, file1)).toEqual({ prev: undefined, next: file2 });
    expect(neighbours(ix, file2).prev).toBe(file1);
  });
  it("has none for the only page of a section", () => {
    expect(neighbours(ix, brief)).toEqual({ prev: undefined, next: undefined });
  });
});

describe("groups", () => {
  it("names months and groups neighbours", () => {
    expect(monthLabel("2026-11-17")).toBe("November 2026");
    expect(monthLabel("")).toBe("Undated");
    expect(monthGroups([a, b, c, old]).map((g) => [g.label, g.notes.length])).toEqual([["November 2026", 2], ["October 2026", 1], ["September 2026", 1]]);
  });
  it("groups the A to Z index by letter, with # last-ditch for other starts", () => {
    const groups = azGroups(model.notes);
    expect(groups.map((g) => g.letter)).toEqual(["#", "A", "B", "C", "G", "T"]);
    expect(groups.find((g) => g.letter === "A")!.notes.map((n) => n.id)).toEqual([a.id, old.id]);
    expect(groups.find((g) => g.letter === "B")!.notes[0].id).toBe(b.id);
  });
  it("lists recent changes newest day first", () => {
    const days = dayGroups(model.notes, 4);
    expect(days.map((d) => d.day)).toEqual(["2026-11-12", "2026-11-10", "2026-11-01"]);
    expect(days[1].notes.map((n) => n.id)).toEqual([a.id, b.id]);
  });
});

describe("searchNotes", () => {
  it("ranks title, then tags, then lead, then body", () => {
    const hits = searchNotes([c, a, b, old], "alpha").map((n) => n.id);
    expect(hits).toEqual([a.id, old.id]);
    expect(searchNotes(model.notes, "needle").map((n) => n.id)).toEqual([c.id, a.id]);
    expect(searchNotes(model.notes, "concern/cache").map((n) => n.id)).toEqual([a.id]);
    expect(searchNotes(model.notes, "  ")).toEqual([]);
  });
});

describe("resolveLink", () => {
  it("finds a page here, a note in another domain, or nothing", () => {
    expect(resolveLink(ix, " ALPHA ")).toEqual({ kind: "note", note: a });
    expect(resolveLink(ix, "Other Note")).toEqual({ kind: "external", domain: "_global" });
    expect(resolveLink(ix, "No such note")).toEqual({ kind: "unresolved" });
  });
  it("finds an external note whose model key is Python casefold, not lowercase", () => {
    const folded = indexModel({ ...model, external: { strasse: { title: "Straße", domain: "_global" } } });
    expect(resolveLink(folded, "straße")).toEqual({ kind: "external", domain: "_global" });
  });
  it("prefers the active note over a retired one with the same title", () => {
    expect(indexModel({ ...model, notes: [old, a] }).titles.get("alpha")).toBe(a);
  });
});

describe("tree", () => {
  it("highlights the nearest listed ancestor", () => {
    expect(treeKeys(ix, resolvePage(ix, "n-aaaaaaaa"))).toEqual(["s-core-decisions", "p-core"]);
    expect(treeKeys(ix, resolvePage(ix, "n-ffffffff"))).toEqual(["c-1", "s-core-code", "p-core"]);
    expect(treeKeys(ix, resolvePage(ix, "c-2"))[0]).toBe("c-2");
  });
  it("opens the project, and the code branch for code pages", () => {
    expect(treeOpen(ix, resolvePage(ix, "n-ffffffff"))).toEqual({ project: "core", code: true });
    expect(treeOpen(ix, resolvePage(ix, "n-aaaaaaaa"))).toEqual({ project: "core", code: false });
    expect(treeOpen(ix, resolvePage(ix, "az"))).toEqual({});
  });
});

describe("treeRows", () => {
  const ats = (open: Record<string, boolean>) => treeRows(ix, open).flatMap((r) => (r.kind === "row" ? [r.at] : []));
  it("lists projects collapsed, then the browse pages", () => {
    expect(ats({})).toEqual(["", "p-core", "p-core-extra", "p-general", "az", "recent"]);
  });
  it("shows a project's sections, and its root code folders once the code branch is open", () => {
    expect(ats({ "p-core": true })).toEqual(["", "p-core", "s-core-overview", "s-core-decisions", "s-core-code", "p-core-extra", "p-general", "az", "recent"]);
    expect(ats({ "p-core": true, "code-core": true })).toContain("c-1");
    expect(ats({ "p-core": true, "code-core": true })).not.toContain("c-2");
  });
  it("highlights a row the tree lists", () => {
    const rows = ats({ "p-core": true });
    const key = treeKeys(ix, resolvePage(ix, "n-ffffffff")).find((k) => rows.includes(k));
    expect(key).toBe("s-core-code");
  });
});
