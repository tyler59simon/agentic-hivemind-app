// "Copy diagnostics" and "Open logs folder" (DESK-LOGS). The text is built in Rust and leaves out note text.
import { invoke } from "@tauri-apps/api/core";
import { toast } from "../ui/toast";

/** Put the diagnostics block on the clipboard and say so. */
export async function copyDiagnostics(): Promise<void> {
  try {
    await navigator.clipboard.writeText(await invoke<string>("diagnostics"));
    toast("Diagnostics copied");
  } catch (e) {
    toast(`Could not copy diagnostics: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

export async function openLogsFolder(): Promise<void> {
  try {
    await invoke("open_logs_folder");
  } catch (e) {
    toast(`Could not open the logs folder: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
