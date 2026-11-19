import { describe, expect, it } from "vitest";
import type { WikiModel, WikiNote } from "../../lib/lm";
import type { WikiBuildResult } from "../../lib/wiki";
import {
  agentSections, applyProgress, azGroups, buildBlocked, buildOutcome, callsNote, callsText, citeIndex, CITE_PREFIX, citeLinks, citedOn, crumbs, dayGroups, folderChain, indexModel, isAgent, isSource, isStale,
  monthGroups, monthLabel, neighbours, noteAt, pageCounts, pageStatus, pathPrefix, resolveLink, resolvePage, searchNotes, shortTitle, sourceState, treeKeys, treeOpen, treeRows, usd, wikiRoute,
} from "./wiki";

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
    expect(resolveLink(folded, "STRASSE")).toEqual({ kind: "external", domain: "_global" });
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

// ---- The agent-written edition: a model written from the interface contract ----

const src = (id: string, over: Partial<WikiNote> = {}) =>
  note(id, { project: "wiki", section: "sources", type: "knowledge", title: `Source ${id}`, ...over });
const s1 = src("5a000001-aaaa", { title: "Bridge design", type: "decision" });
const s2 = src("5a000002-bbbb", { title: "Watcher", updated: "2026-11-15" });
const s3 = src("5a000003-cccc", { title: "Overview" }); // the same title as a page: the page wins
const pageSrc = (n: WikiNote, over: Partial<{ current: boolean; missing: boolean }> = {}) => ({ id: n.id, ref: n.ref, title: n.title, type: n.type, current: true, missing: false, ...over });
const article = (id: string, title: string, section: string, page: Partial<NonNullable<WikiNote["page"]>>, over: Partial<WikiNote> = {}) =>
  note(id, {
    ref: id, title, type: "article", project: "wiki", section, updated: "2026-11-19", created: "2026-11-18", lead: "", body: "",
    page: { purpose: `About ${title}`, written: true, stale: false, built: "2026-11-19T10:00:00Z", model: "sonnet", cost_usd: 0.12, warnings: [], sources: [], ...page }, ...over,
  });
const p1 = article("pg000001", "Overview", "a1", { sources: [pageSrc(s1), pageSrc(s2)] },
  { lead: "Hivemind reads Living Memory.[^1]", body: "## How it talks\nThe bridge carries every call.[^1] A watcher refreshes the page.[^2] See [[The bridge]] and `[^1]` in code.[^9]\n" });
const p2 = article("pg000002", "The bridge", "a1", { sources: [pageSrc(s1, { current: false })] }, { body: "One process.[^1]", lead: "One long-lived process." });
const p3 = article("pg000003", "Themes", "a2", { written: false, sources: [pageSrc(s2)] }, { lead: "About Themes" });
const p4 = article("pg000004", "Old facts", "a2", { sources: [pageSrc(s3, { missing: true })] }, { body: "Gone.[^1]", lead: "Gone." });

const agentModel: WikiModel = {
  domain: "demo", generated: "2026-11-19", renderer: 2, archived: false, edition: "agent", scope: "domain",
  build: { built: "2026-11-19T10:00:00Z", model: "sonnet", cost_usd: 0.9, pages: 4, written: 3, stale: 2, pending: 1, complete: false, omitted: [{ id: "x-1", title: "Removed feature", reason: "No longer exists." }] },
  notes: [p1, p2, p3, p4, s1, s2, s3],
  projects: [{
    slug: "wiki", name: "Demo", description: "A demo wiki.", aliases: [], repos: [], status: "active", charter: null, count: 4, updated: "2026-11-19", briefs: [], maps: [],
    sections: { a1: { notes: [p1.id, p2.id], count: 2 }, a2: { notes: [p3.id, p4.id], count: 2 } },
  }],
  folders: [],
  sections: [{ key: "a1", label: "Architecture", blurb: "How it works." }, { key: "a2", label: "Look and feel", blurb: "" }],
  external: {},
};
const aix = indexModel(agentModel);

describe("agent edition: indexing and addresses", () => {
  it("resolves pages, cited notes, the wiki project and its sections by the usual addresses", () => {
    expect(resolvePage(aix, "n-pg000001")).toMatchObject({ kind: "note", note: { id: "pg000001" } });
    expect(resolvePage(aix, noteAt(s2))).toMatchObject({ kind: "note", note: { id: s2.id } });
    expect(resolvePage(aix, "p-wiki").kind).toBe("project");
    expect(resolvePage(aix, "s-wiki-a2")).toMatchObject({ kind: "section", section: { key: "a2" } });
    expect(resolvePage(aix, "s-wiki-sources").kind).toBe("missing");
  });

  it("tells a page from a cited note, and a page wins a [[Title]] shared with one", () => {
    expect(isAgent(agentModel)).toBe(true);
    expect(isAgent(model)).toBe(false);
    expect([p1, s1].map(isSource)).toEqual([false, true]);
    expect(resolveLink(aix, "overview")).toEqual({ kind: "note", note: p1 });
    expect(resolveLink(aix, "The bridge")).toEqual({ kind: "note", note: p2 });
    expect(resolveLink(aix, "Watcher")).toEqual({ kind: "note", note: s2 });
  });

  it("lists the agent's sections with their pages and never the sources section", () => {
    expect(agentSections(aix).map((s) => [s.section.key, s.pages.map((n) => n.id)])).toEqual([["a1", [p1.id, p2.id]], ["a2", [p3.id, p4.id]]]);
    expect(aix.model.sections.map((s) => s.key)).not.toContain("sources");
  });
});

