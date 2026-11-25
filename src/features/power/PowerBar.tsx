// The strip above a text file's editor (NS-6A): line tools and macros. Both act on the editor of the tab.
import type { EditorView } from "@codemirror/view";
import { ArrowDownAZ, Bookmark, Circle, Pilcrow, Play, Square, WrapText } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Menu } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { bookmarkedLinesText, clearBookmarks, deleteBookmarkedLines, nextBookmark, prevBookmark, toggleBookmark } from "./bookmarks";
import { LINE_TOOLS, runLineTool, type LineTool } from "./lineTools";
import { cancelPlayback, deleteMacro, loadMacros, playMacro, saveMacro, toggleRecording, useRecorder, type Step, type Target } from "./macros";

/** Line tools, by group, for the menu here and the command palette. */
export const TOOL_GROUPS = LINE_TOOLS.reduce<{ group: LineTool["group"]; tools: LineTool[] }[]>((groups, tool) => {
  const found = groups.find((g) => g.group === tool.group);
  if (found) found.tools.push(tool);
  else groups.push({ group: tool.group, tools: [tool] });
  return groups;
}, []);

/** A function that runs a tool on the editor and gives it its focus back; it says when the tool did nothing. */
export function toolRunner(view: () => EditorView | null) {
  return (tool: LineTool) => {
    const v = view();
    if (!v) return;
    if (v.state.readOnly) toast("This file is read-only.", "warn");
    else if (!runLineTool(v, tool)) toast(`${tool.label}: nothing to change.`);
    v.focus();
  };
}

