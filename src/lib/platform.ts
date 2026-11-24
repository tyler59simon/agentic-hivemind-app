// What differs on macOS in the webview (MACOS-1D): key names, file manager name, path rules, clipboard writes.
// Off macOS every helper keeps the behavior Hivemind had before.

/** True in WKWebView on macOS. Read once; tests set it through `setMacForTests`. */
export let isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

export function setMacForTests(value: boolean) {
  isMac = value;
}

/** The name of the system file manager, for "Show in …" menu items. */
export const fileManager = () => (isMac ? "Finder" : "Explorer");

/** The primary shortcut modifier as shown to the user. */
export const modKey = () => (isMac ? "Cmd" : "Ctrl");

/** The command modifier of a key event: Cmd on macOS (Ctrl+letter edits text there), Ctrl or the Windows key elsewhere. */
export const commandKey = (e: { ctrlKey: boolean; metaKey: boolean }) => (isMac ? e.metaKey : e.ctrlKey || e.metaKey);

/** A click that opens a link in an editor: Cmd+click with the main button on macOS, where Ctrl+click is a right click. */
export const linkClick = (e: { ctrlKey: boolean; metaKey: boolean; button: number }) =>
  isMac ? e.button === 0 && e.metaKey && !e.ctrlKey : e.ctrlKey || e.metaKey;

/** The folder part of an absolute path: up to the last `\` on Windows; on macOS up to the last `/` (`/` for a file at the
 *  root, "" when there is no `/`). A backslash is an ordinary character in a macOS name. */
export function parentFolder(path: string): string {
  if (!isMac) return path.slice(0, path.lastIndexOf("\\"));
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : at === 0 ? "/" : path.slice(0, at);
}

/** The last part of a path, by the same rules as `parentFolder`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf(isMac ? "/" : "\\") + 1);
}

/** `rel` (a `/`-separated notebook path) under the notebook folder `base`, as the system writes paths. */
export function joinPath(base: string, rel: string): string {
  if (!isMac) return `${base}\\${rel.replace(/\//g, "\\")}`;
  return `${base.replace(/\/+$/, "")}/${rel}`;
}

/** Whether a key event's target takes text, where the platform's own word and line keys must keep working. */
export function editableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .cm-editor, .xterm");
}

/** Put data that is still being made (`type`: "text/plain" or "image/png") on the clipboard. WKWebView allows a write
 *  only during the click that asked for it, so on macOS the write starts at once with a promise; elsewhere the data is
 *  awaited first, as before. A failure to make the data is reported before a failure to write. */
export async function copyLater(type: string, data: Promise<string | Blob>): Promise<void> {
  if (!isMac || typeof ClipboardItem === "undefined") {
    const value = await data;
    if (typeof value === "string") await navigator.clipboard.writeText(value);
    else await navigator.clipboard.write([new ClipboardItem({ [type]: value })]);
    return;
  }
  const [made, written] = await Promise.allSettled([data, navigator.clipboard.write([new ClipboardItem({ [type]: data })])]);
  if (made.status === "rejected") throw made.reason;
  if (written.status === "rejected") throw written.reason;
}
