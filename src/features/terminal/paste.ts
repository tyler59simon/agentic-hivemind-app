import type { Engine } from "../../lib/agent";

/** What a paste event does: "xterm" lets xterm paste the text as before, `{ send }` writes the CLI's own
 *  image-paste key (the CLI reads the Windows clipboard itself), `null` does nothing. */
export type PasteAction = "xterm" | { send: string } | null;

export function pasteAction(hasText: boolean, engine: Engine | null): PasteAction {
  if (hasText) return "xterm";
  if (engine === "claude") return { send: "\x1bv" };
  if (engine === "codex") return { send: "\x16" };
  return null;
}
