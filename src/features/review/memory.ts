import type { Note, NoteRow, ReviewRow } from "../../lib/lm";

export const RECENT_DAYS = 14;
export const CANDIDATES = 40;
type Meta = Pick<Note, "status" | "origin" | "confirmed">;

/** The notes worth one metadata read each: active, created in the last RECENT_DAYS. */
export function candidates(rows: NoteRow[], now = new Date()): NoteRow[] {
  const span = RECENT_DAYS * 24 * 60 * 60 * 1000;
  return rows.filter((r) => r.status === "active" && now.getTime() - new Date(r.created).getTime() <= span).slice(0, CANDIDATES);
}

/** Captured inside an agent session and never confirmed by anyone. */
export const agentCaptured = (m: Meta) => m.status === "active" && !!m.origin && !m.origin.startsWith("hivemind:") && !m.confirmed?.length;

/** Rows for the Memory list: agent captures nobody has confirmed, without the ones already due. */
export function unconfirmed(rows: NoteRow[], metas: (Meta | undefined)[], due: Set<string>): ReviewRow[] {
  return rows.flatMap((r, i) => {
    const meta = metas[i];
    if (!meta || !agentCaptured(meta) || due.has(r.ref)) return [];
    return [{ ref: r.ref, title: r.title, type: r.type, updated: r.updated, revision: r.revision, domain: r.domain }];
  });
}
