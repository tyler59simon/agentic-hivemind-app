import { reloadKey } from "../../lib/keys";
import { isMac } from "../../lib/platform";

export interface Key { type: string; key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }
export type KeyAction = "copy" | "paste" | "leave" | "search" | "newline" | "pass";

/** What the terminal does with a key before xterm sees it. F6 and Shift+F6 (the app's next and previous region) are not taken:
 *  programs in a terminal use F6 (htop sorts with it, Midnight Commander moves files), so the terminal passes it on and the
 *  way out of a terminal stays Ctrl+Shift+K ("leave"). */
export function keyAction(e: Key, hasSelection: boolean): KeyAction {
  if (e.type !== "keydown") return "pass";
  // On macOS only Cmd: Ctrl+C, Ctrl+V and the rest go to the program in the terminal.
  const mod = isMac ? e.metaKey && !e.ctrlKey && !e.altKey : (e.ctrlKey || e.metaKey) && !e.altKey;
  const key = e.key.toLowerCase();
  if (mod && e.shiftKey && key === "k") return "leave";
  if (mod && e.shiftKey && key === "f") return "search";
  if (mod && key === "c" && (hasSelection || e.shiftKey)) return "copy";
  if (mod && key === "v") return "paste";
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Enter") return "newline";
  return "pass";
}

export { reloadKey };

/** Whether the browser's own action for this key must be stopped. Never for AltGr (Ctrl+Alt) or for paste. F5 and Ctrl+R reload the page, so they are stopped too. */
export function swallow(e: Key): boolean {
  if (reloadKey(e)) return true;
  if (e.altKey && !e.ctrlKey && !e.metaKey) return e.key === "ArrowLeft";
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  return e.key.length === 1 && e.key.toLowerCase() !== "v";
}
