// Pure helpers for the System Passport: group a system's notes into sections, and read the technology stack,
// interfaces, cloud resources, external systems and diagrams out of its Architecture Suite output.
import type { ArchElement, ArchModel, Diagram, Inventory, Topology } from "../../lib/architecture";
import type { NoteRow, System, SystemUpdate } from "../../lib/lm";

export interface PassportSections {
  passport?: NoteRow;
  runbooks: NoteRow[];
  decisions: NoteRow[];
  weaknesses: NoteRow[];
  retired: NoteRow[];
}

const newest = (key: "created" | "updated") => (a: NoteRow, b: NoteRow) => b[key].localeCompare(a[key]);

/** Runbooks, architectural decisions, and weaknesses (risks and bugs: active first, then resolved) among a system's notes. */
export function passportSections(rows: NoteRow[], passportRef: string | null): PassportSections {
  const active = (r: NoteRow) => r.status === "active";
  const passport = passportRef ? rows.find((r) => r.ref === passportRef) : undefined;
  const live = rows.filter((r) => r !== passport);
  const of = (type: NoteRow["type"]) => live.filter((r) => r.type === type);
  const weak = [...of("risk"), ...of("bug")];
  return {
    passport,
    runbooks: of("runbook").filter(active).sort(newest("updated")),
    decisions: of("decision").filter(active).sort(newest("created")),
    weaknesses: [...weak.filter(active).sort(newest("updated")), ...weak.filter((r) => r.status === "resolved").sort(newest("updated"))],
    retired: live.filter((r) => r.status === "archived" || r.status === "superseded").sort(newest("updated")),
  };
}

const elements = (model: ArchModel | null) => model?.elements ?? [];
const isExternal = (e: ArchElement) => e.type === "person" || (e.type === "software_system" && !!e.external);

export interface TechRow { technology: string; elements: string[] }

/** The technologies of the system's own containers, most used first. */
export function techStack(model: ArchModel | null): TechRow[] {
  const by = new Map<string, string[]>();
  for (const e of elements(model)) {
    const technology = e.technology?.trim();
    if (e.type !== "container" || e.external || !technology) continue;
    by.set(technology, [...(by.get(technology) ?? []), e.name]);
  }
  return [...by].map(([technology, names]) => ({ technology, elements: names }))
    .sort((a, b) => b.elements.length - a.elements.length || a.technology.localeCompare(b.technology));
}

export interface ExternalSystem { name: string; description: string; kind: "person" | "system"; uses: boolean; usedBy: boolean }

/** People and external systems in the model. `uses`: this system calls it (an upstream dependency);
 *  `usedBy`: it calls this system (a downstream consumer). */
