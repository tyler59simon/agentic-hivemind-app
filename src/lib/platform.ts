// What differs on macOS in the webview (MACOS-1D): key names, file manager name, path separators.

/** True in WKWebView on macOS. Read once; tests set it through `setMacForTests`. */
export let isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

export function setMacForTests(value: boolean) {
  isMac = value;
}

/** The name of the system file manager, for "Show in …" menu items. */
export const fileManager = () => (isMac ? "Finder" : "Explorer");

/** The primary shortcut modifier as shown to the user. */
export const modKey = () => (isMac ? "Cmd" : "Ctrl");

/** The command modifier of a key or mouse event: Cmd on macOS (Ctrl+click there is a right click), Ctrl elsewhere,
 *  where Cmd (the Windows key) is also accepted as before. */
export const commandKey = (e: { ctrlKey: boolean; metaKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey || e.metaKey);

/** The folder part of an absolute path, whichever separator it uses; "" when there is none. */
export function parentFolder(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at > 0 ? path.slice(0, at) : "";
}

/** The last part of a path, whichever separator it uses. */
export function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/** `rel` (a `/`-separated notebook path) under `base`, written with the separator `base` uses. */
export function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${sep === "\\" ? rel.replace(/\//g, "\\") : rel}`;
}

/** Whether a key event's target takes text, where the platform's own word and line keys must keep working. */
export function editableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .cm-editor, .xterm");
}

/** Copy text that is still being fetched. WKWebView only lets a page write the clipboard in the click that asked for
 *  it, so the write starts now with a promise; elsewhere, or without ClipboardItem, the text is awaited first. */
export async function copyLater(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
    return;
  }
  await navigator.clipboard.writeText(await text);
}
