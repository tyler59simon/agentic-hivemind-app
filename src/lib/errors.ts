// Living Memory's error *codes* can be skewed by note text quoted in the message (fixed upstream in PR #12,
// but older installs still do it), so Hivemind decides what an error means from the message's leading wording.
import { LmError } from "./lm";

export type Problem =
  | { kind: "stale"; message: string }
  | { kind: "similar"; message: string; ref?: string; title?: string }
  | { kind: "credential"; message: string }
  | { kind: "unknown-tags"; message: string; tags: string[] }
  | { kind: "layout"; message: string }
  | { kind: "ambiguous"; message: string }
  | { kind: "private"; message: string }
  | { kind: "undo-conflict"; message: string }
  /** Hivemind sent a write without the note's revision: a bug in Hivemind, never the user's doing. */
  | { kind: "revision-required"; message: string }
  | { kind: "other"; message: string };

export function classify(error: unknown): Problem {
  const message = error instanceof LmError ? error.message : error instanceof Error ? error.message : String(error);
  if (/^(stale_revision|Stale revision)/.test(message)) return { kind: "stale", message };
  if (/^revision_required/.test(message)) {
    return { kind: "revision-required", message: `Hivemind sent this change without the note's revision, so Living Memory refused it. This is a bug in Hivemind; please report it. (${message})` };
  }
  if (/^possible_duplicate/.test(message)) {
    const m = /similar to (\S+) "([^"]*)"/.exec(message);
    return { kind: "similar", message, ref: m?.[1], title: m?.[2] };
  }
  if (/^Potential credential/.test(message)) return { kind: "credential", message };
  const tags = /^Unknown tags (?:require an approved taxonomy plan|must be added to the taxonomy first \(taxonomy add\)): (.*)$/s.exec(message);
  if (tags) return { kind: "unknown-tags", message, tags: tags[1].split(",").map((t) => t.trim()).filter(Boolean) };
  // Also matches the wording of Living Memory versions before the current note layout ("an Executive Summary", "Action Items").
  if (/^(Note needs a summary|Note needs an Executive Summary|Action items are only for)/i.test(message)) return { kind: "layout", message };
  if (/^ambiguous_/.test(message)) return { kind: "ambiguous", message };
  if (/^private_content/.test(message)) return { kind: "private", message };
  if (/^Undo conflicts with later edits/.test(message)) return { kind: "undo-conflict", message };
  return { kind: "other", message };
}
