// Pure reduction of an agent session's event stream into what the transcript shows.
// Events are numbered per session; a stored log and the live stream use the same numbers, so a view can load the
// log and keep applying live events without gaps or duplicates.
import type { Decision, FileChange, RunEvent, SeqEvent, TurnOutcome } from "../../lib/agent";

export type Finished = Extract<RunEvent, { type: "finished" }>;
export type Item =
  | { kind: "started"; model: string | null; cliVersion: string | null; plugins: string[] }
  | { kind: "user"; text: string; context: string[] }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; result?: { ok: boolean; summary: string } }
  | { kind: "denied"; tool: string; summary: string }
  | { kind: "approval"; requestId: string; tool: string; summary: string; input: unknown; canAlways: boolean; alwaysLabel: string | null; decision?: Decision }
  | { kind: "files"; files: FileChange[] }
  | { kind: "turn"; ok: boolean; outcome: TurnOutcome; reason: string | null; costUsd: number | null; durationMs: number | null; denials: number };

export interface Transcript {
  /** The sequence number expected next. */
  next: number;
  items: Item[];
  finished?: Finished;
  /** An event arrived ahead of `next`: some were missed, so the log must be read again. */
  gap: boolean;
}

export const EMPTY: Transcript = { next: 0, items: [], gap: false };

/** An approval nobody answered is over once its turn or the session is: the CLI no longer waits for it. */
const withdrawOpen = (items: Item[]): Item[] => items.map((item) => (item.kind === "approval" && !item.decision ? { ...item, decision: "withdrawn" } : item));

export function apply(state: Transcript, { seq, event }: SeqEvent): Transcript {
  if (seq < state.next) return state;
  if (seq > state.next) return state.gap ? state : { ...state, gap: true };
  const next = { ...state, next: seq + 1 };
  switch (event.type) {
    case "started": return { ...next, items: [...state.items, { kind: "started", model: event.model, cliVersion: event.cliVersion, plugins: event.plugins }] };
    case "text": return { ...next, items: [...state.items, { kind: "text", text: event.text }] };
    case "toolUse": return { ...next, items: [...state.items, { kind: "tool", id: event.id, name: event.name, summary: event.summary }] };
    case "toolResult":
      return { ...next, items: state.items.map((item) => (item.kind === "tool" && item.id === event.id ? { ...item, result: { ok: event.ok, summary: event.summary } } : item)) };
    case "denied": return { ...next, items: [...state.items, { kind: "denied", tool: event.tool, summary: event.summary }] };
    case "userMessage": return { ...next, items: [...state.items, { kind: "user", text: event.text, context: event.context }] };
    case "approvalRequest":
      return {
        ...next,
        items: [...state.items, {
          kind: "approval", requestId: event.requestId, tool: event.tool, summary: event.summary, input: event.input,
          canAlways: event.canAlways, alwaysLabel: event.alwaysLabel,
        }],
      };
    case "approvalResolved":
      return { ...next, items: state.items.map((item) => (item.kind === "approval" && item.requestId === event.requestId && !item.decision ? { ...item, decision: event.decision } : item)) };
    case "filesChanged": return { ...next, items: [...state.items, { kind: "files", files: event.files }] };
    case "turnFinished":
      return {
        ...next,
        items: [...withdrawOpen(state.items), {
          kind: "turn", ok: event.ok, outcome: event.outcome, reason: event.reason, costUsd: event.costUsd, durationMs: event.durationMs, denials: event.denials,
        }],
      };
    case "finished": return { ...next, items: withdrawOpen(state.items), finished: event };
    default: return next; // an event kind from a newer Hivemind backend
  }
}

export const build = (events: SeqEvent[]): Transcript => events.reduce(apply, EMPTY);

export const pendingApprovals = (t: Transcript) => t.items.filter((i) => i.kind === "approval" && !i.decision);

const last = <K extends Item["kind"]>(t: Transcript, kind: K): Extract<Item, { kind: K }> | undefined => {
  const all = t.items.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind);
  return all[all.length - 1];
};

/** The files of the last "files" item. */
export const latestFiles = (t: Transcript): FileChange[] | undefined => last(t, "files")?.files;

export const lastTurn = (t: Transcript): Extract<Item, { kind: "turn" }> | undefined => last(t, "turn");

/** A freshly read log replaces the live state unless the live state is already further along. */
export const merge = (live: Transcript, fresh: Transcript): Transcript => (fresh.next >= live.next ? fresh : { ...live, gap: false });

/** "1 min 5 s", "42 s". */
export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export const cost = (usd: number | null | undefined) => (usd == null ? "" : `$${usd.toFixed(2)}`);
