// Suggest existing notes that probably belong to a project, and tag them (through LM's update) on request.
import { classify } from "../../lib/errors";
import { LmError, meta, update } from "../../lib/lm";
import type { DomainInfo, LinkGraph, NoteRow, Project } from "../../lib/lm";

export interface Suggestion {
  ref: string; title: string; type: NoteRow["type"]; domain: string;
  score: number; level: "likely" | "maybe"; reasons: string[]; otherProjects: string[];
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, "").toLowerCase();
const isAbsolute = (p: string) => /^[a-z]:[\\/]/i.test(p) || /^[\\/]/.test(p);

/** True when `path` is `root` or lies beneath it (whole path segments, `\` = `/`, case-insensitive). */
export function isUnder(path: string, root: string): boolean {
  const p = norm(path), r = norm(root);
  if (!r) return false;
  return p === r || p.startsWith(r + "/");
}

/** Absolute candidates for a note's `files` entry: itself when absolute, else joined to each bound folder. */
export function resolveNoteFile(entry: string, prefixes: string[]): string[] {
  if (isAbsolute(entry)) return [entry];
  const rel = entry.replace(/^\.?[\\/]+/, "");
  return prefixes.map((prefix) => `${prefix.replace(/[\\/]+$/, "")}/${rel}`);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (project: Project) => [...new Set([project.name, project.slug, ...project.aliases].map((n) => n.trim()).filter(Boolean))];

function titleMatch(title: string, project: Project): string | null {
  for (const name of names(project)) {
    if (new RegExp(`^${escape(name)}(?:$|[:\\-–( ]|'s)`, "i").test(title.trim())) return name;
  }
  return null;
}

function mentions(text: string, project: Project): boolean {
  return names(project).some((name) => new RegExp(`(?<!\\w)${escape(name)}(?!\\w)`, "i").test(text));
}

const repoName = (repo: string) => repo.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || repo;

export function suggestTriage(input: {
  project: Project; rows: NoteRow[]; domains: DomainInfo[]; graph?: LinkGraph; hits?: Set<string>;
}): Suggestion[] {
  const { project, rows, domains, graph, hits } = input;
  const neighbours = new Map<string, Set<string>>();
  const tagged = new Set<string>();
  if (graph) {
    for (const n of graph.nodes) if (n.tags.includes(project.tag)) tagged.add(n.ref);
    for (const e of graph.edges) {
      (neighbours.get(e.from) ?? neighbours.set(e.from, new Set()).get(e.from)!).add(e.to);
      (neighbours.get(e.to) ?? neighbours.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
  }
  const out: Suggestion[] = [];
  for (const row of rows) {
    if (row.tags.includes(project.tag) || row.status === "archived" || row.status === "superseded") continue;
    const prefixes = domains.find((d) => d.name === row.domain)?.prefixes ?? [];
    let score = 0;
    const reasons: string[] = [];

    const repo = project.repos.find((r) =>
      (row.files ?? []).some((f) => resolveNoteFile(f, prefixes).some((abs) => isUnder(abs, r))));
    if (repo) { score += 3; reasons.push(`Files under ${repoName(repo)}`); }

    if (prefixes.length && prefixes.every((p) => project.repos.some((r) => isUnder(p, r)))) {
      score += 3; reasons.push(`Domain ${row.domain} is bound to the project's repo`);
    }

    const titled = titleMatch(row.title, project);
    if (titled) { score += 3; reasons.push(`Title starts with "${titled}"`); }
    else if (row.summary && mentions(row.summary, project)) { score += 1; reasons.push("Summary mentions the project"); }

    const linked = [...(neighbours.get(row.ref) ?? [])].filter((r) => tagged.has(r)).length;
    if (linked) { score += Math.min(linked, 2); reasons.push(`Linked to ${linked} note${linked > 1 ? "s" : ""} in the project`); }

    if (hits?.has(row.ref)) { score += 1; reasons.push("Matches a search for the project"); }

    if (score < 1) continue;
    out.push({
      ref: row.ref, title: row.title, type: row.type, domain: row.domain, score,
      level: score >= 3 ? "likely" : "maybe", reasons,
      otherProjects: row.tags.filter((t) => t.startsWith("project/") && t !== project.tag).map((t) => t.slice(8)),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export const withProjectTag = (tags: string[], tag: string): string[] => [...new Set([...tags, tag])].sort();

export type AssignResult = { ref: string; ok: true; operation_id?: string } | { ref: string; ok: false; error: string };
interface AssignDeps {
  update: (ref: string, payload: { tags: string[]; expected_revision: string }) => Promise<{ operation_id?: string }>;
  meta: (ref: string) => Promise<{ tags: string[]; revision: string }>;
}

/** Add the project tag to each note, one at a time; a stale revision is re-read and retried once. */
export async function assignToProject(
  rows: Pick<NoteRow, "ref" | "title" | "tags" | "revision">[], tag: string,
  deps: AssignDeps = { update, meta },
): Promise<AssignResult[]> {
  const results: AssignResult[] = [];
  for (const row of rows) {
    try {
      let res;
      try {
        res = await deps.update(row.ref, { tags: withProjectTag(row.tags, tag), expected_revision: row.revision });
      } catch (e) {
        if (!(e instanceof LmError && e.stale)) throw e;
        const fresh = await deps.meta(row.ref);
        res = await deps.update(row.ref, { tags: withProjectTag(fresh.tags, tag), expected_revision: fresh.revision });
      }
      results.push({ ref: row.ref, ok: true, operation_id: res?.operation_id });
    } catch (e) {
      results.push({ ref: row.ref, ok: false, error: classify(e).message });
    }
  }
  return results;
}

const key = (slug: string) => `hivemind.triage.dismissed.${slug}`;

export function dismissed(slug: string): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key(slug));
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((r): r is string => typeof r === "string") : []);
  } catch { return new Set(); }
}

export function dismiss(slug: string, ref: string): void {
  try {
    const next = dismissed(slug);
    next.add(ref);
    globalThis.localStorage?.setItem(key(slug), JSON.stringify([...next]));
  } catch { /* storage unavailable: the suggestion simply reappears */ }
}
