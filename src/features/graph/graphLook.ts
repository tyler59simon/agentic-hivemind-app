import type { SystemPalette } from "../../lib/forcedColors";

/** The colours the sigma drawing uses. `node` and `focus` are set only in a contrast theme, where every node takes one colour. */
export type GraphColors = { fg: string; muted: string; border: string; accent: string; node: string | null; focus: string | null };

/** The theme's tokens, or, in a contrast theme (`palette` given), its system colours: WebGL ignores CSS, so the forced colours of the
 *  page do not reach the graph. Nodes are drawn in the text colour, the focused node and the edges of the hovered node in Highlight. */
export function graphColors(palette: SystemPalette | null, token: (name: string) => string): GraphColors {
  if (palette) return { fg: palette.text, muted: palette.gray, border: palette.gray, accent: palette.highlight, node: palette.text, focus: palette.highlight };
  return { fg: token("--fg"), muted: token("--muted"), border: token("--border"), accent: token("--accent"), node: null, focus: null };
}

/** Sigma settings that end its camera animations (wheel zoom, double-click zoom, drag inertia) for a user who asked for less motion. */
export const cameraSettings = (reduced: boolean) => (reduced ? { inertiaDuration: 0, zoomDuration: 0, doubleClickZoomingDuration: 0 } : {});
