import { NoteMenu } from "../plans/NoteMenu";
import { NoteView } from "../viewer/NoteView";
import { useWorkspace, type Mode, type Tab } from "../../workspace/store";
import { NoteEditor } from "./NoteEditor";

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: "reading", label: "Read", hint: "Reading view" },
  { mode: "live", label: "Edit", hint: "Live preview editor (Ctrl+E)" },
  { mode: "source", label: "Source", hint: "Plain Markdown" },
];

/** A note tab: a mode switch and lifecycle menu over the reading view or the editor. */
export function NoteTab({ tab }: { tab: Tab }) {
  const updateTab = useWorkspace((s) => s.updateTab);
  const dirty = useWorkspace((s) => !!s.dirty[tab.id]);
  const mode = tab.mode ?? "reading";
  return (
    <div className="note-tab">
      <div className="note-toolbar">
        <div className="segmented compact" role="tablist" aria-label="View mode">
          {MODES.map((m) => (
            <button key={m.mode} role="tab" aria-selected={mode === m.mode} className={mode === m.mode ? "on" : ""} title={m.hint}
              onClick={() => updateTab(tab.id, { mode: m.mode })}>{m.label}</button>
          ))}
        </div>
        <span className="tabbar-fill" />
        <NoteMenu refId={tab.ref!} />
      </div>
      {mode === "reading" && dirty && (
        <div className="banner warn note-banner">This shows the saved note; your unsaved edits are kept as a draft.
          <div className="actions"><button onClick={() => updateTab(tab.id, { mode: "live" })}>Back to editing</button></div>
        </div>
      )}
      {mode === "reading" ? <NoteView refId={tab.ref!} tabId={tab.id} /> : <NoteEditor key={tab.ref} tab={tab} live={mode === "live"} />}
    </div>
  );
}
