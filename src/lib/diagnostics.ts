// "Copy diagnostics" and "Open logs folder" (DESK-LOGS). The text is built in Rust and leaves out note text.
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../ui/toast";
import { copyLater } from "./platform";

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Put the diagnostics block on the clipboard and say so. The clipboard write starts at once with the pending text, so it
 *  stays inside the click that asked for it (WKWebView refuses a write made after an await). */
export async function copyDiagnostics(): Promise<void> {
  try {
    await copyLater("text/plain", invoke<string>("diagnostics"));
    toast("Diagnostics copied");
  } catch (e) {
    toast(`Could not copy diagnostics: ${why(e)}`, "error");
  }
}

export async function openLogsFolder(): Promise<void> {
  try {
    await invoke("open_logs_folder");
  } catch (e) {
    toast(`Could not open the logs folder: ${why(e)}`, "error");
  }
}
