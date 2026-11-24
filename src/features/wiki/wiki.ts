// The domain wiki, as pure functions over the model Living Memory returns (`wiki --format json`): which page an address
// names, its breadcrumbs, previous and next pages, groupings, search and [[link]] resolution. The addresses are the
// same as the exported file's hash names: "" (main page), p-<slug>, s-<slug>-<section>, c-<id>, n-<ref>, az, recent.
// The agent-written edition has the same model shape (sections a1.., one article per page, its cited notes in the hidden
// `sources` section), so the same addresses work; the helpers at the end are specific to it.
import type { Project, WikiFolder, WikiModel, WikiNote, WikiPageInfo, WikiPageSource, WikiProject, WikiSection } from "../../lib/lm";
import type { WikiBuildDone, WikiBuildEvent, WikiBuildPlan } from "../../lib/wiki";
import type { Route } from "../../store";
import { domainOf } from "../executive/items";

/** The route of a wiki page, in Notes. The edition lives in the route with the address, so Back returns to the edition a page was
 *  in; a route without it is the structured edition. `whole` is the wiki of the whole domain (the project list's first row); with a
 *  project picked the wiki is that project's. Defaults are left out and the key order is fixed, because routes are compared as text. */
export function wikiRoute(domain: string | undefined, o: { at?: string; agent?: boolean; whole?: boolean } = {}): Route {
  return { page: "notes", view: "wiki", domain, at: o.at || undefined, ...(o.agent ? { edition: "agent" as const } : {}), ...(o.whole ? { whole: true as const } : {}) };
}

/** The rows of the project list: each registered project that is not archived, with its note count when the wiki loaded is the one of its
 *  own domain (its charter's, else `fallback`). A project with no notes there has none of its own pages, which reads as 0. */
export function projectRows(projects: Pick<Project, "slug" | "name" | "charter" | "status">[], loaded: Pick<WikiModel, "domain" | "projects"> | undefined, fallback: string): { slug: string; name: string; count?: number }[] {
  return projects.filter((p) => p.status !== "archived").map((p) => ({
    slug: p.slug, name: p.name,
    ...(loaded && loaded.domain === domainOf(p as Project, fallback) ? { count: loaded.projects.find((x) => x.slug === p.slug)?.count ?? 0 } : {}),
  }));
}

export interface WikiIndex {
  model: WikiModel;
  notes: Map<string, WikiNote>;
  refs: Map<string, WikiNote>;
  /** By casefolded title; an active note wins over a retired one with the same title. */
  titles: Map<string, WikiNote>;
  projects: Map<string, WikiProject>;
  folders: Map<string, WikiFolder>;
  sections: Map<string, WikiSection>;
  /** Notes in other domains, by the model's Python casefold key (Straße is strasse) and by lowercased title, which is how links are looked up. */
  external: Map<string, { title: string; domain: string }>;
}

export function indexModel(model: WikiModel): WikiIndex {
  const titles = new Map<string, WikiNote>();
  for (const n of model.notes) {
    const key = n.title.trim().toLowerCase(), have = titles.get(key);
    // A page of the agent edition wins over a cited note with the same title.
    if (!have || (have.retired && !n.retired) || (have.section === SOURCES && n.section !== SOURCES)) titles.set(key, n);
  }
  return {
    model, titles,
    notes: new Map(model.notes.map((n) => [n.id, n])),
    refs: new Map(model.notes.map((n) => [n.ref, n])),
    projects: new Map(model.projects.map((p) => [p.slug, p])),
    folders: new Map(model.folders.map((f) => [f.id, f])),
    sections: new Map(model.sections.map((s) => [s.key, s])),
    external: new Map(Object.entries(model.external).flatMap(([key, x]) => [[key, x], [x.title.trim().toLowerCase(), x]] as const)),
  };
}

export const noteAt = (n: Pick<WikiNote, "ref">) => `n-${n.ref}`;
export const projectAt = (slug: string) => `p-${slug}`;
export const sectionAt = (slug: string, key: string) => `s-${slug}-${key}`;

