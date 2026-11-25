// "Copy diagnostics" and "Open logs folder" (DESK-LOGS), and "Report a problem" (DESK-HELP). The text is built in Rust and leaves out note text.
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../ui/toast";
import { copyLater } from "./platform";

/** What `app_info` returns: the versions and the folders the app keeps its own files in. */
export interface AppInfo {
  version: string; tauri: string; webviewEngine: string; webview: string; os: string; arch: string; osVersion: string | null;
  dataDir: string; configDir: string; logDir: string;
}
export const appInfo = () => invoke<AppInfo>("app_info");

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Put the diagnostics block on the clipboard; resolves to why it failed, or null. The clipboard write starts at once with
 *  the pending text, so it stays inside the click that asked for it (WKWebView refuses a write made after an await). */
async function copy(): Promise<string | null> {
  try {
    await copyLater("text/plain", invoke<string>("diagnostics"));
    return null;
  } catch (e) {
    return why(e);
  }
}

/** Put the diagnostics block on the clipboard and say so. */
export async function copyDiagnostics(): Promise<void> {
  const failed = await copy();
  if (failed === null) toast("Diagnostics copied");
  else toast(`Could not copy diagnostics: ${failed}`, "error");
}

/** Copy the diagnostics, then open the repository's New issue page (the address is fixed in Rust; only whether the copy
 *  worked is passed, so the page asks to paste only when there is something to paste). The page opens even when the copy
 *  failed, and the toast says which happened. Nothing is sent. */
export async function reportProblem(): Promise<void> {
  const failed = await copy();
  try {
    await invoke("open_issue_page", { withDiagnostics: failed === null });
  } catch (e) {
    toast(failed === null ? `Diagnostics copied, but could not open the issue page: ${why(e)}` : `Could not copy diagnostics (${failed}) or open the issue page: ${why(e)}`, "error");
    return;
  }
  if (failed === null) toast("Diagnostics copied. Paste them into the new issue.");
  else toast(`Could not copy diagnostics (${failed}). The issue page is open without them: Copy diagnostics from the command palette and paste them in.`, "error");
}

export async function openLogsFolder(): Promise<void> {
  try {
    await invoke("open_logs_folder");
  } catch (e) {
    toast(`Could not open the logs folder: ${why(e)}`, "error");
  }
}
