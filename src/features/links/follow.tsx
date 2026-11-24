// Following a `[[link]]` from a page (NS-4A): the page's own notebook, then the other notebooks, then memory notes. The
// page lists come from the search index and are asked for when a link is clicked, so a page that is never followed
// from costs nothing. A tie shows a picker, and the pick is written into the page as the explicit form.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, type ReactNode } from "react";
import { keyOf, edit, useDocuments } from "../../documents/store";
import type { FileRef } from "../../documents/keys";
import { classify } from "../../lib/errors";
import { isRichDoc } from "../../lib/notebooks";
import { useApp } from "../../store";
import { Confirm, Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { createMissingPage, openPage } from "../notes/actions";
import { mapLinks } from "./rewrite";
import { loadEnv } from "./env";
import { resolveLink, samePage, type Choice, type Linked, type MemoryNote, type PageEnv } from "./resolve";

/** Open a memory note from a link. */
export function openMemoryNote(note: MemoryNote, split: boolean) {
  useApp.getState().setDomain(note.domain);
  useWorkspace.getState().openNote(note.ref, { split, title: note.title });
}

/** Open what a choice names. */
export function openChoice(choice: Choice, split: boolean) {
  if ("ref" in choice.open) openPage(choice.open.ref, { split });
  else openMemoryNote(choice.open.note, split);
}

/** Write the explicit form into the page where the link was followed from: every `[[target]]` there that names the same
 *  page part. Done only when the page is open for editing and the explicit form really reaches the chosen page. */
function writeExplicit(from: FileRef, target: string, choice: Choice, env: PageEnv, own: string[]) {
  const doc = useDocuments.getState().docs[keyOf(from)];
  if (!doc || isRichDoc(from.path) || !(doc.status === "clean" || doc.status === "dirty")) return;
  const check: Linked = resolveLink(choice.explicit, from, env, own);
  const reaches = "ref" in choice.open ? "ref" in check && samePage(check.ref, choice.open.ref) : "note" in check && check.note.ref === choice.open.note.ref;
  if (!reaches) return;
  const page = target.split("|")[0].split(/[#^]/)[0].trim().toLowerCase();
  const next = mapLinks(doc.text, (l) => (l.kind === "wiki" && l.page.toLowerCase() === page ? choice.explicit : null));
  if (next !== doc.text) edit(keyOf(from), next, true);
}

/** Follow a link written in the page `from`: open it, offer to create it, or let the user pick between answers. `pages` are
 *  the files of the page's own notebook; `ask` shows a dialog (and null closes it). The returned function takes the link's
 *  target, whether to open beside the current pane, and the page the link is in when that is an embedded page. */
export function useFollowLink(from: FileRef, pages: string[], ask: (node: ReactNode) => void) {
  const client = useQueryClient();
  return useCallback(async (target: string, split: boolean, at?: string) => {
    const env = await loadEnv(client);
    const source = at === undefined ? from : { ...from, path: at };
    const own = source.notebook === from.notebook ? pages : undefined;
    const hit = resolveLink(target, source, env, own);
    if ("ref" in hit) return openPage(hit.ref, { split });
    if ("note" in hit) return openMemoryNote(hit.note, split);
    if ("absent" in hit) { toast(hit.absent, "warn"); return; }
    if ("ambiguous" in hit) {
      return ask(
        <Modal title="Several pages have this name" onClose={() => ask(null)}>
          <p className="muted small">Choosing one writes its full name into this page, so the link means the same thing next time.</p>
          <ul className="plain-list">
            {hit.ambiguous.map((choice) => (
              <li key={choice.explicit + choice.label}>
                <button className="link" onClick={() => {
                  ask(null);
                  openChoice(choice, split);
                  if (at === undefined) writeExplicit(from, target, choice, env, pages);
                }}>{choice.label}</button>
                {choice.detail && <span className="muted small"> · {choice.detail}</span>}
              </li>
            ))}
          </ul>
        </Modal>,
      );
    }
    ask(
      <Confirm title="Create this page?" action="Create page" message={<p>No page called <b>{target}</b> exists yet. Create <code>{hit.missing}</code>?</p>}
        onAnswer={(yes) => {
          ask(null);
          if (!yes) return;
          createMissingPage(from.notebook, hit.missing).then(() => {
            client.invalidateQueries({ queryKey: ["notebook-tree", from.notebook] });
            openPage({ notebook: from.notebook, path: hit.missing }, { split });
          }, (e) => toast(classify(e).message, "error"));
        }} />,
    );
  }, [client, from, pages, ask]);
}
