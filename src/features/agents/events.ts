// Pure reduction of an agent session's event stream into what the transcript shows.
// Events are numbered per session; a stored log and the live stream use the same numbers, so a view can load the
// log and keep applying live events without gaps or duplicates.
import type { RunEvent, SeqEvent } from "../../lib/agent";

export type Finished = Extract<RunEvent, { type: "finished" }>;
export type Item =
  | { kind: "started"; model: string | null; cliVersion: string | null; plugins: string[] }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; result?: { ok: boolean; summary: string } }
  | { kind: "denied"; tool: string; summary: string };

export interface Transcript {
  /** The sequence number expected next. */
  next: number;
  items: Item[];
  finished?: Finished;
  /** An event arrived ahead of `next`: some were missed, so the log must be read again. */
  gap: boolean;
}

export const EMPTY: Transcript = { next: 0, items: [], gap: false };

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
    case "finished": return { ...next, finished: event };
    default: return next; // an event kind from a newer Hivemind backend
  }
}

export const build = (events: SeqEvent[]): Transcript => events.reduce(apply, EMPTY);

/** A freshly read log replaces the live state unless the live state is already further along. */
export const merge = (live: Transcript, fresh: Transcript): Transcript => (fresh.next >= live.next ? fresh : { ...live, gap: false });

/** "1 min 5 s", "42 s". */
export function duration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export const cost = (usd: number | null | undefined) => (usd == null ? "" : `$${usd.toFixed(2)}`);
