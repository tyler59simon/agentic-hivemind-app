// The window title (DESK-9): what the window shows, most specific first, so the taskbar, Alt+Tab and screen readers name
// the open page. A dot marks unsaved edits in the open tab, and the words "(unsaved)" say it for a screen reader.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { inTauri } from "../lib/native";

export const APP_NAME = "Hivemind";

/** "● Plan (unsaved) - Notebook - Notes - PayStream - Hivemind" from the breadcrumb labels, root first. */
export function windowTitle(labels: string[], unsaved: boolean): string {
  const parts: string[] = [];
  for (const label of [...labels].reverse()) {
    const text = label.trim();
    if (text && text !== "Projects" && !parts.includes(text)) parts.push(text);
  }
  parts.push(APP_NAME);
  if (unsaved) parts[0] += " (unsaved)";
  return `${unsaved ? "● " : ""}${parts.join(" - ")}`;
}

let shown = "";

/** Keep this window's title in step; the native call is made only when the text changes. */
export function useWindowTitle(labels: string[], unsaved: boolean): void {
  const title = windowTitle(labels, unsaved);
  useEffect(() => {
    if (title === shown) return;
    shown = title;
    document.title = title;
    if (inTauri()) getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [title]);
}
