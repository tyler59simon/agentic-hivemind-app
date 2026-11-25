// The regions of the window and the keys that move between them (DESK-A11Y A2): F6 and Shift+F6 cycle through the sidebar,
// the top bar, the notes list, each pane and the context rail, and the skip link at the top of the shell jumps to the content.
// The regions are found in the page, so what is not drawn (a closed rail, a hidden list) is never a stop.
import { useLayout } from "./layout";

/** What a layout change hides, as a selector: the regions and the splitters (App.css). */
export function hiddenBy(focus: boolean, collapsed: boolean, folded: boolean, overlay: boolean): string {
  if (focus) return ".sidebar, .topbar, .notebooks, .note-rail, .shell > .splitter, .notes-page > .splitter, .notes-area > .splitter";
  const hidden: string[] = [];
  if (collapsed || folded) hidden.push(".shell > .splitter");
  if (folded) hidden.push(".notes-page > .splitter", ".sidebar-toggle");
  if (overlay) hidden.push(".notes-area > .splitter");
  return hidden.join(", ");
}

interface Region {
  /** The element that holds the region: focus inside it means the region is the current one. */
  box: HTMLElement;
  /** Where focus goes when the region is chosen. */
  target: HTMLElement | null;
}

const find = <T extends HTMLElement = HTMLElement>(from: ParentNode, selector: string) => from.querySelector<T>(selector);

/** An editor in a tab panel: CodeMirror's content, a text area or any editable element. */
const EDITOR = ".cm-content, textarea, [contenteditable='true']";

/** The regions that are drawn, in the order F6 visits them: sidebar, top bar, notes list (Notes page only), each pane in
 *  order, the context rail. A page without panes (Home, Agents, a list view of Notes) has the page itself in the panes' place. */
export function regions(): Region[] {
  const shell = find(document, ".shell");
  if (!shell) return [];
  // Only focus mode hides a whole region; the other layout changes hide splitters and buttons (see `hiddenBy`).
  const hidden = hiddenBy(useLayout.getState().focusMode, false, false, false);
  const list: Region[] = [];
  const add = (box: HTMLElement | null, target: HTMLElement | null) => {
    if (box && !(hidden && box.closest(hidden))) list.push({ box, target: target ?? box });
  };
  const sidebar = find(shell, "aside.sidebar");
  add(sidebar, sidebar && (find(sidebar, ".nav-item.on") ?? find(sidebar, ".nav-item")));
  const topbar = find(shell, "header.topbar");
  add(topbar, topbar && find(topbar, "input[role=combobox]"));
  const tree = find(shell, "nav.notebooks");
  add(tree, tree && (find(tree, "[role=treeitem][tabindex='0']") ?? find(tree, "[role=treeitem], button")));
  const panes = [...shell.querySelectorAll<HTMLElement>("section.pane")];
  for (const pane of panes) {
    const panel = find(pane, "[role=tabpanel]");
    const hasTab = !!find(pane, "[role=tab]");
    // The editor when the tab has one, else the tab's panel, else (an empty pane) the strip's first button.
    add(pane, hasTab ? (panel && (find(panel, EDITOR) ?? panel)) : find(pane, ".pane-tabs button"));
  }
  if (!panes.length) add(find(shell, "main.page-host"), null);
  add(find(shell, "aside.note-rail"), null);
  return list;
}

/** The region the focus is in: the innermost one, since the page holds the notes list and the rail. When the focus is on
 *  something between regions (a splitter), the position it has in the page decides; with no focus in the shell, there is none. */
function current(list: Region[], active: Element | null): { at: number; inside: boolean } | null {
  if (!active || active === document.body || !active.closest(".shell")) return null;
  const inside = list.map((r, i) => ({ r, i })).filter(({ r }) => r.box.contains(active));
  const own = inside.find(({ r }) => !inside.some((o) => o.r !== r && r.box.contains(o.r.box)));
  if (own) return { at: own.i, inside: true };
  // Between regions: the last one that comes before the focus in the page, or -1 before the first.
  let at = -1;
  list.forEach((r, i) => { if (r.box.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) at = i; });
  return { at, inside: false };
}

/** Move the focus to the next region (1) or the previous one (-1), wrapping round. From outside the shell it goes to the
 *  first region (or the last, going back). Returns whether it moved, so the key is kept for the page when there is nothing to do. */
export function cycleRegion(step: 1 | -1): boolean {
  const list = regions().filter((r) => r.target);
  if (!list.length) return false;
  const here = current(list, document.activeElement);
  let to: number;
  if (!here) to = step === 1 ? 0 : list.length - 1;
  // From between two regions, "next" is the one after the focus and "previous" the one before it.
  else if (!here.inside) to = step === 1 ? here.at + 1 : here.at;
  else to = here.at + step;
  list[((to % list.length) + list.length) % list.length].target!.focus();
  return true;
}

/** The skip link: the focused pane's tab panel on the Notes page, otherwise the page itself. */
export function skipToContent(): void {
  const shell = find(document, ".shell");
  if (!shell) return;
  const panes = [...shell.querySelectorAll<HTMLElement>("section.pane")];
  const pane = panes.find((p) => p.classList.contains("focused")) ?? panes[0];
  const panel = pane && find(pane, "[role=tabpanel]");
  (panel ?? find(shell, "main.page-host"))?.focus();
}
