// The custom note type form: its fields, what Hivemind checks before sending, and the payload for `type create` or
// `type update`. Living Memory checks the rest (reserved names and headings, the review range, known tags).
import type { NoteTypeCreate, NoteTypeDef, NoteTypeUpdate } from "../../lib/lm";

export interface TypeFields {
  name: string; description: string; summary: string; sections: string[]; actions: boolean;
  /** Blank means no review interval. */
  reviewDays: string;
  /** Empty means none. */
  concern: string; subject: string;
}

export const MAX_SECTIONS = 8;
const NAME = /^[a-z][a-z0-9]{2,23}$/;

export const fieldsOfType = (d?: NoteTypeDef): TypeFields => ({
  name: d?.name ?? "", description: d?.description ?? "", summary: d?.summary ?? "", sections: [...(d?.sections ?? [])],
  actions: d?.actions ?? false, reviewDays: d?.review_days == null ? "" : String(d.review_days),
  concern: d?.concern ?? "", subject: d?.subject ?? "",
});

export function typeProblems(f: TypeFields, creating: boolean): string[] {
  const problems: string[] = [];
  if (creating && !NAME.test(f.name)) problems.push("The name is 3 to 24 lowercase letters or digits, starting with a letter.");
  if (!f.description.trim()) problems.push("Describe what notes of this type are for.");
  if (f.reviewDays.trim() && !/^\d+$/.test(f.reviewDays.trim())) problems.push("Review days must be a whole number, or blank for none.");
  return problems;
}

/** What `type create` gets, or for an existing type only the fields that changed (null when none did). */
export function typePayload(f: TypeFields, def?: NoteTypeDef): NoteTypeCreate | NoteTypeUpdate | null {
  const values = {
    description: f.description.trim(),
    summary: f.summary.trim(),
    sections: f.sections.map((s) => s.trim()).filter(Boolean),
    actions: f.actions,
    review_days: f.reviewDays.trim() ? Number(f.reviewDays.trim()) : null,
    concern: f.concern || null,
    subject: f.subject || null,
  };
  if (!def) return { name: f.name, ...values };
  const before = fieldsOfType(def);
  const changed: NoteTypeUpdate = { name: def.name };
  if (values.description !== before.description) changed.description = values.description;
  if (values.summary !== before.summary) changed.summary = values.summary;
  if (values.sections.join("\n") !== before.sections.join("\n")) changed.sections = values.sections;
  if (values.actions !== before.actions) changed.actions = values.actions;
  if (values.review_days !== (def.review_days ?? null)) changed.review_days = values.review_days;
  if (values.concern !== (def.concern ?? null)) changed.concern = values.concern;
  if (values.subject !== (def.subject ?? null)) changed.subject = values.subject;
  return Object.keys(changed).length > 1 ? changed : null;
}
