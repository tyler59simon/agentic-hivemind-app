// Keys the whole app treats the same way in every window (DESK-2).

export interface KeyLike { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }

/** F5 (any modifiers), Ctrl+R and Ctrl+Shift+R (Ctrl or Meta, no Alt): the keys that reload the page. */
export function reloadKey(e: KeyLike): boolean {
  if (e.key === "F5") return true;
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "r";
}

/** Ctrl+P (Ctrl or Meta, no Shift or Alt): the webview prints when the page does not take the key itself (DESKRUN-P1). */
export function browserOnlyKey(e: KeyLike): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "p";
}

/** Keep the webview's print dialog from opening over the app: on the Settings screen no app shortcut takes Ctrl+P, and
 *  after the palette is moved off Ctrl+P nothing does. Bubble phase, and only when no one prevented the key yet: the
 *  editors and the app's own handlers see it first, and some of them skip a key whose default is already prevented. */
export function guardBrowserKeys(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => { if (!e.defaultPrevented && browserOnlyKey(e)) e.preventDefault(); };
  target.addEventListener("keydown", onKey);
  return () => target.removeEventListener("keydown", onKey);
}

/** Stop the webview reloading itself, which would drop every open dialog and unsaved view state. Development builds keep
 *  reload. Capture phase, so it runs before any handler that stops the event. */
export function guardReload(target: Window = window, dev = import.meta.env.DEV): () => void {
  const onKey = (e: KeyboardEvent) => { if (!dev && reloadKey(e)) e.preventDefault(); };
  target.addEventListener("keydown", onKey, true);
  return () => target.removeEventListener("keydown", onKey, true);
}
