import { useEffect, type ReactNode } from "react";

/** A centered dialog. Escape and the backdrop call onClose unless `locked` (e.g. while a write runs). */
export function Modal({ title, children, onClose, wide, locked }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean; locked?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !locked) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, locked]);
  return (
    <div className="overlay center-overlay" onMouseDown={() => !locked && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head"><h2>{title}</h2><button className="ghost" onClick={onClose} disabled={locked} aria-label="Close">×</button></header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
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
        <button onClick={() => onAnswer(false)}>Cancel</button>
        <button autoFocus className={danger ? "danger" : "primary"} onClick={() => onAnswer(true)}>{action}</button>
      </div>
    </Modal>
  );
}
