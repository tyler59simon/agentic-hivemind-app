// Keys the whole app treats the same way in every window (DESK-2).

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** F5 (any modifiers), Ctrl+R and Ctrl+Shift+R (Ctrl or Meta, no Alt): the keys that reload the page. */
export function reloadKey(e: KeyLike): boolean {
  if (e.key === "F5") return true;
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "r";
}

/** Stop the webview reloading itself, which would drop every open dialog and unsaved view state. Development builds keep
 *  reload. Capture phase, so it runs before any handler that stops the event. */
export function guardReload(target: Window = window, dev = import.meta.env.DEV): () => void {
  const onKey = (e: KeyboardEvent) => { if (!dev && reloadKey(e)) e.preventDefault(); };
  target.addEventListener("keydown", onKey, true);
  return () => target.removeEventListener("keydown", onKey, true);
}
