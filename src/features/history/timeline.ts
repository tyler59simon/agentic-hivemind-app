// One page's timeline (NS-5): the versions Hivemind kept, the commits of its git repository and, for a Living Memory page,
// Living Memory's own history, merged newest first. Pure, so the order is tested without a screen.
import type { DocHistoryRow } from "../../lib/lm";
import type { GitCommit, Snapshot } from "../../lib/history";
import { verbOf } from "./activity";

interface Base { /** Unique in a timeline, and what `history_read` takes: a snapshot's number, or `git:<commit>`. */ id: string; time: number }
export interface SnapshotRow extends Base { kind: "snapshot"; number: number; size: number; source: string; pinned: boolean }
export interface CommitRow extends Base { kind: "commit"; sha: string; author: string; subject: string; path: string }
/** A Living Memory page's operation; `id` is the operation id. */
export interface LmRow extends Base { kind: "lm"; what: string; state: string }
export type Row = SnapshotRow | CommitRow | LmRow;

// At the same moment a snapshot comes before a commit, and a commit before a Living Memory operation; equal rows keep
// the order they were given in.
const RANK = { snapshot: 0, commit: 1, lm: 2 } as const;

/** The three sources merged, newest first. A date that does not parse sorts last. */
export function timeline(snapshots: Snapshot[], commits: GitCommit[], operations: DocHistoryRow[] = []): Row[] {
  const rows: Row[] = [
    ...snapshots.map((s): SnapshotRow => ({ kind: "snapshot", id: String(s.id), time: s.time, number: s.id, size: s.size, source: s.source, pinned: s.pinned })),
    ...commits.map((c): CommitRow => ({ kind: "commit", id: `git:${c.sha}`, time: Date.parse(c.date) || 0, sha: c.sha, author: c.author, subject: c.subject, path: c.path })),
    ...operations.map((o): LmRow => ({ kind: "lm", id: o.operation_id, time: Date.parse(o.created) || 0, what: LM_VERBS[o.kind] ?? verbOf(o.kind), state: o.state })),
  ];
  return rows.map((row, at) => ({ row, at })).sort((a, b) => b.row.time - a.row.time || RANK[a.row.kind] - RANK[b.row.kind] || a.at - b.at).map((x) => x.row);
}

/** What a Living Memory page operation did (`alm doc history`); other kinds are worded as the memory history words them. */
const LM_VERBS: Record<string, string> = {
  doc_create: "Page created", doc_write: "Page edited", doc_move: "Page moved", doc_delete: "Page deleted", doc_attach: "File attached",
  doc_accept: "Agent's edit accepted", doc_propose: "Agent proposed an edit", doc_reject: "Agent's edit rejected", doc_undo: "Change undone",
};

const SOURCES: Record<string, string> = {
  you: "Saved by you", links: "Link update", restore: "Restored", replace: "Replace in files", ai: "AI action", agent: "Agent apply",
  capture: "Quick capture", disk: "Found on disk", recovered: "Recovered",
};

/** What a snapshot's `source` says, in words. */
export const sourceLabel = (source: string) => SOURCES[source] ?? source;

/** The line a row shows: what happened, or the commit's subject. */
export function rowLabel(row: Row): string {
  if (row.kind === "commit") return row.subject || "(no message)";
  if (row.kind === "lm") return row.state === "committed" ? row.what : `${row.what} (${row.state})`;
  return sourceLabel(row.source);
}

/** The small print under a row: size and pin for a snapshot, the author for a commit. */
export function rowDetail(row: Row): string {
  if (row.kind === "commit") return `Commit ${row.sha.slice(0, 7)} by ${row.author}`;
  if (row.kind === "snapshot") return `${row.size.toLocaleString()} bytes${row.pinned ? " · pinned" : ""}`;
  return "Living Memory";
}