describe("agent edition: tree, crumbs and keys", () => {
  it("lists contents, then each section with its pages, marking planned and stale ones", () => {
    const rows = treeRows(aix, {});
    expect(rows.flatMap((r) => (r.kind === "row" ? [[r.at, r.depth, r.flag ?? ""]] : []))).toEqual([
      ["", 0, ""], ["s-wiki-a1", 0, ""], ["n-pg000001", 1, ""], ["n-pg000002", 1, "stale"],
      ["s-wiki-a2", 0, ""], ["n-pg000003", 1, "planned"], ["n-pg000004", 1, "stale"],
    ]);
    expect(rows.some((r) => r.kind === "row" && r.at.includes("5a0000"))).toBe(false);
  });

  it("names a page by its section, and drops the project step", () => {
    expect(crumbs(aix, resolvePage(aix, "n-pg000003")).map((c) => c.label)).toEqual(["Wiki", "Look and feel", "Themes"]);
    expect(crumbs(aix, resolvePage(aix, "n-pg000003")).map((c) => c.at)).toEqual(["", "s-wiki-a2", "n-pg000003"]);
    expect(crumbs(aix, resolvePage(aix, noteAt(s2))).map((c) => c.label)).toEqual(["Wiki", "Watcher"]);
  });

  it("highlights the page, else its section; a cited note has no row", () => {
    expect(treeKeys(aix, resolvePage(aix, "n-pg000002"))).toEqual(["n-pg000002", "s-wiki-a1"]);
    expect(treeKeys(aix, resolvePage(aix, "s-wiki-a2"))).toEqual(["s-wiki-a2"]);
    expect(treeKeys(aix, resolvePage(aix, noteAt(s1)))).toEqual([]);
    expect(treeKeys(aix, resolvePage(aix, ""))).toEqual([""]);
  });

  it("walks a page's section for previous and next", () => {
    expect(neighbours(aix, p1)).toEqual({ prev: undefined, next: p2 });
    expect(neighbours(aix, p4).prev).toBe(p3);
  });
});

describe("agent edition: stale, planned and written pages", () => {
  it("marks a page planned until it is written", () => {
    expect([p1, p2, p3, p4].map(pageStatus)).toEqual(["current", "stale", "planned", "stale"]);
  });
  it("calls a page stale when a source changed or is gone, even if the model's flag is false", () => {
    expect(p2.page!.stale).toBe(false);
    expect(isStale(p2.page!)).toBe(true);
    expect(isStale(p4.page!)).toBe(true);
    expect(isStale(p1.page!)).toBe(false);
    expect(isStale({ stale: true, sources: [] })).toBe(true);
  });
  it("names a source's state", () => {
    expect([{ current: true, missing: false }, { current: false, missing: false }, { current: true, missing: true }, { current: false, missing: true }].map(sourceState))
      .toEqual(["current", "changed", "removed", "removed"]);
  });
  it("counts the pages and finds where a cited note is used", () => {
    expect(pageCounts(agentModel.notes)).toEqual({ pages: 4, written: 3, planned: 1, stale: 2 });
    expect(citedOn(aix, s1).map((n) => n.id)).toEqual([p1.id, p2.id]);
    expect(citedOn(aix, s2).map((n) => n.id)).toEqual([p1.id, p3.id]);
    expect(citedOn(aix, s3).map((n) => n.id)).toEqual([p4.id]);
  });
});

describe("citations", () => {
  it("rewrites [^k] for each source the page has", () => {
    expect(citeLinks("A.[^1] B.[^2][^1]", 2)).toBe("A.[1](wikicite:1) B.[2](wikicite:2)[1](wikicite:1)");
  });
  it("leaves a marker with no such source, and code, as written", () => {
    expect(citeLinks("x[^3] y[^0]", 2)).toBe("x[^3] y[^0]");
    expect(citeLinks("use `[^1]` here\n\n```\n[^1]\n```\n~~~\n[^2]\n~~~\nthen [^1]", 2)).toBe("use `[^1]` here\n\n```\n[^1]\n```\n~~~\n[^2]\n~~~\nthen [1](wikicite:1)");
    expect(citeLinks(p1.body, p1.page!.sources.length)).toContain("`[^1]` in code.[^9]");
  });
  it("reads a rewritten link back to its source number", () => {
    expect(citeIndex("wikicite:12")).toBe(12);
    for (const href of [undefined, "", "wikilink:Alpha", "wikicite:", "wikicite:x", "https://a.b"]) expect(citeIndex(href)).toBeNull();
    expect(CITE_PREFIX).toBe("wikicite:");
  });
});

