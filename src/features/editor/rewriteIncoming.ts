import { classify } from "../../lib/errors";
import { bridgeGeneration, read, update } from "../../lib/lm";
import { rewriteWikilinks } from "../../lib/note";
import { recordOperation } from "../../lib/oplog";

export interface LinkSource { ref: string; title: string }
export interface RewriteOutcome { done: number; failed: string[]; skipped: string[] }

/** `at` is the bridge generation the rename was made in (the editor's session); each write carries it, so after Hivemind
 *  switches stores a note of the other store is never written, as a save from the editor is not. Without it, the generation
 *  now is used.
 *
 *  Points [[Old Title]] in each note at the new title. Living Memory gives at most 64,000 characters of a note, so a
 *  note it reads as `truncated` is never written back (the write would replace the whole body and drop its tail), and
 *  its unseen tail may hold links too, so it is listed as skipped. */
export async function rewriteIncoming(sources: LinkSource[], oldTitle: string, newTitle: string, at: number | undefined = bridgeGeneration()): Promise<RewriteOutcome> {
  const out: RewriteOutcome = { done: 0, failed: [], skipped: [] };
  for (const source of sources) {
    try {
      const n = await read(source.ref);
      if (n.truncated) { out.skipped.push(source.title); continue; }
      const body = rewriteWikilinks(n.body, oldTitle, newTitle);
      if (body === n.body) continue;
      const r = await update(source.ref, { body, expected_revision: n.revision }, { at });
      recordOperation(r.operation_id);
      out.done++;
    } catch (e) { out.failed.push(`${source.title}: ${classify(e).message}`); }
  }
  return out;
}
