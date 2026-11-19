// Words for a system's architecture drift, as Rust worked it out (archsuite.rs).
import type { DriftChange, DriftFinding } from "../../lib/architecture";

const KIND_WORDS: Record<string, string> = { added: "Added", removed: "Removed", changed: "Changed" };

/** "Changed element API v2", "Removed relationship a->b". */
export function changeText(c: DriftChange): string {
  const what = c.section === "relationships" ? "relationship" : c.section === "elements" ? "element" : c.section;
  return `${KIND_WORDS[c.kind] ?? c.kind} ${what} ${c.name ?? c.id}`;
}

/** "worker → payment-provider breaks no-direct-payments (error, accepted)". */
export function findingText(f: DriftFinding): string {
  return `${f.source} → ${f.destination} breaks ${f.rule} (${f.severity}${f.existing ? ", accepted earlier" : ""})`;
}

/** Changes counted by kind: "2 added, 1 removed". */
export function changeCounts(changes: DriftChange[]): string {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return ["added", "changed", "removed"].filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${k}`).join(", ") || "no changes";
}
