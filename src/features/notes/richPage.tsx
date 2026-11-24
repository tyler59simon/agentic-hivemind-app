// The rich editor's view of one notebook page (NS-3A): where its pictures load from, which page an `![[embed]]` names
// and how it draws, where a link leads, and how a pasted or dropped picture becomes an attachment.
import { openUrl } from "@tauri-apps/plugin-opener";
import { createRoot } from "react-dom/client";
import { useMemo } from "react";
import { attachBytes, attachDropped, readDoc } from "../../documents/io";
import type { FileRef } from "../../documents/keys";
import { keyOf, useDocuments } from "../../documents/store";
import { classify } from "../../lib/errors";
import { createFile, deleteFile, fileName, folderOf, isMarkdown, isNotebookPath, pageTitle, readFile, revealFile, saveFile } from "../../lib/notebooks";
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
  loose: boolean;
  /** Follow a `[[link]]` as the page does; `from` is an embedded page's path. */
  follow: (target: string, split: boolean, from?: string) => void;
  /** Whether the page can take a link now (not read-only or loading). */
  takesLink: () => boolean;
}

export function useRichPage(page: RichPage): RichContext {
  const { ref, files, base, loose, follow, takesLink } = page;
  return useMemo<RichContext>(() => {
    const folder = loose ? "" : folderOf(ref.path);
    /** The link to an attachment saved at `path` (from the notebook's root). */
    const linkTo = (path: string) => attachmentLink(relativePath(folder, path), fileName(path));
    const checked = () => { if (!takesLink()) throw new Error("this page cannot take a link now"); };
    return {
      pictureUrl: (src, wiki) => {
        if (!wiki) return pictureUrl(src, base, folder);
        const found = loose ? null : findFile(src, files);
        // The file the notebook lists is a literal name: `100% complete.png` must not be read as an escape (R1-18).
        return found ? pictureUrl(found.split("/").map(encodeURIComponent).join("/"), base, "") : null;
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
        root.render(<PageView text={embedded.text} tabId={`embed-${++embeds}`} onLink={(target, split) => follow(target, split, embedded.path)}
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
        revealFile(ref.notebook, path, true).catch((e) => toast(classify(e).message, "error"));
      },
      attach: loose ? undefined : async (bytes, name) => {
        checked();
        return linkTo(await attachBytes(ref.notebook, ref.path, name, bytes));
      },
      attachDropped: loose ? undefined : async (token, index) => {
        checked();
        return linkTo(await attachDropped(token, index, ref.notebook, ref.path));
      },
      attachPath: loose ? undefined : async (bytes, name) => {
        checked();
        return attachBytes(ref.notebook, ref.path, name, bytes);
      },
      attachDroppedPath: loose ? undefined : async (token, index) => {
        checked();
        return attachDropped(token, index, ref.notebook, ref.path);
      },
      // The page's own notebook, for the embeds of a rich page (NS-3D).
      notebook: loose ? undefined : {
        files,
        url: (path) => (base && isNotebookPath(path) ? pictureUrl(path.split("/").map(encodeURIComponent).join("/"), base, "") : null),
        read: (path) => readFile(ref.notebook, path),
        create: (path, text) => { checked(); return createFile(ref.notebook, path, text); },
        save: (path, text, pre, format) => { checked(); return saveFile(ref.notebook, path, text, pre, format); },
        trash: (path) => { checked(); return deleteFile(ref.notebook, path); },
      },
      fail: (message) => toast(message, "error"),
    };
  }, [ref, files, base, loose, follow, takesLink]);
}
