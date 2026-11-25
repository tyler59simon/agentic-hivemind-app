// A small reader of src/App.css for the tests that check CSS (jsdom has no layout, and vitest empties CSS imports, so the file is read as text).
// @ts-expect-error no @types/node package (as in vite.config.ts)
import { readFileSync } from "node:fs";

export type Rule = { selectors: string[]; decls: Map<string, string>; media: string; text: string };

/** App.css as written, with LF line ends. */
export const rawCss = (): string => (readFileSync(new URL("../App.css", import.meta.url), "utf8") as string).replace(/\r\n/g, "\n");

/** App.css without its comments. */
export const appCss = (): string => rawCss().replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule of a style sheet, with the media query it is inside ("" for none). @keyframes and other at-rules are skipped. A selector
 *  list is split at commas, so a comma inside :not() or :is() is not supported. */
export function parseCss(text: string, media = ""): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (depth && j < text.length) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
    const head = text.slice(i, open).trim();
    const body = text.slice(open + 1, j - 1);
    if (head.startsWith("@media")) out.push(...parseCss(body, head));
    else if (!head.startsWith("@")) {
      const decls = new Map<string, string>();
      for (const d of body.split(";")) { const k = d.indexOf(":"); if (k > 0) decls.set(d.slice(0, k).trim(), d.slice(k + 1).replace("!important", "").trim()); }
      out.push({ selectors: head.split(",").map((s) => s.trim()), decls, media, text: body });
    }
    i = j;
  }
  return out;
}
