// The rich editor's view of one notebook page (NS-3A): where its pictures load from, which page an `![[embed]]` names
// and how it draws, where a link leads, and how a pasted or dropped picture becomes an attachment.
import { openUrl } from "@tauri-apps/plugin-opener";
import { createRoot } from "react-dom/client";
import { useMemo } from "react";
import { openAttachment } from "../../documents/adapters/lmdoc";
import { attachBytes, attachDropped, readDoc } from "../../documents/io";
import type { FileRef } from "../../documents/keys";
import { keyOf, useDocuments } from "../../documents/store";
import { classify } from "../../lib/errors";
import { fileName, folderOf, isMarkdown, pageTitle, revealFile } from "../../lib/notebooks";
import { toast } from "../../ui/toast";
import type { RichContext } from "../editor/rich/context";
import { attachmentLink, relativePath } from "../editor/rich/parse";
import { resolvePage } from "../links/resolve";
import { openPage } from "./actions";
import { PageView } from "./PageView";
import { findFile, pictureUrl, relativeTarget } from "./pictures";

let embeds = 0;

export interface RichPage {
  ref: FileRef;
  /** The notebook's files, from its tree. */
  files: string[];
  /** The page's picture grant prefix, once known. */
  base?: string;
  lm: boolean;
  loose: boolean;
  /** Follow a `[[link]]` as the page does. */
  follow: (target: string, split: boolean) => void;
  /** Whether the page can take a link now (not read-only, loading or in another store). */
  takesLink: () => boolean;
}

export function useRichPage(page: RichPage): RichContext {
  const { ref, files, base, lm, loose, follow, takesLink } = page;
  return useMemo<RichContext>(() => {
    const folder = loose ? "" : folderOf(ref.path);
    /** The link to an attachment saved at `path` (from the notebook's root). */
    const linkTo = (path: string) => {
      // Living Memory names an asset `<sha8>-<name>`; the link shows the name.
      const name = lm ? fileName(path).replace(/^[0-9a-f]{8}-/, "") : fileName(path);
      return attachmentLink(relativePath(folder, path), name);
    };
    const checked = () => { if (!takesLink()) throw new Error("this page cannot take a link now"); };
    return {
      pictureUrl: (src, wiki) => {
        if (!wiki) return pictureUrl(src, base, folder);
        const found = loose ? null : findFile(src, files);
        return found ? pictureUrl(found, base, "") : null;
      },
      readEmbed: async (target) => {
        if (loose) return null;
        const hit = resolvePage(target, ref, files.filter(isMarkdown));
        if (!("ref" in hit)) return null;
        // A page open in a tab shows as it is there, unsaved edits included.
        const open = useDocuments.getState().docs[keyOf(hit.ref)];
        const text = open && open.status !== "loading" && open.status !== "error" ? open.text : (await readDoc(hit.ref)).text;
        return { title: pageTitle(hit.ref.path), text, path: hit.ref.path };
      },
      renderEmbed: (el, embedded) => {
        const root = createRoot(el);
        root.render(<PageView text={embedded.text} tabId={`embed-${++embeds}`} onLink={follow}
          onFile={lm ? (path) => void openAttachment(ref.notebook, path).catch((e) => toast(classify(e).message, "error")) : undefined}
          pictures={{ base, folder: folderOf(embedded.path), files }} nested />);
        // Unmounted after the editor's own update, never in the middle of a render.
        return () => queueMicrotask(() => root.unmount());
      },
      openPage: follow,
      openHref: (href, split) => {
        if (/^https?:/i.test(href) || /^mailto:/i.test(href)) { openUrl(href).catch(() => undefined); return; }
        const path = loose ? null : relativeTarget(href, folder);
        if (!path) { toast(`Hivemind does not open ${href} from here.`, "warn"); return; }
        if (isMarkdown(path)) { openPage({ notebook: ref.notebook, path }, { split }); return; }
        const opened = lm ? openAttachment(ref.notebook, path) : revealFile(ref.notebook, path, true);
        opened.catch((e) => toast(classify(e).message, "error"));
      },
      attach: loose ? undefined : async (bytes, name) => {
        checked();
        return linkTo(await attachBytes(ref.notebook, ref.path, name, bytes));
      },
      attachDropped: loose ? undefined : async (token, index) => {
        checked();
        return linkTo(await attachDropped(token, index, ref.notebook, ref.path));
      },
      fail: (message) => toast(message, "error"),
    };
  }, [ref, files, base, lm, loose, follow, takesLink]);
}
