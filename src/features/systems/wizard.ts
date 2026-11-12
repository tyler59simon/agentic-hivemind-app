// Pure helpers for the system create/edit wizard; the limits mirror Living Memory's `system-plan` validation.
import type { System, SystemStatus, SystemUpdate } from "../../lib/lm";
import { HEADINGS } from "../../lib/note";
import { MAX_DESCRIPTION, MAX_NAME, MAX_REPOS, parseRepos, SLUG_RE } from "../projects/wizard";

export const MAX_OWNERS = 10;
export const MAX_OWNER_LEN = 80;
export const MAX_CAPABILITIES = 20;
export const MAX_CAPABILITY_LEN = 120;

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/;
const forward = (p: string) => p.replace(/\\/g, "/");
const norm = (p: string) => forward(p).replace(/\/+$/, "").toLowerCase();

/** Trimmed, de-duplicated (case-insensitive) entries from comma- or line-separated text. */
export function parseList(text: string, separator: "comma" | "line"): string[] {
  const out: string[] = [], seen = new Set<string>();
  for (const part of text.split(separator === "comma" ? "," : /\r?\n/)) {
    const value = part.trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

/** The folder as LM stores it (forward slashes, no trailing slash), or null when the field is empty. */
export const parseFolder = (text: string): string | null => (text.trim() ? forward(text.trim()).replace(/\/+$/, "") : null);

const oneLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("; ");

export interface PassportParts { purpose: string; boundaries?: string; operations?: string; guidance?: string }

/** The passport note body in LM's layout: the purpose is the summary; the rest are Details lines. */
export function passportBody({ purpose, boundaries, operations, guidance }: PassportParts): string {
  const lines = ([["Boundaries", boundaries], ["Operations", operations], ["Agent guidance", guidance]] as const)
    .map(([label, text]) => [label, oneLine(text ?? "")] as const)
    .filter(([, text]) => text)
    .map(([label, text]) => `- **${label}:** ${text}`);
  return [purpose.trim(), ...(lines.length ? [`## ${HEADINGS.details}\n${lines.join("\n")}`] : [])].join("\n\n");
}

export interface SystemForm {
  name: string; purpose: string; owners: string; capabilities: string; repos: string;
  dependsOn: string[]; architecture: string; status: SystemStatus;
}

/** Problems LM would reject, in plain words (empty when the form is ready for a plan). `slug` is checked only on create. */
export function validateSystem(form: SystemForm, create?: { slug: string; existingSlugs: string[] }): string[] {
  const problems: string[] = [];
  const name = form.name.trim();
  if (!name) problems.push("Give the system a name.");
  else if (name.length > MAX_NAME) problems.push(`The name is limited to ${MAX_NAME} characters.`);
  if (create) {
    if (!SLUG_RE.test(create.slug)) problems.push("The slug needs lowercase letters, digits and dashes, starting with a letter or digit (40 characters at most).");
    else if (create.existingSlugs.includes(create.slug)) problems.push(`A system with the slug "${create.slug}" already exists.`);
    if (!form.purpose.trim()) problems.push("Describe the purpose of the system: it becomes the passport's summary.");
  }
  if (form.purpose.trim().length > MAX_DESCRIPTION) problems.push(`The purpose is limited to ${MAX_DESCRIPTION} characters.`);
  const { repos, invalid } = parseRepos(form.repos);
  if (invalid.length) problems.push(`Repository paths must be absolute: ${invalid.join(", ")}.`);
  if (repos.length > MAX_REPOS) problems.push(`At most ${MAX_REPOS} repositories.`);
  const owners = parseList(form.owners, "comma");
  if (owners.length > MAX_OWNERS) problems.push(`At most ${MAX_OWNERS} owners.`);
  if (owners.some((o) => o.length > MAX_OWNER_LEN)) problems.push(`Owners are limited to ${MAX_OWNER_LEN} characters each.`);
  const capabilities = parseList(form.capabilities, "line");
  if (capabilities.length > MAX_CAPABILITIES) problems.push(`At most ${MAX_CAPABILITIES} capabilities.`);
  if (capabilities.some((c) => c.length > MAX_CAPABILITY_LEN)) problems.push(`Capabilities are limited to ${MAX_CAPABILITY_LEN} characters each.`);
  const folder = parseFolder(form.architecture);
  if (folder && !ABSOLUTE.test(folder)) problems.push("The architecture folder must be an absolute path.");
  else if (folder && repos.some((r) => norm(folder) === norm(r) || norm(folder).startsWith(norm(r) + "/"))) {
    problems.push("The architecture folder must be outside the repositories: Architecture Suite does not write into the code it analyses.");
  }
  return problems;
}

/** The registry fields of a form, as `system-plan` takes them. */
export function formFields(form: SystemForm) {
  return {
    name: form.name.trim(),
    description: form.purpose.trim(),
    owners: parseList(form.owners, "comma"),
    capabilities: parseList(form.capabilities, "line"),
    repos: parseRepos(form.repos).repos,
    depends_on: form.dependsOn,
    architecture: parseFolder(form.architecture),
  };
}

export const formOf = (system: System): SystemForm => ({
  name: system.name, purpose: system.description ?? "", owners: system.owners.join(", "), capabilities: system.capabilities.join("\n"),
  repos: system.repos.join("\n"), dependsOn: system.depends_on, architecture: system.architecture ?? "", status: system.status,
});

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A SystemUpdate with only what changed (plus the slug), or null when nothing did. */
export function changedSystem(before: System, form: SystemForm): SystemUpdate | null {
  const next = formFields(form);
  const update: SystemUpdate = { slug: before.slug };
  if (next.name !== before.name) update.name = next.name;
  if (next.description !== (before.description ?? "").trim()) update.description = next.description;
  if (!same(next.owners, before.owners)) update.owners = next.owners;
  if (!same(next.capabilities, before.capabilities)) update.capabilities = next.capabilities;
  if (!same(next.repos, before.repos.map(forward))) update.repos = next.repos;
  if (!same([...next.depends_on].sort(), [...before.depends_on].sort())) update.depends_on = next.depends_on;
  if (next.architecture !== (before.architecture ?? null)) update.architecture = next.architecture;
  if (form.status !== before.status) update.status = form.status;
  return Object.keys(update).length > 1 ? update : null;
}
