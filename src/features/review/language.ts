import { LanguageDescription, type LanguageSupport } from "@codemirror/language";

/** The CodeMirror language for a file name, or null. The language list and each grammar are their own chunks,
 *  fetched the first time a diff of that kind is opened. Never import `@codemirror/language-data` statically. */
export async function loadLanguage(path: string): Promise<LanguageSupport | null> {
  try {
    const { languages } = await import("@codemirror/language-data");
    const found = LanguageDescription.matchFilename(languages, path.split("/").pop() ?? path);
    return found ? await found.load() : null;
  } catch {
    return null;
  }
}