export type WikiView =
  | { kind: "main" }
  | { kind: "project"; project: WikiProject }
  | { kind: "section"; project: WikiProject; section: WikiSection }
  | { kind: "folder"; folder: WikiFolder }
  | { kind: "note"; note: WikiNote }
  | { kind: "az" }
  | { kind: "recent" }
  | { kind: "missing"; at: string };

/** The page an address names. An unknown address is `missing`. */
export function resolvePage(ix: WikiIndex, at: string | undefined): WikiView {
  const h = at ?? "";
  if (!h) return { kind: "main" };
  if (h === "az") return { kind: "az" };
  if (h === "recent") return { kind: "recent" };
  if (h.startsWith("n-")) { const note = ix.refs.get(h.slice(2)); if (note) return { kind: "note", note }; }
  if (h.startsWith("p-")) { const project = ix.projects.get(h.slice(2)); if (project) return { kind: "project", project }; }
  if (h.startsWith("s-")) {
    for (const project of ix.projects.values()) {
      const prefix = `s-${project.slug}-`;
      const section = h.startsWith(prefix) && project.sections[h.slice(prefix.length)] ? ix.sections.get(h.slice(prefix.length)) : undefined;
      if (section) return { kind: "section", project, section };
    }
  }
  const folder = ix.folders.get(h);
  return folder ? { kind: "folder", folder } : { kind: "missing", at: h };
}

/** A folder and its parents, outermost first. */
export function folderChain(ix: WikiIndex, folder: WikiFolder | undefined): WikiFolder[] {
  const chain: WikiFolder[] = [];
  for (let f = folder; f; f = f.parent ? ix.folders.get(f.parent) : undefined) chain.unshift(f);
  return chain;
}

/** A note in the code reference tree sits in a folder; every other note sits in its section. */
export const isCode = (ix: WikiIndex, n: WikiNote) => n.section === "code" && !!n.folder && ix.folders.has(n.folder);

/** A file note is titled "path/to/file: what it is". The page shows the description as its title and the path above it. */
export function pathPrefix(n: Pick<WikiNote, "title" | "files">): string {
  const i = n.title.indexOf(": ");
  return n.files.length && i > 0 && n.title.slice(0, i).includes("/") ? n.title.slice(0, i) : "";
}
export function shortTitle(n: Pick<WikiNote, "title" | "files">): string {
  const p = pathPrefix(n);
  return p ? n.title.slice(p.length + 2) : n.title;
}

export interface Crumb { label: string; at: string }

/** Wiki > project > section > folders > page; the last crumb is the page itself. */
export function crumbs(ix: WikiIndex, view: WikiView): Crumb[] {
  const root: Crumb = { label: "Wiki", at: "" };
  // The agent edition has one project, which is the wiki itself.
  const inProject = (p: WikiProject): Crumb[] => (isAgent(ix.model) ? [root] : [root, { label: p.name, at: projectAt(p.slug) }]);
  const inSection = (p: WikiProject, key: string): Crumb[] => [...inProject(p), { label: ix.sections.get(key)?.label ?? key, at: sectionAt(p.slug, key) }];
  const inFolders = (p: WikiProject, f: WikiFolder): Crumb[] => [...inSection(p, "code"), ...folderChain(ix, f).map((x) => ({ label: x.name, at: x.id }))];
  switch (view.kind) {
    case "main": return [root];
    case "project": return inProject(view.project);
    case "section": return inSection(view.project, view.section.key);
    case "folder": { const p = ix.projects.get(view.folder.project); return p ? inFolders(p, view.folder) : [root]; }
    case "az": return [root, { label: "A to Z index", at: "az" }];
    case "recent": return [root, { label: "Recent changes", at: "recent" }];
    case "missing": return [root];
    case "note": {
      const n = view.note, p = ix.projects.get(n.project);
      if (!p) return [root];
      const page = { label: isCode(ix, n) && n.filename ? n.filename : shortTitle(n), at: noteAt(n) };
      if (isSource(n)) return [root, page];
      return [...(isCode(ix, n) ? inFolders(p, ix.folders.get(n.folder!)!) : inSection(p, n.section)), page];
    }
  }
}

