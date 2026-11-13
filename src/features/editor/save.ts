// What a save sends. LM's `update` writes even when nothing changed and resets review_by on body saves
// unless review_by is sent, so the payload carries only fields the user changed.
import type { Note, NoteType, UpdatePayload } from "../../lib/lm";
import { ACTION_TYPES, sections, TEMPLATE_PROMPTS } from "../../lib/note";

export interface Fields {
  title: string; body: string; type: NoteType; tags: string[]; context: string; review_by: string; files: string[];
}

export const fieldsOf = (n: Note): Fields => ({
  title: n.title, body: n.body, type: n.type, tags: [...n.tags].sort(), context: n.context ?? "",
  review_by: (n.review_by ?? "").slice(0, 10), files: [...(n.files ?? [])],
});

const norm = (text: string) => text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

export function changedPayload(base: Fields, now: Fields): UpdatePayload {
  const p: UpdatePayload = {};
  if (now.title.trim() !== base.title.trim()) p.title = now.title.trim();
  if (norm(now.body) !== norm(base.body)) p.body = now.body;
  if (now.type !== base.type) p.type = now.type;
  if (!sameSet(now.tags, base.tags)) p.tags = [...now.tags].sort();
  if (now.context.trim() !== base.context.trim()) p.context = now.context.trim();
  if (now.review_by !== base.review_by) p.review_by = now.review_by || null;
  const files = now.files.map((f) => f.trim()).filter(Boolean);
  if (!sameList(files, base.files)) p.files = files;
  return p;
}

export const isEmpty = (p: object) => Object.keys(p).length === 0;
export const isDirty = (base: Fields, now: Fields) => !isEmpty(changedPayload(base, now));

/** The summary LM would see after formatting: the text before the first heading or callout (or a legacy
 *  Executive Summary section). */
export const summaryOf = (body: string): string => sections(body).summary ?? "";

const PROMPTS = new Set(Object.values(TEMPLATE_PROMPTS));

/** Problems LM would reject, caught before the round trip. LM stays the authority. */
export function precheck(f: Fields, taxonomy: string[], isNew: boolean): string[] {
  const problems: string[] = [];
  if (!f.title.trim()) problems.push("The note needs a title.");
  const found = sections(f.body);
  const summary = (found.summary ?? "").trim();
  if (!summary) problems.push("Write a summary: start the body with one or two sentences.");
  // LM's Obsidian sync refuses a note whose summary is still the template's prompt; the app's templates use the same prompts.
  else if (PROMPTS.has(summary)) problems.push("Replace the template's first line with a summary of the note.");
  if (found.actions && !ACTION_TYPES.has(f.type)) problems.push("Action items are only for plan, bug and risk notes; record lasting facts in the body instead, or change the type.");
  const known = new Set(taxonomy);
  const unknown = f.tags.filter((t) => !known.has(t));
  if (taxonomy.length && unknown.length) problems.push(`Tags not in the taxonomy yet: ${unknown.join(", ")}.`);
  if (isNew && !f.tags.some((t) => t.startsWith("subject/"))) problems.push("Add a subject/ tag.");
  if (isNew && !f.tags.some((t) => t.startsWith("concern/"))) problems.push("Add a concern/ tag.");
  if (f.review_by && !/^\d{4}-\d{2}-\d{2}$/.test(f.review_by)) problems.push("Review date must be YYYY-MM-DD.");
  const files = f.files.map((x) => x.trim()).filter(Boolean);
  if (files.length > 30) problems.push("At most 30 files (Living Memory keeps the first 30).");
  if (files.some((x) => x.length > 300)) problems.push("File paths must be at most 300 characters.");
  return problems;
}
