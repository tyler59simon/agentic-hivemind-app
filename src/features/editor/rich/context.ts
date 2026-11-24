// What the rich page editor (NS-3A) asks of the page it edits. `FileTab` supplies it; memory notes never do, so their
// editor stays as it was.
import { Facet, StateEffect } from "@codemirror/state";
import type { FileFormat, Loaded, SaveOutcome, Stamp } from "../../../lib/notebooks";
import { documentIsDark } from "../../../lib/paper";

/** Pages longer than this (in characters, about 1 MB) keep the plain live preview, with a banner. */
export const RICH_LIMIT = 1_000_000;

/** A page an `![[embed]]` shows: its title, text and path in the notebook (its pictures are relative to its folder). */
export interface EmbedPage { title: string; text: string; path: string }

/** The files of the page's own notebook, for the embeds of a rich page (NS-3D). Every path is from the notebook's root.
 *  Absent for a page that is not in a folder notebook (a loose file). */
export interface NotebookFiles {
  /** Every file of the notebook, from its tree. */
  files: string[];
  /** The `hmfile` URL of a file under the page's grant (pictures and PDFs), or null before the grant is known. */
  url(path: string): string | null;
  read(path: string): Promise<Loaded>;
  create(path: string, text: string): Promise<Stamp>;
  save(path: string, text: string, pre: Stamp, format: FileFormat): Promise<SaveOutcome>;
  /** Move a file to the notebook's trash. */
  trash(path: string): Promise<unknown>;
}

export interface RichContext {
  /** The URL a picture source written in this page loads from, or null when it must not load or the page's picture
   *  grant is not known yet. A `wiki` source (`![[name.png]]`) names a file anywhere in the notebook. */
  pictureUrl(src: string, wiki: boolean): string | null;
  /** The page `![[target]]` names, or null when there is none. */
  readEmbed(target: string): Promise<EmbedPage | null>;
  /** Draw an embedded page's Markdown into `el`; returns the function that removes it. */
  renderEmbed(el: HTMLElement, page: EmbedPage, target: string): () => void;
  /** Open a `[[target]]`, in a split with `split`. */
  openPage(target: string, split: boolean): void;
  /** Open a link's destination: a web link in the browser, a relative page in a tab, an attachment in its program. */
  openHref(href: string, split: boolean): void;
  /** Save a picture as an attachment of the page; resolves to the Markdown that links it. Absent when the page takes
   *  no attachments (a loose file). */
  attach?: (bytes: Uint8Array, name: string) => Promise<string>;
  /** Attach the file at `index` of the drop `token` the same way. */
  attachDropped?: (token: string, index: number, name: string) => Promise<string>;
  /** Like `attach`, but resolves to the saved file's path from the notebook's root: a rich page's cover (NS-3C). */
  attachPath?: (bytes: Uint8Array, name: string) => Promise<string>;
  /** Like `attachDropped`, resolving to the path from the notebook's root. */
  attachDroppedPath?: (token: string, index: number, name: string) => Promise<string>;
  /** The page's notebook's files, for embeds (NS-3D). */
  notebook?: NotebookFiles;
  /** Tell the user something failed. */
  fail(message: string): void;
}

export const richContext = Facet.define<RichContext, RichContext | null>({ combine: (values) => values[0] ?? null });

/** Rebuild every rich decoration: the picture grant arrived, or the pages an embed can name changed. */
export const richRefresh = StateEffect.define<null>();

/** Whether diagrams are drawn in dark colours: where the editor is (a white pane is light under any theme). The editor
 *  supplies it, because only its element knows which pane it is in; without one it asks as for no element. */
export const richDark = Facet.define<() => boolean, () => boolean>({ combine: (values) => values[0] ?? (() => documentIsDark(null)) });

/** The colours the page is drawn in changed (the theme, or the pane's background): the diagrams draw again. */
export const richLook = StateEffect.define<null>();