/** Ask for a number or a name, then call `onDone`. */
function Ask({ title, label, initial, type, action, onDone, onClose }: {
  title: string; label: string; initial: string; type: "number" | "text"; action: string; onDone: (value: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = (e: FormEvent) => { e.preventDefault(); onDone(value); };
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <label>{label}
          <input autoFocus type={type} value={value} min={type === "number" ? 1 : undefined} onChange={(e) => setValue(e.target.value)} />
        </label>
        <div className="actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" type="submit">{action}</button></div>
      </form>
    </Modal>
  );
}

export interface PowerBarProps {
  view: () => EditorView | null;
  readOnly: boolean;
  wrap?: boolean;
  onToggleWrap?: () => void;
  whitespace?: boolean;
  onToggleWhitespace?: () => void;
}

export function PowerBar({ view, readOnly, wrap, onToggleWrap, whitespace, onToggleWhitespace }: PowerBarProps) {
  const run = toolRunner(view);
  const recording = useRecorder((s) => s.recording);
  const playing = useRecorder((s) => s.playing);
  const runs = useRecorder((s) => s.runs);
  const steps = useRecorder((s) => s.steps);
  const [asking, setAsking] = useState<"times" | "save" | null>(null);
  const [saved, setSaved] = useState(loadMacros);

  const play = (list: Step[], times: number | "end") => {
    const v = view();
    if (!v || !list.length) return;
    if (v.state.readOnly) { toast("This file is read-only.", "warn"); return; }
    void playMacro(v as unknown as Target, list, times).then((runs) => {
      if (times === "end") toast(`Played to the end of the file: ${runs} ${runs === 1 ? "run" : "runs"}.`);
      else if (runs < times) toast(`Stopped after ${runs} of ${times} runs.`);
      v.focus();
    }, (e) => toast(String(e instanceof Error ? e.message : e), "warn"));
  };
  const canPlay = !readOnly && !recording && !playing && steps.length > 0;
  const keep = (name: string) => {
    const done = saveMacro(name, steps);
    if (!done.ok) { toast(done.error, "warn"); return; }
    setSaved(done.macros);
    setAsking(null);
    toast(`Saved the macro "${name.trim()}".`);
  };

  const copyOrCutBookmarked = (cut: boolean) => {
    const v = view();
    if (!v) return;
    if (cut && v.state.readOnly) { toast("This file is read-only.", "warn"); return; }
    const text = bookmarkedLinesText(v.state);
    if (text === null) { toast("No bookmarked lines."); return; }
    void navigator.clipboard.writeText(text).then(
      () => {
        if (cut) {
          const n = deleteBookmarkedLines(v);
          toast(`Cut ${n} bookmarked ${n === 1 ? "line" : "lines"}.`);
        } else {
          toast("Copied bookmarked lines.");
        }
        v.focus();
      },
      () => toast("Could not write to clipboard.", "error"),
    );
  };

  return (
    <div className="power-bar" role="toolbar" aria-label="Line tools and macros">
      <Menu label="Line tools" buttonLabel={null} align="left" button={<><ArrowDownAZ size="1.1em" aria-hidden />Lines</>} className="power-menu">
        {(close) => (
          <>
            {TOOL_GROUPS.map((g) => (
              <li key={g.group} role="none">
                <div className="menu-group muted">{g.group}</div>
                <ul>{g.tools.map((t) => (
                  <li key={t.id}><button role="menuitem" disabled={readOnly} onClick={() => { close(); run(t); }}>{t.label}</button></li>
                ))}</ul>
              </li>
            ))}
          </>
        )}
      </Menu>
      <Menu label="Bookmarks" buttonLabel={null} align="left" button={<><Bookmark size="1em" aria-hidden />Bookmarks</>} className="power-menu">
        {(close) => (
          <>
            <li><button role="menuitem" onClick={() => { close(); const v = view(); if (v) { toggleBookmark(v); v.focus(); } }}>Toggle bookmark (Ctrl+F2)</button></li>
            <li><button role="menuitem" onClick={() => { close(); const v = view(); if (v) { if (!nextBookmark(v)) toast("No bookmarks."); v.focus(); } }}>Next bookmark (F2)</button></li>
            <li><button role="menuitem" onClick={() => { close(); const v = view(); if (v) { if (!prevBookmark(v)) toast("No bookmarks."); v.focus(); } }}>Previous bookmark (Shift+F2)</button></li>
            <li><button role="menuitem" onClick={() => { close(); copyOrCutBookmarked(false); }}>Copy bookmarked lines</button></li>
            <li><button role="menuitem" disabled={readOnly} onClick={() => { close(); copyOrCutBookmarked(true); }}>Cut bookmarked lines</button></li>
            <li><button role="menuitem" disabled={readOnly} onClick={() => { close(); const v = view(); if (v) { const n = deleteBookmarkedLines(v); toast(n ? `Deleted ${n} bookmarked ${n === 1 ? "line" : "lines"}.` : "No bookmarked lines."); v.focus(); } }}>Delete bookmarked lines</button></li>
            <li><button role="menuitem" onClick={() => { close(); const v = view(); if (v) { clearBookmarks(v); v.focus(); } }}>Clear all bookmarks</button></li>
          </>
        )}
      </Menu>
      {onToggleWrap && (
        <button type="button" className={`icon-button${wrap ? " on" : ""}`} aria-pressed={!!wrap} onClick={onToggleWrap} title="Toggle word wrap (Alt+Z)">
          <WrapText size="1em" aria-hidden />Wrap
        </button>
      )}
      {onToggleWhitespace && (
        <button type="button" className={`icon-button${whitespace ? " on" : ""}`} aria-pressed={!!whitespace} onClick={onToggleWhitespace} title="Show whitespace characters">
          <Pilcrow size="1em" aria-hidden />Whitespace
        </button>
      )}
      <span className="power-sep" aria-hidden />
      {recording
        ? <button className="icon-button recording" onClick={toggleRecording} title="Stop recording (Ctrl+Shift+R)" aria-label="Stop recording"><Square size="1em" aria-hidden />Stop</button>
        : <button className="icon-button" onClick={toggleRecording} disabled={readOnly || playing} title="Record a macro (Ctrl+Shift+R)" aria-label="Record macro"><Circle size="1em" aria-hidden />Record</button>}
      <button className="icon-button" onClick={() => play(steps, 1)} disabled={!canPlay} title="Play the last macro (Ctrl+Shift+P)" aria-label="Play macro"><Play size="1em" aria-hidden />Play</button>
      <Menu label="More macro actions" buttonLabel={null} align="left" button="Macro" className="power-menu">
        {(close) => (
          <>
            <li><button role="menuitem" disabled={!canPlay} onClick={() => { close(); setAsking("times"); }}>Play several times…</button></li>
            <li><button role="menuitem" disabled={!canPlay} onClick={() => { close(); play(steps, "end"); }}>Play to the end of the file</button></li>
            <li><button role="menuitem" disabled={recording || playing || !steps.length} onClick={() => { close(); setAsking("save"); }}>Save this macro…</button></li>
            {saved.length > 0 && <li role="none"><div className="menu-group muted">Saved macros</div></li>}
            {saved.map((m) => (
              <li key={m.name} className="saved-macro">
                <button role="menuitem" disabled={readOnly || recording || playing} onClick={() => { close(); play(m.steps, 1); }}>{m.name}</button>
                <button className="icon-button" aria-label={`Delete the macro ${m.name}`} title="Delete" onClick={() => { const d = deleteMacro(m.name); if (d.ok) setSaved(d.macros); else toast(d.error, "warn"); }}>×</button>
              </li>
            ))}
          </>
        )}
      </Menu>
      {recording && <span className="muted small" role="status">Recording: {steps.length} {steps.length === 1 ? "step" : "steps"}. Mouse actions are not recorded.</span>}
      {playing && <span className="muted small" role="status">Playing: {runs} runs. <button className="link" onClick={cancelPlayback}>Stop</button> (Esc)</span>}
      {asking === "times" && (
        <Ask title="Play the macro" label="Number of times" type="number" initial="10" action="Play" onClose={() => setAsking(null)}
          onDone={(v) => { const n = Math.floor(Number(v)); if (!(n >= 1)) { toast("Enter a whole number of 1 or more.", "warn"); return; } setAsking(null); play(steps, n); }} />
      )}
      {asking === "save" && <Ask title="Save the macro" label="Name" type="text" initial={`Macro ${saved.length + 1}`} action="Save" onClose={() => setAsking(null)} onDone={keep} />}
    </div>
  );
}
