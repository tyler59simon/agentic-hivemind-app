// Pure helpers for the change wizard; the limits mirror Living Memory's `change-plan` validation.
import type { Change, ChangeCreate, ChangeStage, ChangeUpdate } from "../../lib/lm";

export const MAX_TITLE = 120;
export const MAX_BRANCH = 200;

export interface ChangeFields {
  project: string; title: string; outcome: string; repo: string; branch: string;
  system: string; element: string; stage: ChangeStage;
}
export const EMPTY: ChangeFields = { project: "", title: "", outcome: "", repo: "", branch: "", system: "", element: "", stage: "explore" };

/** Problems Living Memory would reject, in plain words (empty when the form is ready for a plan). */
export function validateChange(form: ChangeFields, mode: "create" | "adopt" | "edit"): string[] {
  const problems: string[] = [];
  const title = form.title.trim();
  if (!form.project) problems.push("Pick a project.");
  if (!title) problems.push("Give the change a title.");
  if (title.length > MAX_TITLE) problems.push(`The title is limited to ${MAX_TITLE} characters.`);
  if (/[[\]|#]/.test(title)) problems.push("The title cannot contain [ ] | or #: other notes link to the brief by its title.");
  if (mode === "create" && !form.outcome.trim()) problems.push("Describe the outcome: it becomes the brief's summary.");
  if (form.branch.trim().length > MAX_BRANCH) problems.push(`The branch name is limited to ${MAX_BRANCH} characters.`);
  if (form.element.trim() && !form.system.trim()) problems.push("Pick a system before an element.");
  return problems;
}

/** The brief of a new change: the outcome is its summary. */
export const briefBody = (outcome: string) => outcome.trim();

/** The create payload; `adopt` is the ref of an existing plan note to use as the brief. */
export function createPayload(form: ChangeFields, adopt?: string): ChangeCreate {
  const payload: ChangeCreate = { project: form.project, title: form.title.trim(), brief: adopt ?? { body: briefBody(form.outcome) } };
  for (const key of ["repo", "branch", "system", "element"] as const) {
    const v = form[key].trim();
    if (v) payload[key] = v;
  }
  if (form.stage !== "explore") payload.stage = form.stage;
  return payload;
}

export const formOf = (change: Change): ChangeFields => ({
  project: change.project, title: change.title, outcome: "", repo: change.repo ?? "", branch: change.branch ?? "",
  system: change.system ?? "", element: change.element ?? "", stage: change.stage,
});

/** A ChangeUpdate with only what changed (plus the id), or null when nothing did. */
export function changedChange(before: Change, form: ChangeFields): ChangeUpdate | null {
  const update: ChangeUpdate = { id: before.id };
  const title = form.title.trim();
  if (title !== before.title) update.title = title;
  if (form.stage !== before.stage) update.stage = form.stage;
  for (const key of ["repo", "branch", "system", "element"] as const) {
    const v = form[key].trim() || null;
    if (v !== before[key]) update[key] = v;
  }
  if (update.system === null) update.element = null;
  return Object.keys(update).length > 1 ? update : null;
}
