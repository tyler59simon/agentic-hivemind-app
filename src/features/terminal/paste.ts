import type { Engine } from "../../lib/agent";
import { isMac } from "../../lib/platform";

/** What a paste event does: "xterm" lets xterm paste the text as before, `{ send }` writes the CLI's own
 *  image-paste key (the CLI reads the system clipboard itself), `null` does nothing. */
export type PasteAction = "xterm" | { send: string } | null;

export function pasteAction(hasText: boolean, engine: Engine | null): PasteAction {
  if (hasText) return "xterm";
  // Claude Code pastes an image with Alt+V on Windows and Ctrl+V on macOS.
  if (engine === "claude") return { send: isMac ? "\x16" : "\x1bv" };
  if (engine === "codex") return { send: "\x16" };
  return null;
}
