// Reduced motion (DESK-OS): Windows "Animation effects" off sets prefers-reduced-motion.
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** Whether the user asked the system for less motion. */
export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia(QUERY).matches;

/** The scroll behaviour to use for a scripted jump: smooth unless the user asked for less motion. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? "auto" : "smooth");

/** Re-renders a component when the system setting changes, for drawing code that takes the setting once, when it starts. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof matchMedia !== "function") return () => {};
      const query = matchMedia(QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    prefersReducedMotion,
    () => false,
  );
}
