// Whether the window is narrow (DESK-WIN): 1100 CSS px or less, the width at which the page layouts already fold their
// side columns. With the window zoom, CSS px follow the zoom, so a zoomed-in window counts as narrow sooner.
import { useSyncExternalStore } from "react";

export const NARROW_QUERY = "(max-width: 1100px)";

const query = (): MediaQueryList | null => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(NARROW_QUERY) : null);

export const isNarrow = (): boolean => query()?.matches ?? false;

function subscribe(listener: () => void): () => void {
  const q = query();
  q?.addEventListener("change", listener);
  return () => q?.removeEventListener("change", listener);
}

export const useNarrow = (): boolean => useSyncExternalStore(subscribe, isNarrow);
