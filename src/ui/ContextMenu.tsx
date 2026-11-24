import { useLayoutEffect, useRef, type ReactNode } from "react";
import { menuItems, menuKey } from "./focus";
import { useLayer } from "./layers";

/** A right-click menu (DESK-5), also opened from the keyboard with Shift+F10 or the Menu key (see `contextMenuKey`). It is
 *  drawn in place, not in the body, so it keeps the colours of where it opens (the dark sidebar), and it stays inside the
 *  window. Escape and Tab close it and put focus back on `from`; a click elsewhere closes it. */
export function ContextMenu({ at, from, label, onClose, children }: {
  at: { x: number; y: number }; from?: HTMLElement | null; label: string; onClose: () => void; children: ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  const back = () => { onClose(); if (from?.isConnected) from.focus(); };
  useLayer(true, back);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const x = Math.max(4, Math.min(at.x, window.innerWidth - box.width - 4));
    const y = at.y + box.height > window.innerHeight - 4 ? Math.max(4, at.y - box.height) : at.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    menuItems(el)[0]?.focus();
  }, [at.x, at.y]);
  return (
    <ul className="menu-list context" role="menu" aria-label={label} ref={list} style={{ top: at.y, left: at.x }}
      // preventDefault keeps focus in the menu on a click: WebKit (macOS) does not focus a clicked button, so the blur
      // below would close the menu before the click runs.
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onKeyDown={(e) => {
        if (e.key === "Tab") { e.preventDefault(); back(); return; }
        menuKey(e, e.currentTarget);
      }}
      // An item gives focus back to `from` before its action runs, so a dialog it opens returns focus there when it closes,
      // and an action that focuses something else (a rename field) still can.
      onClickCapture={(e) => { if ((e.target as Element).closest("[role=menuitem]") && from?.isConnected) from.focus(); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) onClose(); }}>
      {children}
    </ul>
  );
}