/** The notes of one section of a project, in the model's order. */
export function sectionNotes(ix: WikiIndex, p: WikiProject, key: string): WikiNote[] {
  return (p.sections[key]?.notes ?? []).map((id) => ix.notes.get(id)).filter((n): n is WikiNote => !!n);
}

/** The pages a note's previous and next links walk: its code folder, else its section. */
export function siblings(ix: WikiIndex, n: WikiNote): WikiNote[] {
  if (isCode(ix, n)) return ix.folders.get(n.folder!)!.notes.map((id) => ix.notes.get(id)).filter((m): m is WikiNote => !!m && m.section === "code");
  const p = ix.projects.get(n.project);
  return p ? sectionNotes(ix, p, n.section) : [];
}

/** The note before and after this one among its siblings. */
export function neighbours(ix: WikiIndex, n: WikiNote): { prev?: WikiNote; next?: WikiNote } {
  const sib = siblings(ix, n), i = sib.findIndex((m) => m.id === n.id);
  return i < 0 ? {} : { prev: sib[i - 1], next: sib[i + 1] };
}

/** Sections whose notes are listed newest first, grouped by month. */
export const CHRONO = new Set(["decisions", "plans", "issues", "research"]);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "November 2026" for "2026-11-17"; "Undated" when there is no date. */
export function monthLabel(date: string | undefined): string {
  const m = /^(\d{4})-(\d{2})/.exec(date ?? "");
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : "Undated";
}

/** Consecutive notes with the same month together, in the order given. */
export function monthGroups(notes: WikiNote[]): { label: string; notes: WikiNote[] }[] {
  const groups: { label: string; notes: WikiNote[] }[] = [];
  for (const n of notes) {
    const label = monthLabel(n.updated), last = groups[groups.length - 1];
    if (last?.label === label) last.notes.push(n); else groups.push({ label, notes: [n] });
  }
  return groups;
}

/** Newest first; notes with the same date keep their order. */
export const byUpdated = (notes: WikiNote[]) => notes.slice().sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));

/** Every note by its short title, in letter groups ("#" for a title that starts with something else). */
export function azGroups(notes: WikiNote[]): { letter: string; notes: WikiNote[] }[] {
  const sorted = notes.slice().sort((a, b) => shortTitle(a).localeCompare(shortTitle(b), undefined, { sensitivity: "base" }));
  const groups: { letter: string; notes: WikiNote[] }[] = [];
  for (const n of sorted) {
    let letter = shortTitle(n).charAt(0).toUpperCase();
    if (!/[A-Z]/.test(letter)) letter = "#";
    const g = groups.find((x) => x.letter === letter);
    if (g) g.notes.push(n); else groups.push({ letter, notes: [n] });
  }
  return groups;
}

/** The most recently updated notes grouped by day. */
export function dayGroups(notes: WikiNote[], limit = 80): { day: string; notes: WikiNote[] }[] {
  const groups: { day: string; notes: WikiNote[] }[] = [];
  for (const n of byUpdated(notes).slice(0, limit)) {
    const last = groups[groups.length - 1];
    if (last?.day === n.updated) last.notes.push(n); else groups.push({ day: n.updated, notes: [n] });
  }
  return groups;
}

/** Notes that contain the text, best first: title, then tags, then lead, then body; ties newest first. */
export function searchNotes(notes: WikiNote[], query: string): WikiNote[] {
  const k = query.trim().toLowerCase();
  if (!k) return [];
  const rank = (n: WikiNote) => n.title.toLowerCase().includes(k) ? 4 : n.tags.join(" ").toLowerCase().includes(k) ? 3 : n.lead.toLowerCase().includes(k) ? 2 : n.body.toLowerCase().includes(k) ? 1 : 0;
  const order = new Map(byUpdated(notes).map((n, i) => [n.id, i]));
  return notes.map((n) => ({ n, score: rank(n) })).filter((h) => h.score)
    .sort((a, b) => b.score - a.score || order.get(a.n.id)! - order.get(b.n.id)!).map((h) => h.n);
}

