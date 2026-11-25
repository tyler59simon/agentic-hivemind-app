// The keyboard shortcut reference sheet (DESK-KEYS): every shortcut in the registry by group, with a filter. Ctrl+/ and the
// palette's "Keyboard shortcuts" open it.
import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import { captureStatus } from "../../lib/lm";
import { combo, defaultCombo, formatCombo, fromAccelerator, normalize, SHORTCUTS, useShortcutVersion, type Shortcut } from "../../lib/shortcuts";
import { openSettings } from "../../store";
import { Modal } from "../../ui/Modal";

interface DialogState { open: boolean; show: () => void; hide: () => void }
export const useShortcutsDialog = create<DialogState>((set) => ({ open: false, show: () => set({ open: true }), hide: () => set({ open: false }) }));

const WHERE: Partial<Record<Shortcut["scope"], string>> = { editor: "in the editor", terminal: "in a terminal", global: "from anywhere" };

/** The keys to show for a shortcut. The quick-capture hotkey is the one the app registered (`accelerator`: null when it is
 *  off, undefined until read); the rest come from the registry. */
export function shown(s: Shortcut, accelerator?: string | null): string {
  if (s.scope === "global") return accelerator === undefined ? formatCombo(defaultCombo(s.id)) : accelerator ? formatCombo(fromAccelerator(accelerator)) : "Off";
  return formatCombo(combo(s.id));
}

/** Whether a shortcut matches every word of the filter, in its name, group or keys. */
export function matchesFilter(s: Shortcut, text: string, keys: string): boolean {
  const hay = `${s.label} ${s.group} ${keys}`.toLowerCase().replace(/\+/g, " ");
  return text.toLowerCase().replace(/\+/g, " ").split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function ShortcutsDialog() {
  const open = useShortcutsDialog((s) => s.open);
  return open ? <Sheet /> : null;
}

function Sheet() {
  useShortcutVersion();
  const hide = useShortcutsDialog((s) => s.hide);
  const [filter, setFilter] = useState("");
  const [hotkey, setHotkey] = useState<string | null | undefined>(undefined);
  const count = useId();
  useEffect(() => { captureStatus().then((s) => setHotkey(s.shortcut), () => undefined); }, []);
  const rows = SHORTCUTS.map((s) => ({ s, keys: shown(s, hotkey) })).filter((r) => matchesFilter(r.s, filter, r.keys));
  const groups = [...new Set(rows.map((r) => r.s.group))];
  return (
    <Modal title="Keyboard shortcuts" onClose={hide} wide>
      <input type="search" autoFocus aria-label="Filter shortcuts" aria-describedby={count} placeholder="Filter by name or keys" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <p id={count} className="muted small" role="status">{rows.length === 0 ? "No shortcut matches." : `${rows.length} shortcut${rows.length === 1 ? "" : "s"}`}</p>
      {groups.map((group) => (
        <section key={group} className="shortcut-group" aria-label={group}>
          <h3>{group}</h3>
          <dl className="shortcut-list">
            {rows.filter((r) => r.s.group === group).map(({ s, keys }) => {
              const changed = s.remappable && normalize(combo(s.id)) !== normalize(defaultCombo(s.id));
              return (
                <div key={s.id} className="shortcut-row">
                  <dt>{s.label}{WHERE[s.scope] && <span className="muted small"> {WHERE[s.scope]}</span>}</dt>
                  <dd><kbd>{keys}</kbd>{changed && <span className="muted small"> default {formatCombo(defaultCombo(s.id))}</span>}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
      <p className="muted small">In an editor, {formatCombo(defaultCombo("editor.comment"))} toggles a comment instead of opening this sheet.</p>
      <div className="actions">
        <button onClick={() => { hide(); openSettings("shortcuts"); }}>Change shortcuts in Settings</button>
        <button className="primary" onClick={hide}>Close</button>
      </div>
    </Modal>
  );
}
