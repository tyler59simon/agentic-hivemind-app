// Who did what, read from Living Memory's journals. Journals carry no actor, so it is inferred:
// Hivemind's own operation log, overlay_* kinds (Obsidian vault edits), a captured note's origin, plan kinds.
import type { Operation } from "../../lib/lm";

export const BOOKKEEPING = new Set(["overlay_state", "overlay_sync", "overlay_views", "bind_domain"]);
const PLAN_KINDS = new Set(["rename", "retag", "archive", "resolve", "reopen", "delete", "merge", "bulk_retag",
  "reference_remap", "taxonomy_expansion", "ingest", "import", "restore", "schema_migration", "note_type_migration", "overlay_delete",
  "project_create", "project_update", "project_archive"]);

const VERBS: Record<string, string> = {
  capture: "captured", capture_supersede: "captured a replacement", capture_promote: "captured (promoted to global)", promote: "promoted to global",
  update: "edited", supersede: "superseded", confirm: "confirmed", archive: "archived", resolve: "resolved", reopen: "reopened",
  delete: "deleted", rename: "renamed", retag: "retagged", merge: "merged", bulk_retag: "retagged notes across the store",
  taxonomy_expansion: "added tags to the taxonomy", reference_remap: "moved notes between domains", ingest: "imported auto-memory",
  import: "imported a bundle", restore: "restored a backup", schema_migration: "migrated note files", note_type_migration: "migrated note types",
  project_create: "created project", project_update: "updated project", project_archive: "archived project",
  overlay_auto_update: "edited in Obsidian", overlay_capture: "captured in Obsidian", overlay_delete: "deleted in Obsidian",
};

export const verbOf = (kind: string) => (kind.startsWith("undo:") ? "undid a change" : VERBS[kind] ?? kind.replace(/_/g, " "));

/** The 8-character note ID prefixes an operation touched (from LM's `TYPE - slug-id8.md` file names). */
export function noteIdsOf(op: Pick<Operation, "files">): string[] {
  const ids = op.files.map((f) => /-([0-9a-f]{8})\.md$/i.exec(f)?.[1]).filter((x): x is string => !!x);
  return [...new Set(ids)];
}

/** The domain an operation's files live in, if they all share one. */
export function domainOfOp(op: Pick<Operation, "files">): string | null {
  const found = new Set(op.files.map((f) => /^domains\/([^/]+)\//.exec(f)?.[1]).filter(Boolean));
  return found.size === 1 ? [...found][0]! : null;
}

export type ActorKind = "you" | "obsidian" | "agent" | "plan";
export interface Actor { kind: ActorKind; label: string }

const HARNESSES: Record<string, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot", factory: "Factory", hivemind: "Hivemind" };

export function actorOf(op: Pick<Operation, "operation_id" | "kind">, mine: Set<string>, origin?: string): Actor {
  if (mine.has(op.operation_id)) return { kind: "you", label: "You · Hivemind" };
  if (op.kind.startsWith("overlay_")) return { kind: "obsidian", label: "You · Obsidian" };
  if (op.kind.startsWith("undo:") || PLAN_KINDS.has(op.kind)) return { kind: "plan", label: "Approved plan" };
  if (op.kind.startsWith("capture") && origin) {
    const harness = origin.split(":")[0];
    if (harness === "hivemind") return { kind: "you", label: "Hivemind (another device)" };
    if (HARNESSES[harness]) return { kind: "agent", label: HARNESSES[harness] };
  }
  return { kind: "agent", label: "Agent or CLI" };
}

/** Local calendar day for grouping ("Today", "Yesterday" or a date). */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key(d) === key(now)) return "Today";
  if (key(d) === key(yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

export const visible = (op: Operation) => !BOOKKEEPING.has(op.kind) && op.state === "committed";
