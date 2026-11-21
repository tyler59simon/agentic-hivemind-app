// Files dropped on the window go where they land (NS-3A). Rust keeps a drop's files under a token and sends their
// names and the drop position (`files-dropped`); a terminal under the pointer pastes the paths itself
// (`features/terminal/registry.ts`), a page editor that registered here takes the files it wants (pictures become
// attachments), and every other file opens as a tab, as files from Explorer do.
import { invoke } from "@tauri-apps/api/core";

export interface Dropped { token: string; names: string[]; x: number; y: number }

/** A drop target: returns the indexes of the files it took. `x` and `y` are CSS pixels in the window. */
export type DropHandler = (drop: { token: string; names: string[]; x: number; y: number }) => Promise<number[]>;

const targets = new Map<HTMLElement, DropHandler>();

/** Take drops that land inside `el` until the returned function is called. */
export function registerDropTarget(el: HTMLElement, handle: DropHandler): () => void {
  targets.set(el, handle);
  return () => { if (targets.get(el) === handle) targets.delete(el); };
}

export const openDropped = (token: string, indexes: number[]) => invoke<void>("open_dropped", { token, indexes });

/** Route one drop. The position Rust reports is in physical pixels. */
export async function routeDrop(drop: Dropped, ratio = window.devicePixelRatio || 1): Promise<void> {
  const x = drop.x / ratio, y = drop.y / ratio;
  const at = document.elementFromPoint(x, y);
  if (at?.closest(".xterm")) return;
  let taken: number[] = [];
  for (const [el, handle] of targets) {
    if (!at || !el.contains(at)) continue;
    taken = await handle({ token: drop.token, names: drop.names, x, y }).catch(() => []);
    break;
  }
  const rest = drop.names.map((_, i) => i).filter((i) => !taken.includes(i));
  if (rest.length) await openDropped(drop.token, rest);
}
