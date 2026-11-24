import { reloadKey } from "../../lib/keys";

export interface Key { type: string; key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }
export type KeyAction = "copy" | "paste" | "leave" | "search" | "newline" | "pass";

/** What the terminal does with a key before xterm sees it. */
export function keyAction(e: Key, hasSelection: boolean): KeyAction {
  if (e.type !== "keydown") return "pass";
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
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
