import { useWorkspace } from "../../workspace/store";

// The text of each untitled tab. A pane shows only its active tab, so the tab's view unmounts on every tab switch; the
// text lives here as long as the tab does (Codex review of 52051c8, D1).
const buffers = new Map<string, string>();

export const untitledText = (tabId: string) => buffers.get(tabId) ?? "";

export function setUntitledText(tabId: string, text: string) {
  if (text) buffers.set(tabId, text);
  else buffers.delete(tabId);
}

useWorkspace.subscribe((s) => {
  if (!buffers.size) return;
  const untitled = new Set(s.panes.flatMap((p) => p.tabs.filter((t) => t.kind === "new-file").map((t) => t.id)));
  for (const id of buffers.keys()) if (!untitled.has(id)) buffers.delete(id);
});
