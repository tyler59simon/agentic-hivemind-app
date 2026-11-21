// The rich page editor (NS-3A), assembled for `CodeEditor`: the Markdown language with the extra syntax and code-fence
// languages, the editing helpers that work in Live and Source (paste, Ctrl+click on links, bold and italic keys), and
// the preview that renders blocks and inline marks in Live.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { toolbarKeys } from "../toolbar";
import { pastePictures } from "./attach";
import { richBlocks } from "./blocks";
import { richContext, type RichContext } from "./context";
import { richInline, richLinks } from "./inline";
import { richSyntax } from "./syntax";

export { RICH_LIMIT, richRefresh, type RichContext } from "./context";
export { dropPictures } from "./attach";
export { slashSource } from "./slash";

/** Markdown with highlights, comments and math, and code fences highlighted by their language (loaded on demand). */
export const richLanguage = () => markdown({ base: markdownLanguage, extensions: [richSyntax], codeLanguages: languages });

/** What a page gets in both Live and Source. */
export function richEditing(ctx: RichContext): Extension[] {
  return [
    richContext.of(ctx),
    richLinks,
    Prec.high(keymap.of(toolbarKeys)),
    EditorView.domEventHandlers({
      paste: (e, view) => {
        if (!pastePictures(view, ctx, e.clipboardData)) return false;
        e.preventDefault();
        return true;
      },
    }),
  ];
}

/** What Live adds: rendered blocks and inline marks. */
export const richPreview: Extension = [richBlocks, richInline];
