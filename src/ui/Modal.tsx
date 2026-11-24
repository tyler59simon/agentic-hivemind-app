import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { trapTab } from "./focus";
import { isTopLayer, useLayer } from "./layers";

/** A centered dialog. Escape and the backdrop call onClose unless `locked` (e.g. while a write runs). It is drawn in
 *  `document.body`, so it never inherits the colours of where it was opened from (a white document pane, the dark sidebar).
 *  It is modal for the keyboard too (DESK-4): Escape closes only the top dialog, Tab stays inside it, it takes the focus
 *  unless something in it already has it (an autoFocus field), and closing it gives focus back to what had it before. */
export function Modal({ title, children, onClose, wide, locked }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean; locked?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  // What had the focus when the dialog first rendered: the button or menu item that opened it.
  const opener = useRef(typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null));
  const layer = useLayer(true, onClose, locked, true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    // On the window, not the dialog: when the focused button is disabled during a write, the focus drops to the page body,
    // and the next Tab must still come back into the dialog instead of reaching what is behind it.
    const onTab = (e: KeyboardEvent) => { if (isTopLayer(layer.current) && box.current) trapTab(e, box.current); };
    window.addEventListener("keydown", onTab);
    const from = opener.current;
    return () => {
      window.removeEventListener("keydown", onTab);
      // Only when the focus was lost with the dialog: an action that focused something else (an editor) keeps it.
      queueMicrotask(() => {
        const now = document.activeElement;
        if ((!now || now === document.body) && from?.isConnected) from.focus({ preventScroll: true });
      });
    };
  }, []);
  return createPortal(
    <div className="overlay center-overlay" onMouseDown={() => !locked && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={box}
        onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head"><h2>{title}</h2><button className="ghost" onClick={onClose} disabled={locked} aria-label="Close">×</button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** Yes/no with a named action, for discarding edits and similar. */
export function Confirm({ title, message, action, danger, onAnswer }: {
  title: string; message: ReactNode; action: string; danger?: boolean; onAnswer: (yes: boolean) => void;
}) {
  return (
    <Modal title={title} onClose={() => onAnswer(false)}>
      <div>{message}</div>
      <div className="actions">
        {/* A dangerous action never has the focus first, so a stray Enter does not confirm it (DESK-4). */}
        <button autoFocus={danger} onClick={() => onAnswer(false)}>Cancel</button>
        <button autoFocus={!danger} className={danger ? "danger" : "primary"} onClick={() => onAnswer(true)}>{action}</button>
      </div>
    </Modal>
  );
}
