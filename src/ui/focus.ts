// Small focus helpers for dialogs, menus and lists (DESK-4, DESK-5, DESK-6).

const FOCUSABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=hidden])", "select:not([disabled])",
  "textarea:not([disabled])", "[tabindex]:not([tabindex='-1'])", "[contenteditable='true']",
].join(",");

/** The elements Tab reaches inside `root`, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden], [inert], [aria-hidden='true']"));
}

/** Keep Tab inside `root`: from the last element it goes to the first, and Shift+Tab from the first to the last. Returns
 *  whether it moved focus. */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== "Tab" || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return false;
  const all = focusables(root);
  if (!all.length) { e.preventDefault(); root.focus(); return true; }
  const first = all[0], last = all[all.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root || !root.contains(active))) { e.preventDefault(); last.focus(); return true; }
  if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus(); return true; }
  return false;
}

/** The menu items of a menu list, skipping disabled ones. */
export const menuItems = (list: HTMLElement): HTMLElement[] =>
  [...list.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemradio], [role=menuitemcheckbox]")]
    .filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-disabled") !== "true");

/** Arrow keys, Home, End and type-ahead inside a menu. Returns whether the key was used. */
export function menuKey(e: KeyboardEvent | React.KeyboardEvent, list: HTMLElement): boolean {
  const items = menuItems(list);
  if (!items.length) return false;
  const at = items.indexOf(document.activeElement as HTMLElement);
  let to = -1;
  if (e.key === "ArrowDown") to = at < 0 ? 0 : (at + 1) % items.length;
  else if (e.key === "ArrowUp") to = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = items.length - 1;
  else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const ch = e.key.toLowerCase();
    const order = [...items.slice(at + 1), ...items.slice(0, at + 1)];
    const hit = order.find((el) => (el.textContent ?? "").trim().toLowerCase().startsWith(ch));
    if (hit) to = items.indexOf(hit);
  }
  if (to < 0) return false;
  e.preventDefault();
  items[to].focus();
  return true;
}

/** Shift+F10 or the Menu key: the keyboard way to open a context menu. */
export const contextMenuKey = (e: { key: string; shiftKey: boolean }): boolean => e.key === "ContextMenu" || (e.shiftKey && e.key === "F10");

/** Where a context menu opened from the keyboard appears: under the left part of the element. */
export function menuPointFor(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + Math.min(24, r.width / 2), y: r.bottom };
}

/** Keys on a tab of a tab strip (DESK-6): Left, Right, Home and End move the focus along the strip without opening the tab
 *  (tabs can be slow to draw), Enter or Space opens it, Delete closes it, and Shift+F10 or the Menu key opens its menu. */
export function tabKey(e: React.KeyboardEvent<HTMLElement>, act: { open: () => void; close?: () => void; menu?: (at: { x: number; y: number }) => void }): void {
  if (e.target !== e.currentTarget) return;
  const tabs = [...(e.currentTarget.closest("[role=tablist]")?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])];
  const at = tabs.indexOf(e.currentTarget);
  const to = e.key === "ArrowRight" ? (at + 1) % tabs.length : e.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
    : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
  if (to >= 0 && tabs[to]) { e.preventDefault(); tabs[to].focus(); tabs[to].scrollIntoView({ block: "nearest", inline: "nearest" }); return; }
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act.open(); return; }
  if (e.key === "Delete" && act.close) {
    e.preventDefault();
    const self = e.currentTarget, list = self.closest("[role=tablist]"), strip = list?.parentElement;
    act.close();
    // The tab is gone and took the focus with it: give it to the tab now in its place, or the strip's next control. Not
    // when the close asked first (a dialog has the focus) or the tab is still there.
    requestAnimationFrame(() => {
      const now = document.activeElement;
      if (self.isConnected || (now && now !== document.body)) return;
      const left = [...(list?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])];
      (left[Math.min(at, left.length - 1)] ?? strip?.querySelector<HTMLElement>("button:not([disabled])"))?.focus();
    });
    return;
  }
  if (contextMenuKey(e) && act.menu) { e.preventDefault(); act.menu(menuPointFor(e.currentTarget)); }
}