export type LinkTarget =
  | { kind: "note"; note: WikiNote }
  | { kind: "external"; domain: string }
  | { kind: "unresolved" };

/** Where a [[title]] points: a page in this wiki, a note in another domain, or nothing. */
export function resolveLink(ix: WikiIndex, target: string): LinkTarget {
  const key = target.trim().toLowerCase();
  const note = ix.titles.get(key);
  if (note) return { kind: "note", note };
  const external = ix.external.get(key);
  return external ? { kind: "external", domain: external.domain } : { kind: "unresolved" };
}

/** The tree rows to highlight for a page, best first: the page itself when the tree lists it, else its nearest listed ancestor. */
export function treeKeys(ix: WikiIndex, view: WikiView): string[] {
  if (isAgent(ix.model)) {
    switch (view.kind) {
      case "section": return [sectionAt(view.project.slug, view.section.key)];
      case "note": return isSource(view.note) ? [] : [noteAt(view.note), sectionAt(view.note.project, view.note.section)];
      case "main": case "project": return [""];
      default: return [];
    }
  }
  const rootOf = (f: WikiFolder) => { while (f.parent && ix.folders.has(f.parent)) f = ix.folders.get(f.parent)!; return f; };
  switch (view.kind) {
    case "main": return [""];
    case "project": return [projectAt(view.project.slug)];
    case "section": return [sectionAt(view.project.slug, view.section.key), projectAt(view.project.slug)];
    case "folder": return [view.folder.id, rootOf(view.folder).id, sectionAt(view.folder.project, "code"), projectAt(view.folder.project)];
    case "az": return ["az"];
    case "recent": return ["recent"];
    case "missing": return [];
    case "note": {
      const n = view.note, section = sectionAt(n.project, n.section);
      return [...(isCode(ix, n) ? [rootOf(ix.folders.get(n.folder!)!).id] : []), section, projectAt(n.project)];
    }
  }
}

/** Which tree branches a page lies in: its project, and the code branch when it is a code page. */
export function treeOpen(ix: WikiIndex, view: WikiView): { project?: string; code?: boolean } {
  switch (view.kind) {
    case "project": return { project: view.project.slug };
    case "section": return { project: view.project.slug, code: view.section.key === "code" };
    case "folder": return { project: view.folder.project, code: true };
    case "note": return { project: view.note.project, code: isCode(ix, view.note) };
    default: return {};
  }
}

export type TreeIcon = "home" | "box" | "list" | "clock";
export type TreeRow =
  | { kind: "label"; label: string }
  | { kind: "row"; at: string; label: string; depth: 0 | 1 | 2; icon?: TreeIcon; count?: number; /** An agent page that is not written yet, or whose sources changed. */ flag?: "planned" | "stale"; /** Key in the open-branches map; set when the row has children. */ branch?: string; expanded?: boolean };

/** The page tree, flattened: main page, each project with its sections (and root code folders), then the browse pages.
 *  `open` says which branches show their children: `p-<slug>` for a project, `code-<slug>` for its code reference. */