describe("build", () => {
  const plan = (calls: { outline: number; place: number; pages: number | null }) => ({ calls });
  it("says what a dry run would call", () => {
    expect(callsText(plan({ outline: 1, place: 0, pages: null }))).toBe("an outline call and then one call per page (how many is not known until the outline has planned them)");
    expect(callsText(plan({ outline: 0, place: 1, pages: 3 }))).toBe("a placement call and 3 page calls known so far");
    expect(callsText(plan({ outline: 1, place: 1, pages: 1 }))).toBe("an outline call, a placement call and 1 page call known so far");
    expect(callsText(plan({ outline: 0, place: 0, pages: 4 }))).toBe("4 page calls");
    expect(callsText(plan({ outline: 0, place: 0, pages: 0 }))).toBe("no model calls, since every page is up to date");
    expect(usd(5)).toBe("$5.00");
  });

  it("says when a plan lists only the page calls known before the outline or placement call", () => {
    expect(callsNote(plan({ outline: 1, place: 0, pages: null }))).toMatch(/counted once it has run/);
    expect(callsNote(plan({ outline: 0, place: 1, pages: 3 }))).toBe("Placing new notes can add page calls beyond these.");
    expect(callsNote(plan({ outline: 0, place: 1, pages: 0 }))).toMatch(/can add page calls/);
    expect(callsNote(plan({ outline: 1, place: 0, pages: 8 }))).toMatch(/can change/);
    expect(callsNote(plan({ outline: 0, place: 0, pages: 4 }))).toBeNull();
  });

  it("blocks a build while Claude Code is hidden", () => {
    expect(buildBlocked(true)).toBeNull();
    expect(buildBlocked(false)).toBe("Claude Code is hidden in Settings. Show it again to build the wiki.");
  });

  it("puts the edition and scope in the route, and leaves the defaults out", () => {
    expect(wikiRoute("demo")).toEqual({ page: "wiki", domain: "demo" });
    expect(JSON.stringify(wikiRoute("demo", { at: "p-core" }))).toBe('{"page":"wiki","domain":"demo","at":"p-core"}');
    expect(JSON.stringify(wikiRoute("demo", { at: "", agent: true }))).toBe('{"page":"wiki","domain":"demo","edition":"agent"}');
    expect(JSON.stringify(wikiRoute("demo", { at: "n-pg0a1b2c", agent: true, project: "core" }))).toBe('{"page":"wiki","domain":"demo","at":"n-pg0a1b2c","edition":"agent","project":"core"}');
    // The scope belongs to the agent edition only.
    expect(JSON.stringify(wikiRoute("demo", { project: "core" }))).toBe('{"page":"wiki","domain":"demo"}');
  });

  it("follows the progress lines", () => {
    const tag = { domain: "demo", scope: "domain" };
    let p = applyProgress(null, { ...tag, event: "start", calls: null });
    expect(p).toEqual({ done: 0, total: null, cost: 0, title: null });
    p = applyProgress(p, { ...tag, event: "call", kind: "outline", page: null, title: null, ok: true, done: 1, total: 5, cost_usd: 0.1 });
    expect(p).toEqual({ done: 1, total: 5, cost: 0.1, title: null });
    p = applyProgress(p, { ...tag, event: "call", kind: "page", page: "pg000001", title: "Overview", ok: true, done: 2, total: null, cost_usd: 0.3 });
    expect(p).toEqual({ done: 2, total: 5, cost: 0.3, title: "Overview" });
    expect(applyProgress(p, { ...tag, event: "end", ok: true, stopped: null, cost_usd: 0.35 })).toEqual({ done: 2, total: 5, cost: 0.35, title: "Overview" });
    expect(applyProgress(null, { ...tag, event: "end", ok: false, stopped: "error", cost_usd: 0 })).toBeNull();
  });

  it("reports how a build ended", () => {
    const result = (over: Partial<WikiBuildResult> = {}): WikiBuildResult => ({
      ok: true, domain: "demo", scope: "domain", model: "sonnet", calls: { outline: 1, place: 0, pages: 2 },
      written: ["pg000001", "pg000002"], failed: [], pending: [], stopped: null, cost_usd: 1.234, budget_usd: 5, path: "x.json", ...over,
    });
    expect(buildOutcome({ ok: true, result: result() }, false)).toEqual({ text: "Wiki build finished: 2 pages written for $1.23.", kind: "info" });
    expect(buildOutcome({ ok: true, result: result({ stopped: "budget", pending: ["pg000003"], written: ["pg000001"] }) }, false))
      .toEqual({ text: "Wiki build stopped at its budget: 1 page written for $1.23, 1 left. Refresh continues from there.", kind: "warn" });
    expect(buildOutcome({ ok: true, result: result({ failed: [{ page: "pg000002", reason: "bad" }], written: ["pg000001"] }) }, false).kind).toBe("warn");
    expect(buildOutcome({ ok: false, error: "claude is not signed in" }, false)).toEqual({ text: "Wiki build failed: claude is not signed in", kind: "error" });
    expect(buildOutcome({ ok: false, error: "Build cancelled." }, true).kind).toBe("info");
  });
});
