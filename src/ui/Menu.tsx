import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { menuItems, menuKey } from "./focus";
import { useLayer } from "./layers";

/** A button that opens a small menu; a click outside or Escape closes it. `children` gets a `close` to call after an action.
 *  The menu takes the focus when it opens, the arrow keys, Home, End and the first letter of an item move in it, and
 *  closing it puts focus back on the button (DESK-5), before the item's action runs, so a dialog the action opens returns
 *  focus there too. */
export function Menu({ button, className = "", align = "left", up, label, buttonLabel, children }: {
  button: ReactNode; className?: string; align?: "left" | "right"; up?: boolean; label: string;
  /** The button's own name. Defaults to `label`, which also names the menu. A button that shows text has no `aria-label` of its own
   *  (null): its content names it, so the name always contains the visible text (WCAG 2.5.3). */
  buttonLabel?: string | null;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const close = useCallback(() => { setOpen(false); trigger.current?.focus(); }, []);
  useLayer(open, close);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);
  useLayoutEffect(() => { if (open && list.current) menuItems(list.current)[0]?.focus(); }, [open]);
  return (
    <div className={`menu ${className}`} ref={box}>
      <button ref={trigger} className="menu-button" aria-haspopup="menu" aria-expanded={open} aria-label={buttonLabel === null ? undefined : buttonLabel ?? label}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); setOpen(true); } }}>{button}</button>
      {open && (
        <ul ref={list} className={`menu-list ${align} ${up ? "up" : ""}`} role="menu" aria-label={label}
          onKeyDown={(e) => { if (e.key === "Tab") { setOpen(false); return; } menuKey(e, e.currentTarget); }}>
          {children(close)}
        </ul>
      )}
    </div>
  );
}
