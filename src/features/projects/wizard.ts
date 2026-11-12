// Pure helpers for the project create/edit wizard; the limits mirror Living Memory's `project-plan` validation.
import type { DomainInfo, Project, ProjectStatus, ProjectUpdate } from "../../lib/lm";
import { HEADINGS } from "../../lib/note";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_REPOS = 10;
export const MAX_ALIASES = 5;
export const MAX_ALIAS_LEN = 40;
export const MAX_NAME = 80;
export const MAX_DESCRIPTION = 500;

/** A slug from a project name: lowercase letters and digits joined by single dashes, at most 40 characters. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/;
const forward = (p: string) => p.replace(/\\/g, "/");

/** One path per line. Relative paths come back in `invalid`; duplicates (case-insensitive) are dropped. */
export function parseRepos(text: string): { repos: string[]; invalid: string[] } {
  const repos: string[] = [], invalid: string[] = [], seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!ABSOLUTE.test(line)) { invalid.push(line); continue; }
    const path = forward(line);
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push(path);
  }
  return { repos, invalid };
}

/** Comma-separated aliases, trimmed and de-duplicated; `tooLong` and `extra` report what LM would refuse. */
export function parseAliases(text: string): { aliases: string[]; tooLong: string[]; extra: number } {
  const all: string[] = [], seen = new Set<string>();
  for (const part of text.split(",")) {
    const a = part.trim();
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    all.push(a);
  }
  return { aliases: all.slice(0, MAX_ALIASES), tooLong: all.filter((a) => a.length > MAX_ALIAS_LEN), extra: Math.max(0, all.length - MAX_ALIASES) };
}

const norm = (p: string) => forward(p).replace(/\/+$/, "").toLowerCase();

/** The bound domain with the longest prefix containing the first repo (whole path segments, case-insensitive). */
export function defaultCharterDomain(repos: string[], domains: Pick<DomainInfo, "name" | "bound" | "prefixes">[]): string | undefined {
  if (!repos.length) return undefined;
  const repo = norm(repos[0]);
  let best: { name: string; len: number } | undefined;
  for (const d of domains) {
    if (!d.bound) continue;
    for (const prefix of d.prefixes) {
      const p = norm(prefix);
      if (!p || !(repo === p || repo.startsWith(p + "/"))) continue;
      if (!best || p.length > best.len) best = { name: d.name, len: p.length };
    }
  }
  return best?.name;
}

export interface CharterParts { purpose: string; objectives?: string; conventions?: string; guidance?: string }

const oneLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("; ");

/** The charter note body in LM's layout: the purpose is the summary; the rest are Details lines. */
export function charterBody({ purpose, objectives, conventions, guidance }: CharterParts): string {
  const lines = ([["Objectives", objectives], ["Conventions", conventions], ["Agent guidance", guidance]] as const)
    .map(([label, text]) => [label, oneLine(text ?? "")] as const)
    .filter(([, text]) => text)
    .map(([label, text]) => `- **${label}:** ${text}`);
  return [purpose.trim(), ...(lines.length ? [`## ${HEADINGS.details}\n${lines.join("\n")}`] : [])].join("\n\n");
}

export interface CreateForm { name: string; slug: string; repos: string; aliases: string; description: string; purpose: string }

/** Problems LM would reject, in plain words (empty when the form is ready for a plan). */
export function validateCreate(form: CreateForm, existingSlugs: string[] = []): string[] {
  const problems: string[] = [];
  const name = form.name.trim();
  if (!name) problems.push("Give the project a name.");
  else if (name.length > MAX_NAME) problems.push(`The name is limited to ${MAX_NAME} characters.`);
  if (!SLUG_RE.test(form.slug)) problems.push("The slug needs lowercase letters, digits and dashes, starting with a letter or digit (40 characters at most).");
  else if (existingSlugs.includes(form.slug)) problems.push(`A project with the slug "${form.slug}" already exists.`);
  problems.push(...repoProblems(form.repos, true), ...aliasProblems(form.aliases));
  if (form.description.trim().length > MAX_DESCRIPTION) problems.push(`The description is limited to ${MAX_DESCRIPTION} characters.`);
  if (!form.purpose.trim()) problems.push("Describe the purpose of the project: it becomes the charter's summary.");
  return problems;
}

function repoProblems(text: string, required: boolean): string[] {
  const { repos, invalid } = parseRepos(text);
  const out: string[] = [];
  if (invalid.length) out.push(`Repository paths must be absolute: ${invalid.join(", ")}.`);
  if (required && !repos.length && !invalid.length) out.push("Add at least one repository path.");
  if (repos.length > MAX_REPOS) out.push(`At most ${MAX_REPOS} repositories.`);
  return out;
}

function aliasProblems(text: string): string[] {
  const { tooLong, extra } = parseAliases(text);
  const out: string[] = [];
  if (extra) out.push(`At most ${MAX_ALIASES} aliases.`);
  if (tooLong.length) out.push(`Aliases are limited to ${MAX_ALIAS_LEN} characters: ${tooLong.join(", ")}.`);
  return out;
}

export interface EditForm { name: string; repos: string; aliases: string; description: string; status: ProjectStatus }

/** Problems for an edit (the same limits; repositories may be empty). */
export function validateEdit(form: EditForm): string[] {
  const problems: string[] = [];
  const name = form.name.trim();
  if (!name) problems.push("Give the project a name.");
  else if (name.length > MAX_NAME) problems.push(`The name is limited to ${MAX_NAME} characters.`);
  problems.push(...repoProblems(form.repos, false), ...aliasProblems(form.aliases));
  if (form.description.trim().length > MAX_DESCRIPTION) problems.push(`The description is limited to ${MAX_DESCRIPTION} characters.`);
  return problems;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A ProjectUpdate with only what changed (plus the slug), or null when nothing did. */
export function changedProject(before: Project, form: EditForm): ProjectUpdate | null {
  const update: ProjectUpdate = { slug: before.slug };
  const name = form.name.trim();
  if (name !== before.name) update.name = name;
  const repos = parseRepos(form.repos).repos;
  if (!same(repos, before.repos.map(forward))) update.repos = repos;
  const aliases = parseAliases(form.aliases).aliases;
  if (!same(aliases, before.aliases)) update.aliases = aliases;
  const description = form.description.trim();
  if (description !== (before.description ?? "").trim()) update.description = description;
  if (form.status !== before.status) update.status = form.status;
  return Object.keys(update).length > 1 ? update : null;
}

/** `base` plus `extra`, without duplicates (order kept). */
export const mergeTags = (base: string[], extra: string[]): string[] => [...new Set([...base, ...extra])];
