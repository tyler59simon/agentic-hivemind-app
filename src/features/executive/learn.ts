// Learning writing preferences from the user's edits to a generated draft, once per generated text.
import type { Draft } from "../../lib/executive";
import { edited } from "./texts";

export interface LearnIo {
  /** Read the edits for preferences; true when suggestions were staged in the capture inbox. */
  learn: (generated: string, kept: string, label: string) => Promise<boolean>;
  /** The draft as stored now. */
  latest: (id: string) => Promise<Draft | undefined>;
  save: (draft: Draft) => Promise<unknown>;
}

/** After a draft left (copied or exported) with `subject` and `body`: learn from the edits unless this generated text was
 *  learned from already. `learnedFrom` is saved only once the call has finished, on the latest copy of the draft, so a failed
 *  call is tried again on the next send and an edit made during the call is kept. True when suggestions were staged. */
export async function learnFromEdits(d: Draft, subject: string, body: string, io: LearnIo): Promise<boolean> {
  if (!edited(d.generated, body) || d.learnedFrom === d.generated) return false;
  const staged = await io.learn(d.generated, body, subject);
  const now = (await io.latest(d.id)) ?? d;
  await io.save({ ...now, learnedFrom: d.generated });
  return staged;
}