export function treeRows(ix: WikiIndex, open: Record<string, boolean>): TreeRow[] {
  if (isAgent(ix.model)) return agentTreeRows(ix);
  const rows: TreeRow[] = [{ kind: "row", at: "", label: "Main page", depth: 0, icon: "home" }];
  if (ix.model.projects.length) rows.push({ kind: "label", label: "Projects" });
  for (const p of ix.model.projects) {
    const pk = `p-${p.slug}`;
    rows.push({ kind: "row", at: projectAt(p.slug), label: p.name, depth: 0, icon: "box", branch: pk, expanded: !!open[pk] });
    if (!open[pk]) continue;
    for (const s of ix.model.sections) {
      const x = p.sections[s.key];
      if (!x) continue;
      if (s.key !== "code") { rows.push({ kind: "row", at: sectionAt(p.slug, s.key), label: s.label, depth: 1, count: x.count }); continue; }
      const ck = `code-${p.slug}`;
      rows.push({ kind: "row", at: sectionAt(p.slug, "code"), label: s.label, depth: 1, count: x.count, branch: ck, expanded: !!open[ck] });
      if (open[ck]) for (const id of x.folders ?? []) { const f = ix.folders.get(id); if (f) rows.push({ kind: "row", at: f.id, label: f.name, depth: 2, count: f.count }); }
    }
  }
  rows.push({ kind: "label", label: "Browse" }, { kind: "row", at: "az", label: "A to Z index", depth: 0, icon: "list" }, { kind: "row", at: "recent", label: "Recent changes", depth: 0, icon: "clock" });
  return rows;
}

// ---- The agent-written edition ----

/** The hidden section that holds the notes pages cite; it is never listed or browsed. */
export const SOURCES = "sources";
export const isAgent = (model: Pick<WikiModel, "edition">) => model.edition === "agent";
/** A note cited as a source, not a page of the agent edition. */
export const isSource = (n: Pick<WikiNote, "section">) => n.section === SOURCES;

export type PageStatus = "planned" | "stale" | "current";
export type SourceState = "current" | "changed" | "removed";

/** A source gone from the store is removed; one whose revision moved on since the page was written is changed. */
export const sourceState = (s: Pick<WikiPageSource, "current" | "missing">): SourceState => (s.missing ? "removed" : s.current ? "current" : "changed");
/** Stale when the model says so or any source changed or is gone (the model's own rule, so an older flag cannot hide it). */
export const isStale = (info: Pick<WikiPageInfo, "stale" | "sources">) => info.stale || info.sources.some((s) => sourceState(s) !== "current");
export function pageStatus(n: Pick<WikiNote, "page">): PageStatus {
  const info = n.page;
  return !info || !info.written ? "planned" : isStale(info) ? "stale" : "current";
}

/** The agent's sections with their pages, in outline order. */
export function agentSections(ix: WikiIndex): { section: WikiSection; pages: WikiNote[] }[] {
  const p = ix.model.projects[0];
  return p ? ix.model.sections.filter((s) => p.sections[s.key]).map((section) => ({ section, pages: sectionNotes(ix, p, section.key) })) : [];
}

/** The agent edition's page tree: the contents page, then each section with its pages. */
export function agentTreeRows(ix: WikiIndex): TreeRow[] {
  const rows: TreeRow[] = [{ kind: "row", at: "", label: "Contents", depth: 0, icon: "home" }];
  const slug = ix.model.projects[0]?.slug ?? "wiki";
  for (const { section, pages } of agentSections(ix)) {
    rows.push({ kind: "row", at: sectionAt(slug, section.key), label: section.label, depth: 0, count: pages.length });
    for (const n of pages) {
      const status = pageStatus(n);
      rows.push({ kind: "row", at: noteAt(n), label: n.title, depth: 1, ...(status === "current" ? {} : { flag: status }) });
    }
  }
  return rows;
}

/** How many pages there are, written, still planned, and written but stale. */
export function pageCounts(notes: WikiNote[]): { pages: number; written: number; planned: number; stale: number } {
  const status = notes.filter((n) => n.page).map(pageStatus);
  return { pages: status.length, written: status.filter((s) => s !== "planned").length, planned: status.filter((s) => s === "planned").length, stale: status.filter((s) => s === "stale").length };
}

/** The pages that cite a note, in the wiki's order. */
export function citedOn(ix: WikiIndex, n: Pick<WikiNote, "id">): WikiNote[] {
  return agentSections(ix).flatMap((s) => s.pages).filter((page) => page.page?.sources.some((s) => s.id === n.id));
}

