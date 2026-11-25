// The keyboard shortcut reference sheet (DESK-KEYS): every shortcut in the registry by group, with a filter. Ctrl+/ and the
// palette's "Keyboard shortcuts" open it.
import { useEffect, useId, useLayoutEffect, useState } from "react";
import { create } from "zustand";
import { captureStatusNow, combo, defaultCombo, formatCombo, fromAccelerator, normalize, refreshCapture, SHORTCUTS, useShortcutVersion, type CaptureHotkey, type Shortcut } from "../../lib/shortcuts";
import { openSettings } from "../../store";
import { Modal } from "../../ui/Modal";

interface DialogState {
  open: boolean;
  /** What had the focus when the sheet was asked for, and whether closing gives the focus back to it. */
  returnTo: HTMLElement | null;
  restore: boolean;
  /** Open the sheet. `from` is the control to give the focus back to on close: the one focused now, unless the caller knows
   *  better (the palette, which is gone by then). */
  show: (from?: Element | null) => void;
  /** Close it. `restore` false leaves the focus to the caller (the Settings link focuses the section). */
  hide: (restore?: boolean) => void;
}
export const useShortcutsDialog = create<DialogState>((set) => ({
  open: false, returnTo: null, restore: true,
  show: (from) => set({ open: true, restore: true, returnTo: (from ?? document.activeElement) as HTMLElement | null }),
  hide: (restore = true) => set({ open: false, restore }),
}));

/** Put the focus back where the sheet was asked for, or on the main region when that control is gone. */
function giveFocusBack(): void {
  const { returnTo, restore } = useShortcutsDialog.getState();
  if (!restore) return;
  const target = returnTo?.isConnected && returnTo !== document.body ? returnTo : document.querySelector<HTMLElement>("main");
  if (!target) return;
  if (!target.matches("a[href], button, input, select, textarea, [tabindex]")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

const WHERE: Partial<Record<Shortcut["scope"], string>> = { editor: "in the editor", terminal: "in a terminal", global: "from anywhere" };

/** The keys to show for a shortcut. The quick-capture hotkey is the one the app has (`status`, undefined until read): "Off"
 *  when it is turned off and "Not registered" when the system refused it; the rest come from the registry. */
export function shown(s: Shortcut, status?: CaptureHotkey | null): string {
  if (s.scope !== "global") return formatCombo(combo(s.id));
  if (!status) return formatCombo(defaultCombo(s.id));
  if (!status.shortcut) return "Off";
  return status.error ? "Not registered" : formatCombo(fromAccelerator(status.shortcut));
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
  const count = useId();
  useEffect(() => { void refreshCapture(); }, []);
  // Before the modal's own restore (a microtask after the commit), which only handles a focus that went to the page body.
  useLayoutEffect(() => giveFocusBack, []);
  const rows = SHORTCUTS.map((s) => ({ s, keys: shown(s, captureStatusNow()) })).filter((r) => matchesFilter(r.s, filter, r.keys));
  const groups = [...new Set(rows.map((r) => r.s.group))];
  return (
    <Modal title="Keyboard shortcuts" onClose={() => hide()} wide>
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
        <button onClick={() => { hide(false); openSettings("shortcuts"); }}>Change shortcuts in Settings</button>
        <button className="primary" onClick={() => hide()}>Close</button>
      </div>
    </Modal>
  );
}
