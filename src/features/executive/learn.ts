// Learning writing preferences from the user's edits to a generated draft, once per generated text.
import type { Draft } from "../../lib/executive";
import { edited } from "./texts";

/** Read the edits to draft `id` for preferences; true when suggestions were staged in the capture inbox. The backend records
 *  the draft as learned from when the call succeeds (only `learnedFrom`, only while the draft has the same generated text). */
export type Learn = (id: string, generated: string, kept: string, label: string) => Promise<boolean>;

/** Calls under way, by draft and generated text, so a copy and an export in quick succession make one call. */
const running = new Set<string>();

/** After a draft left (copied or exported) with `subject` and `body`: learn from the edits unless this generated text was
 *  learned from already or is being learned from now. A failed call marks nothing, so the next send tries again. True when
 *  suggestions were staged. */
export async function learnFromEdits(d: Draft, subject: string, body: string, learn: Learn): Promise<boolean> {
  if (!edited(d.generated, body) || d.learnedFrom === d.generated) return false;
  const key = `${d.id}\n${d.generated}`;
  if (running.has(key)) return false;
  running.add(key);
  try {
    return await learn(d.id, d.generated, body, subject);
  } finally {
    running.delete(key);
  }
}
