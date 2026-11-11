import { useEffect, useRef, useState, type ReactNode } from "react";

/** A button that opens a small menu; a click outside or Escape closes it. `children` gets a `close` to call after an action. */
export function Menu({ button, className = "", align = "left", up, label, children }: {
  button: ReactNode; className?: string; align?: "left" | "right"; up?: boolean; label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key); };
  }, [open]);
  return (
    <div className={`menu ${className}`} ref={box}>
      <button className="menu-button" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>{button}</button>
      {open && <ul className={`menu-list ${align} ${up ? "up" : ""}`} role="menu">{children(() => setOpen(false))}</ul>}
    </div>
  );
}