export const CITE_PREFIX = "wikicite:";
/** Which source a marker rewritten by `citeLinks` names (1-based), or null for any other address. */
export function citeIndex(href: string | undefined): number | null {
  const m = href?.startsWith(CITE_PREFIX) ? /^\d+$/.exec(href.slice(CITE_PREFIX.length)) : null;
  return m ? +m[0] : null;
}
/** The body with each `[^k]` that names one of `count` sources rewritten as a link the renderer shows as a superscript.
 *  Code spans and fenced code stay as written, and a marker with no such source stays plain text. */
export function citeLinks(body: string, count: number): string {
  return body.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)|\[\^(\d+)\]/g, (all, code: string | undefined, k: string | undefined) =>
    code || !k || +k < 1 || +k > count ? all : `[${k}](${CITE_PREFIX}${k})`);
}

/** Dollars as "$1.23". */
export const usd = (n: number) => `$${n.toFixed(2)}`;

/** The calls a dry run would make, in words. The page calls are null on a first build, whose outline call plans the pages. With an
 *  outline or placement call in the plan the page count is only what is known before it: those calls can add pages. */
export function callsText({ calls }: Pick<WikiBuildPlan, "calls">): string {
  const parts = [calls.outline && "an outline call", calls.place && "a placement call"].filter((p): p is string => !!p);
  if (calls.pages === null) parts.push("then one call per page (how many is not known until the outline has planned them)");
  else if (calls.pages) parts.push(`${calls.pages} page call${calls.pages === 1 ? "" : "s"}${parts.length ? " known so far" : ""}`);
  if (!parts.length) return "no model calls, since every page is up to date";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Why the page calls of a plan can be more than it lists, or null when the plan is complete (no outline or placement call). */
export function callsNote({ calls }: Pick<WikiBuildPlan, "calls">): string | null {
  if (calls.pages === null) return "The outline call decides the pages, so the page calls are counted once it has run.";
  if (calls.place) return "Placing new notes can add page calls beyond these.";
  if (calls.outline) return "The outline call plans the pages again, so the page calls can change.";
  return null;
}

/** Why a build cannot start, or null. A build runs on Claude Code, so it is off while the user keeps that engine hidden. */
export const buildBlocked = (claudeShown: boolean): string | null => (claudeShown ? null : "Claude Code is hidden in Settings. Show it again to build the wiki.");

export interface BuildProgress { done: number; total: number | null; cost: number; title: string | null }
/** The progress after one more line of the build's progress; the total stays at the last one known. */
export function applyProgress(p: BuildProgress | null, e: WikiBuildEvent): BuildProgress | null {
  switch (e.event) {
    case "start": return { done: 0, total: e.calls, cost: 0, title: null };
    case "call": return { done: e.done, total: e.total ?? p?.total ?? null, cost: e.cost_usd, title: e.title };
    case "end": return p && { ...p, cost: e.cost_usd };
  }
}

/** What to tell the user when a build is over. `cancelled` is true when the user asked it to stop. */
export function buildOutcome(done: Pick<WikiBuildDone, "ok" | "result" | "error">, cancelled: boolean): { text: string; kind: "info" | "warn" | "error" } {
  const r = done.result;
  // A build that finished before the cancel reached it reads as finished (Codex review of 99ceaea, W3).
  const finished = done.ok && r && r.stopped === null && !r.pending.length && !r.failed.length;
  if (cancelled && !finished) return { text: "Wiki build cancelled. The pages already written are kept.", kind: "info" };
  if (!done.ok || !r) return { text: `Wiki build failed: ${done.error ?? "unknown error"}`, kind: "error" };
  const pages = `${r.written.length} page${r.written.length === 1 ? "" : "s"} written for ${usd(r.cost_usd)}`;
  if (r.stopped === "budget") return { text: `Wiki build stopped at its budget: ${pages}, ${r.pending.length} left. Refresh continues from there.`, kind: "warn" };
  if (r.stopped === "error" || r.failed.length) return { text: `Wiki build had problems: ${pages}, ${r.failed.length} failed, ${r.pending.length} left.`, kind: "warn" };
  return { text: `Wiki build finished: ${pages}.`, kind: "info" };
}
