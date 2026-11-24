// One page's timeline (NS-5): the versions Hivemind kept and the commits of its git repository, merged newest first. Pure, so
// the order is tested without a screen.
import type { GitCommit, Snapshot } from "../../lib/history";

interface Base { /** Unique in a timeline, and what `history_read` takes: a snapshot's number, or `git:<commit>`. */ id: string; time: number }
export interface SnapshotRow extends Base { kind: "snapshot"; number: number; size: number; source: string; pinned: boolean }
export interface CommitRow extends Base { kind: "commit"; sha: string; author: string; subject: string; path: string }
export type Row = SnapshotRow | CommitRow;

// At the same moment a snapshot comes before a commit; equal rows keep the order they were given in.
const RANK = { snapshot: 0, commit: 1 } as const;

/** The two sources merged, newest first. A date that does not parse sorts last. */
export function timeline(snapshots: Snapshot[], commits: GitCommit[]): Row[] {
  const rows: Row[] = [
    ...snapshots.map((s): SnapshotRow => ({ kind: "snapshot", id: String(s.id), time: s.time, number: s.id, size: s.size, source: s.source, pinned: s.pinned })),
    ...commits.map((c): CommitRow => ({ kind: "commit", id: `git:${c.sha}`, time: Date.parse(c.date) || 0, sha: c.sha, author: c.author, subject: c.subject, path: c.path })),
  ];
  return rows.map((row, at) => ({ row, at })).sort((a, b) => b.row.time - a.row.time || RANK[a.row.kind] - RANK[b.row.kind] || a.at - b.at).map((x) => x.row);
}

const SOURCES: Record<string, string> = {
  you: "Saved by you", links: "Link update", restore: "Restored", replace: "Replace in files", ai: "AI action", agent: "Agent apply",
  capture: "Quick capture", disk: "Found on disk", recovered: "Recovered",
};

/** What a snapshot's `source` says, in words. */
export const sourceLabel = (source: string) => SOURCES[source] ?? source;

/** The line a row shows: what happened, or the commit's subject. */
export function rowLabel(row: Row): string {
  if (row.kind === "commit") return row.subject || "(no message)";
  return sourceLabel(row.source);
}

/** The small print under a row: size and pin for a snapshot, the author for a commit. */
export function rowDetail(row: Row): string {
  if (row.kind === "commit") return `Commit ${row.sha.slice(0, 7)} by ${row.author}`;
  return `${row.size.toLocaleString()} bytes${row.pinned ? " · pinned" : ""}`;
}
