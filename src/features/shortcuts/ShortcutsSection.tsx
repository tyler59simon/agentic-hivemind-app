// Settings, Keyboard shortcuts (DESK-KEYS): one row per shortcut that can change, with a field that records the next key
// combination, a message when it clashes, and Reset. The editor, terminal and quick-capture keys are in the reference sheet.
import { useRef, useState, type KeyboardEvent } from "react";
import { classify } from "../../lib/errors";
import { combo, comboOf, conflicts, defaultCombo, formatCombo, normalize, overrideCount, resetShortcuts, saveShortcut, SHORTCUTS, useShortcutVersion, usable, type Shortcut } from "../../lib/shortcuts";
import { announce } from "../../ui/announce";
import { useShortcutsDialog } from "./ShortcutsDialog";

type Note = { kind: "error" | "warn"; text: string };

/** The message for a combo that clashes: reserved and app keys refuse it, editor and terminal keys only warn. */
function describe(candidate: string, id: string): Note | null {
  const found = conflicts(candidate, id);
  const keys = formatCombo(candidate);
  const refused = found.find((c) => c.refuse);
  if (refused) return { kind: "error", text: refused.kind === "reserved" ? `${keys} is reserved for the system and cannot be used.` : `${keys} is already used for "${refused.with}".` };
  const warn = found[0];
  return warn ? { kind: "warn", text: `${keys} also does "${warn.with}" ${warn.kind === "editor" ? "in the editor" : "in a terminal"}, and the key will do both there.` } : null;
}

function Row({ s }: { s: Shortcut }) {
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const noteId = `shortcut-note-${s.id}`;
  const now = combo(s.id);
  const changed = normalize(now) !== normalize(defaultCombo(s.id));
  const refuse = (text: string) => { setNote({ kind: "error", text }); announce(text, "assertive"); };

  const record = (candidate: string) => {
    if (!usable(candidate)) { refuse("Use Ctrl, Alt or Cmd with a key, or a function key."); return; }
    const found = describe(candidate, s.id);
    if (found?.kind === "error") { refuse(found.text); return; }
    setRecording(false);
    // The default is kept as no override, so the file holds only what the user changed.
    const back = normalize(candidate) === normalize(defaultCombo(s.id));
    saveShortcut(s.id, back ? null : candidate).then(() => {
      setNote(found);
      announce(`${s.label} is now ${formatCombo(candidate)}.${found ? ` ${found.text}` : ""}`);
    }, (e) => refuse(classify(e).message));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    // Tab alone leaves the field, so the keyboard is never trapped here.
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) { setRecording(false); return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { setRecording(false); announce("Cancelled."); return; }
    const candidate = comboOf(e.nativeEvent);
    if (candidate) record(candidate);
  };

  const reset = () => {
    saveShortcut(s.id, null).then(() => { setNote(null); announce(`${s.label} is back to ${formatCombo(defaultCombo(s.id))}.`); }, (e) => refuse(classify(e).message));
    button.current?.focus();
  };

  return (
    <li className="shortcut-row">
      <span className="grow">{s.label}</span>
      <button ref={button} type="button" className="shortcut-key" data-own-zoom-keys aria-describedby={note ? noteId : undefined}
        aria-label={recording ? `${s.label}: press the new keys, or Escape to cancel` : `${s.label}: ${formatCombo(now)}. Press Enter to change`}
        onClick={() => { setNote(null); setRecording(true); announce("Press the new keys, or Escape to cancel."); }}
        onKeyDown={onKeyDown} onBlur={() => setRecording(false)}>
        {recording ? "Press the new keys…" : <kbd>{formatCombo(now)}</kbd>}
      </button>
      <button type="button" onClick={reset} disabled={!changed} aria-label={`Reset ${s.label} to ${formatCombo(defaultCombo(s.id))}`}>Reset</button>
      {note && <p id={noteId} className={`${note.kind === "error" ? "error" : "muted"} small shortcut-note`}>{note.text}</p>}
    </li>
  );
}

export function ShortcutsSection() {
  useShortcutVersion();
  const showSheet = useShortcutsDialog((s) => s.show);
  const [error, setError] = useState<string | null>(null);
  const groups = [...new Set(SHORTCUTS.filter((s) => s.remappable).map((s) => s.group))];
  return (
    <section className="settings shortcuts" id="settings-shortcuts" aria-labelledby="shortcuts-title">
      <h3 id="shortcuts-title">Keyboard shortcuts</h3>
      <p className="muted small">Choose a key, press Enter, then press the new combination. Escape cancels. Changes take effect at once in every window and do not need Save.</p>
      {groups.map((group) => (
        <div key={group} role="group" aria-label={group}>
          <h4>{group}</h4>
          <ul className="shortcut-rows">{SHORTCUTS.filter((s) => s.remappable && s.group === group).map((s) => <Row key={s.id} s={s} />)}</ul>
        </div>
      ))}
      <div className="actions">
        <button type="button" disabled={overrideCount() === 0}
          onClick={() => resetShortcuts().then(() => { setError(null); announce("All shortcuts are back to their defaults."); }, (e) => setError(classify(e).message))}>Reset all</button>
        <button type="button" onClick={showSheet}>Show every shortcut</button>
      </div>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">The editor, terminal and a few fixed keys cannot be changed; the sheet lists them. The quick-capture hotkey is set under Quick capture above.</p>
    </section>
  );
}
