// Settings, Keyboard shortcuts (DESK-KEYS): one row per shortcut that can change, with a field that records the next key
// combination, a message when it clashes, and Reset. The editor, terminal and quick-capture keys are in the reference sheet.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { classify } from "../../lib/errors";
import {
  combo, comboOf, conflicts, defaultCombo, displacedBy, formatCombo, normalize, overrideCount, refreshCapture, resetShortcuts, saveShortcut, shortcut, SHORTCUTS,
  useShortcutVersion, usable, type Conflict, type Shortcut,
} from "../../lib/shortcuts";
import { useApp } from "../../store";
import { announce } from "../../ui/announce";
import { useShortcutsDialog } from "./ShortcutsDialog";

type Note = { kind: "error" | "warn"; text: string };

/** What happens to a key that an editor or terminal also uses, in words. The windows see a key in this order: the zoom keys
 *  (capture phase, so the editor or terminal never sees them), then the editor or terminal, then the app's own handlers. */
function warning(keys: string, c: Conflict, id: string): string {
  const where = c.kind === "editor" ? "in the editor" : "in a terminal";
  if (id.startsWith("zoom.")) return `${keys} also does "${c.with}" ${where}, but the app takes the key first, so it only zooms.`;
  // The workspace leaves Reading and editing to an editor that used the key.
  if (c.kind === "editor") return id === "view.mode" ? `${keys} also does "${c.with}" in the editor, and there the editor wins.` : `${keys} also does "${c.with}" in the editor, and both run there.`;
  // A terminal stops every key at its own element, so the app's handlers never run in it.
  return `${keys} also does "${c.with}" in a terminal, and there the terminal wins and this action does not run.`;
}

/** The message for a combo that clashes: reserved keys, the other app shortcuts and the Quick capture hotkey refuse it;
 *  editor and terminal keys only warn. */
function describe(candidate: string, id: string): Note | null {
  const found = conflicts(candidate, id);
  const keys = formatCombo(candidate);
  const refused = found.find((c) => c.refuse);
  if (refused?.kind === "reserved") return { kind: "error", text: `${keys} is reserved for the system and cannot be used.` };
  if (refused?.kind === "global") return { kind: "error", text: `${keys} is the Quick capture hotkey.` };
  if (refused) return { kind: "error", text: `${keys} is already used for "${refused.with}".` };
  if (found[0]) return { kind: "warn", text: warning(keys, found[0], id) };
  // A divider between split panes opens its width menu on this key while it has the focus.
  return normalize(candidate) === "Shift+F10" ? { kind: "warn", text: `${keys} also opens the width menu on a divider between panes, and there the divider wins.` } : null;
}

/** Rust refuses a combo another saved shortcut holds with `taken:<id>`; say it as a conflict. */
function problem(error: unknown, candidate: string | null): string {
  const message = classify(error).message;
  const holder = /^taken:(.+)$/.exec(message)?.[1];
  return holder ? `${candidate ? formatCombo(candidate) : "That key"} is already used for "${shortcut(holder)?.label ?? "another shortcut"}".` : message;
}

const keyId = (e: { code?: string; key: string }) => e.code || e.key;

