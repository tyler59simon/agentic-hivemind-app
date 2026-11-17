// The domain wiki, as pure functions over the model Living Memory returns (`wiki --format json`): which page an address
// names, its breadcrumbs, previous and next pages, groupings, search and [[link]] resolution. The addresses are the
// same as the exported file's hash names: "" (main page), p-<slug>, s-<slug>-<section>, c-<id>, n-<ref>, az, recent.
import type { WikiFolder, WikiModel, WikiNote, WikiProject, WikiSection } from "../../lib/lm";

export interface WikiIndex {
  model: WikiModel;
  notes: Map<string, WikiNote>;
  refs: Map<string, WikiNote>;
  /** By casefolded title; an active note wins over a retired one with the same title. */
  titles: Map<string, WikiNote>;
  projects: Map<string, WikiProject>;
  folders: Map<string, WikiFolder>;
  sections: Map<string, WikiSection>;
  /** Notes in other domains, keyed like `titles`. The model's own keys are Python casefold (Straße is strasse), which lowercasing does not match. */
  external: Map<string, { title: string; domain: string }>;
}

export function indexModel(model: WikiModel): WikiIndex {
  const titles = new Map<string, WikiNote>();
  for (const n of model.notes) {
    const key = n.title.trim().toLowerCase(), have = titles.get(key);
    if (!have || (have.retired && !n.retired)) titles.set(key, n);
  }
  return {
    model, titles,
    notes: new Map(model.notes.map((n) => [n.id, n])),
    refs: new Map(model.notes.map((n) => [n.ref, n])),
    projects: new Map(model.projects.map((p) => [p.slug, p])),
    folders: new Map(model.folders.map((f) => [f.id, f])),
    sections: new Map(model.sections.map((s) => [s.key, s])),
    external: new Map(Object.values(model.external).map((x) => [x.title.trim().toLowerCase(), x])),
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
  const inProject = (p: WikiProject): Crumb[] => [root, { label: p.name, at: projectAt(p.slug) }];
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
  | { kind: "row"; at: string; label: string; depth: 0 | 1 | 2; icon?: TreeIcon; count?: number; /** Key in the open-branches map; set when the row has children. */ branch?: string; expanded?: boolean };

/** The page tree, flattened: main page, each project with its sections (and root code folders), then the browse pages.
 *  `open` says which branches show their children: `p-<slug>` for a project, `code-<slug>` for its code reference. */
export function treeRows(ix: WikiIndex, open: Record<string, boolean>): TreeRow[] {
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
