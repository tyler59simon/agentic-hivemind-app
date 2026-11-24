// Reduced motion (DESK-OS): Windows "Animation effects" off sets prefers-reduced-motion.

/** Whether the user asked the system for less motion. */
export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The scroll behaviour to use for a scripted jump: smooth unless the user asked for less motion. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? "auto" : "smooth");
