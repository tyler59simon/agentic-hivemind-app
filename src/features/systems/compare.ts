// Compare two architecture models. Pure, so it is tested without a DOM.
import type { ArchElement, ArchModel, ArchRelationship } from "../../lib/architecture";

export interface ModelDiff {
  /** Element ids only in the newer model. */
  added: string[];
  /** Element ids in both, with a different name, type, technology, description, parent or external flag. */
  changed: string[];
  removed: { id: string; name: string }[];
  /** "source->destination" only in the newer model. */
  addedEdges: string[];
  changedEdges: string[];
  /** Element names, for the legend. */
  removedEdges: { key: string; from: string; to: string }[];
}

/** The canvas's own arrow id: relationships are compared by their two ends, not by id (the suite numbers ids by position). */
export const edgeKey = (r: Pick<ArchRelationship, "source_id" | "destination_id">) => `${r.source_id}->${r.destination_id}`;

const FIELDS = ["name", "type", "technology", "description", "parent_id"] as const;
const same = (a: ArchElement, b: ArchElement) => FIELDS.every((f) => (a[f] ?? "") === (b[f] ?? "")) && !!a.external === !!b.external;

/** Per pair of ends, the sorted "description|technology" of every relationship on it. */
function edges(model: ArchModel | null): Map<string, { from: string; to: string; value: string }> {
  const found = new Map<string, { from: string; to: string; parts: string[] }>();
  for (const r of model?.relationships ?? []) {
    const key = edgeKey(r);
    const have = found.get(key) ?? { from: r.source_id, to: r.destination_id, parts: [] };
    have.parts.push(`${r.description ?? ""}|${r.technology ?? ""}`);
    found.set(key, have);
  }
  return new Map([...found].map(([key, v]) => [key, { from: v.from, to: v.to, value: v.parts.sort().join("\n") }]));
}

/** What `head` added, changed and removed relative to `base`. */
export function diffModels(base: ArchModel | null, head: ArchModel | null): ModelDiff {
  const before = new Map((base?.elements ?? []).map((e) => [e.id, e]));
  const after = new Map((head?.elements ?? []).map((e) => [e.id, e]));
  const out: ModelDiff = { added: [], changed: [], removed: [], addedEdges: [], changedEdges: [], removedEdges: [] };
  for (const [id, e] of after) {
    const old = before.get(id);
    if (!old) out.added.push(id);
    else if (!same(old, e)) out.changed.push(id);
  }
  for (const [id, e] of before) if (!after.has(id)) out.removed.push({ id, name: e.name });
  const oldEdges = edges(base), newEdges = edges(head);
  for (const [key, e] of newEdges) {
    const old = oldEdges.get(key);
    if (!old) out.addedEdges.push(key);
    else if (old.value !== e.value) out.changedEdges.push(key);
  }
  for (const [key, e] of oldEdges) {
    if (!newEdges.has(key)) out.removedEdges.push({ key, from: before.get(e.from)?.name ?? e.from, to: before.get(e.to)?.name ?? e.to });
  }
  out.added.sort();
  out.changed.sort();
  out.removed.sort((a, b) => a.id.localeCompare(b.id));
  out.addedEdges.sort();
  out.changedEdges.sort();
  out.removedEdges.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/** How many things differ in all. */
export const changeCount = (d: ModelDiff) => d.added.length + d.changed.length + d.removed.length + d.addedEdges.length + d.changedEdges.length + d.removedEdges.length;
