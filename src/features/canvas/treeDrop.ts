// A page dragged from the notebook tree onto a canvas board (NS-7C). The tree already moves rows with pointer events (HTML5
// drag and drop is unreliable in WebView2 with Tauri's own drop handling), so a row let go outside the tree is offered here.
// Only a board registers to take it: anywhere else the drop does nothing, and the tree's own moves are not affected.

/** What a tree row stands for: a file of a notebook, by the notebook's id and the path from its root. */
export interface TreeFile { notebook: string; path: string }

type Take = (file: TreeFile, at: { x: number; y: number }) => void;
const boards = new Map<HTMLElement, Take>();

/** Take the files of tree rows let go over `el` until the returned function is called. */
export function registerBoard(el: HTMLElement, take: Take): () => void {
  boards.set(el, take);
  return () => { if (boards.get(el) === take) boards.delete(el); };
}

/** Hand `file`, let go at the window point (`x`, `y`), to the board under it. Returns whether a board took it. */
export function dropOnBoard(file: TreeFile, x: number, y: number): boolean {
  const at = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
  if (!at) return false;
  for (const [el, take] of boards) {
    if (!el.contains(at)) continue;
    take(file, { x, y });
    return true;
  }
  return false;
}