function Row({ s }: { s: Shortcut }) {
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  // The key just recorded, until it is let go: it is swallowed so holding it does not run the new shortcut.
  const held = useRef<string | null>(null);
  const noteId = `shortcut-note-${s.id}`;
  const now = combo(s.id);
  const taken = displacedBy(s.id);
  const nowText = taken ? `Not set, taken by ${taken}` : formatCombo(now);
  const changed = normalize(now) !== normalize(defaultCombo(s.id));
  const refuse = (text: string) => { setNote({ kind: "error", text }); announce(text, "assertive"); };

  const record = (candidate: string, key: string) => {
    if (!usable(candidate)) { refuse("Use Ctrl, Alt or Cmd with a key, or a function key."); return; }
    const found = describe(candidate, s.id);
    if (found?.kind === "error") { refuse(found.text); return; }
    setRecording(false);
    held.current = key;
    // The default is kept as no override, so the file holds only what the user changed.
    const back = normalize(candidate) === normalize(defaultCombo(s.id));
    saveShortcut(s.id, back ? null : candidate).then(() => {
      setNote(found);
      announce(`${s.label} is now ${formatCombo(candidate)}.${found ? ` ${found.text}` : ""}`);
    }, (e) => refuse(problem(e, candidate)));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) {
      if (held.current === keyId(e.nativeEvent)) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    // Tab alone leaves the field, so the keyboard is never trapped here.
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) { setRecording(false); return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { setRecording(false); announce("Cancelled."); return; }
    const candidate = comboOf(e.nativeEvent);
    if (candidate) record(candidate, keyId(e.nativeEvent));
  };

  const reset = () => {
    // Another shortcut may have taken this one's default since.
    const taken = describe(defaultCombo(s.id), s.id);
    if (taken?.kind === "error") { refuse(`Not reset. ${taken.text}`); return; }
    saveShortcut(s.id, null).then(() => { setNote(null); announce(`${s.label} is back to ${formatCombo(defaultCombo(s.id))}.`); }, (e) => refuse(problem(e, defaultCombo(s.id))));
    button.current?.focus();
  };

  return (
    <li className="shortcut-row">
      <span className="grow">{s.label}</span>
      <button ref={button} type="button" className="shortcut-key" data-own-zoom-keys aria-describedby={note ? noteId : undefined}
        aria-label={recording ? `${s.label}: press the new keys, or Escape to cancel` : `${s.label}: ${nowText}. Press Enter to change`}
        // Safari and WebKit do not focus a button on click: the keys must go to this one.
        onClick={() => { button.current?.focus(); setNote(null); setRecording(true); announce("Press the new keys, or Escape to cancel."); }}
        onKeyDown={onKeyDown} onKeyUp={(e) => { if (held.current === keyId(e.nativeEvent)) held.current = null; }}
        onBlur={() => { setRecording(false); held.current = null; }}>
        {recording ? "Press the new keys…" : taken ? <span>{nowText}</span> : <kbd>{nowText}</kbd>}
      </button>
      <button type="button" onClick={reset} disabled={!changed} aria-label={`Reset ${s.label} to ${formatCombo(defaultCombo(s.id))}`}>Reset</button>
      {note && <p id={noteId} className={`${note.kind === "error" ? "error" : "muted"} small shortcut-note`}>{note.text}</p>}
    </li>
  );
}

export function ShortcutsSection() {
  useShortcutVersion();
  const showSheet = useShortcutsDialog((s) => s.show);
  const settings = useApp((s) => s.settings);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const groups = [...new Set(SHORTCUTS.filter((s) => s.remappable).map((s) => s.group))];
  // The Quick capture hotkey is a clash to check for, and Save in the form above may have changed it.
  useEffect(() => { void refreshCapture(); }, []);
  // A link that opened Settings at this section (the sheet's, the palette's) puts the focus on its heading.
  useEffect(() => { if (settings?.section === "shortcuts") heading.current?.focus({ preventScroll: true }); }, [settings]);
  const resetAll = () => resetShortcuts().then(
    () => { setError(null); announce("All shortcuts are back to their defaults."); heading.current?.focus({ preventScroll: true }); },
    (e) => { const text = classify(e).message; setError(text); announce(text, "assertive"); },
  );
  return (
    <section className="settings shortcuts" id="settings-shortcuts" aria-labelledby="shortcuts-title">
      <h3 id="shortcuts-title" ref={heading} tabIndex={-1}>Keyboard shortcuts</h3>
      <p className="muted small">Choose a key, press Enter, then press the new combination. Escape cancels. Changes take effect at once in every window and do not need Save.</p>
      {groups.map((group) => (
        <div key={group} role="group" aria-label={group}>
          <h4>{group}</h4>
          <ul className="shortcut-rows">{SHORTCUTS.filter((s) => s.remappable && s.group === group).map((s) => <Row key={s.id} s={s} />)}</ul>
        </div>
      ))}
      <div className="actions">
        <button type="button" disabled={overrideCount() === 0} onClick={() => void resetAll()}>Reset all</button>
        <button type="button" onClick={() => showSheet()}>Show every shortcut</button>
      </div>
      {error && <p className="error small">{error}</p>}
      <p className="muted small">The editor, terminal and a few fixed keys cannot be changed; the sheet lists them. The quick-capture hotkey is set under Quick capture above.</p>
    </section>
  );
}