export function externalSystems(model: ArchModel | null): ExternalSystem[] {
  const outside = new Map(elements(model).filter(isExternal).map((e) => [e.id, e]));
  const uses = new Set<string>(), usedBy = new Set<string>();
  for (const r of model?.relationships ?? []) {
    if (outside.has(r.destination_id) && !outside.has(r.source_id)) uses.add(r.destination_id);
    if (outside.has(r.source_id) && !outside.has(r.destination_id)) usedBy.add(r.source_id);
  }
  return [...outside.values()].map((e) => ({
    name: e.name, description: e.description ?? "", kind: e.type === "person" ? "person" as const : "system" as const,
    uses: uses.has(e.id), usedBy: usedBy.has(e.id),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface Flow { from: string; to: string; description: string; technology: string; direction: "in" | "out" }
export interface Route { path: string; reference: string; line?: number }

/** Interactions that cross the system boundary (from the model) and the routes the code declares (from the inventory). */
export function interfaces(model: ArchModel | null, inventory: Inventory | null): { flows: Flow[]; routes: Route[] } {
  const byId = new Map(elements(model).map((e) => [e.id, e]));
  const flows: Flow[] = [];
  for (const r of model?.relationships ?? []) {
    const from = byId.get(r.source_id), to = byId.get(r.destination_id);
    if (!from || !to || isExternal(from) === isExternal(to)) continue;
    flows.push({ from: from.name, to: to.name, description: r.description ?? "", technology: r.technology ?? "", direction: isExternal(from) ? "in" : "out" });
  }
  const seen = new Set<string>();
  const routes = (inventory?.routes ?? [])
    .map((r) => ({ path: r.path, reference: r.reference ?? "", line: r.line }))
    .filter((r) => r.path && !seen.has(r.path + "|" + r.reference) && seen.add(r.path + "|" + r.reference))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { flows, routes };
}

export interface CloudElement { name: string; provider: string; service: string; description: string }
export interface ResourceGroup { type: string; count: number; ids: string[] }

/** Cloud services named in the model, and the infrastructure resources imported into the topology, grouped by type. */
export function cloudResources(model: ArchModel | null, topology: Topology | null): { elements: CloudElement[]; resources: ResourceGroup[] } {
  const found = elements(model).filter((e) => e.cloud)
    .map((e) => ({ name: e.name, provider: e.cloud!.provider, service: e.cloud!.service, description: e.description ?? "" }))
    .sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
  const by = new Map<string, string[]>();
  for (const r of topology?.resources ?? []) by.set(r.type, [...(by.get(r.type) ?? []), r.id]);
  const resources = [...by].map(([type, ids]) => ({ type, count: ids.length, ids })).sort((a, b) => a.type.localeCompare(b.type));
  return { elements: found, resources };
}

export interface DiagramEntry { key: string; path: string; format: "svg" | "png"; title: string; level: string }

/** "02-containers" -> "Containers". */
export const levelLabel = (level: string) => {
  const words = level.replace(/^\d+-/, "").replace(/-/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
};

/** One entry per diagram (SVG preferred over PNG), titled from the model's views, in the suite's level order. */
export function diagramList(diagrams: Diagram[], model: ArchModel | null): DiagramEntry[] {
  const titles = new Map((model?.views ?? []).map((v) => [v.id, v.title]));
  const best = new Map<string, Diagram>();
  for (const d of diagrams) {
    if (d.path.startsWith("../") || d.path.includes("/../")) continue;
    const key = d.path.replace(/\.[^./]+$/, "");
    const have = best.get(key);
    if (!have || (have.format !== "svg" && d.format === "svg")) best.set(key, d);
  }
  return [...best].sort(([a], [b]) => a.localeCompare(b)).map(([key, d]) => {
    const name = key.split("/").pop() ?? key;
    return { key, path: d.path, format: d.format, title: titles.get(name) ?? name.replace(/-/g, " "), level: levelLabel(d.level) };
  });
}

/** The registry fields an agent session proposed, as its structured result carries them. */
export interface Proposal { description?: string; capabilities?: string[]; owners?: string[]; depends_on?: string[] }

const strings = (value: unknown, max: number, len: number): string[] | undefined =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter((v) => v && v.length <= len))].slice(0, max) : undefined;
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The `registry` part of a session's structured result, or null when it carries none. */
export const proposalOf = (structured: unknown): Proposal | null => {
  const registry = (structured as { registry?: unknown } | null)?.registry;
  return registry && typeof registry === "object" ? registry as Proposal : null;
};

/** A SystemUpdate with the proposed fields that differ from the registry and that LM would accept, or null when
 *  nothing is left to change. Dependencies are limited to registered systems; an empty proposal never clears a field. */
export function proposedUpdate(system: System, proposal: Proposal | null, knownSlugs: string[]): SystemUpdate | null {
  if (!proposal) return null;
  const update: SystemUpdate = { slug: system.slug };
  const description = typeof proposal.description === "string" ? proposal.description.trim() : "";
  if (description && description.length <= 500 && description !== (system.description ?? "").trim()) update.description = description;
  const capabilities = strings(proposal.capabilities, 20, 120);
  if (capabilities?.length && !sameList(capabilities, system.capabilities)) update.capabilities = capabilities;
  const owners = strings(proposal.owners, 10, 80);
  if (owners?.length && !sameList(owners, system.owners)) update.owners = owners;
  const depends = strings(proposal.depends_on, 50, 40)?.filter((s) => s !== system.slug && knownSlugs.includes(s));
  if (depends?.length && !sameList([...depends].sort(), [...system.depends_on].sort())) update.depends_on = depends;
  return Object.keys(update).length > 1 ? update : null;
}
