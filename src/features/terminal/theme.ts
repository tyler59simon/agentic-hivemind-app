import type { ITheme } from "@xterm/xterm";
import type { SystemPalette } from "../../lib/forcedColors";

/** In a Windows contrast theme xterm raises any text colour that has less contrast than this against its cell (WCAG AAA). The 16
 *  ANSI colours keep their hues, so a program's red and green stay red and green where they can be read, and change only where
 *  they cannot. 1 is xterm's default: no adjustment. */
export const FORCED_CONTRAST = 7;

/** The terminal's colours, from the app's --term-* CSS tokens. `read` returns a token's value, e.g. read("--term-bg").
 *  With the system palette (a contrast theme is on), the text, background, cursor and selection are the system colours. */
export function xtermTheme(read: (token: string) => string, system: SystemPalette | null = null): ITheme {
  const theme = tokenTheme(read);
  if (!system) return theme;
  return {
    ...theme,
    background: system.canvas, foreground: system.text, cursor: system.highlight, cursorAccent: system.canvas,
    selectionBackground: system.highlight, selectionForeground: system.highlightText,
  };
}

function tokenTheme(read: (token: string) => string): ITheme {
  return {
    background: read("--term-bg"),
    foreground: read("--term-fg"),
    cursor: read("--term-cursor"),
    cursorAccent: read("--term-bg"),
    selectionBackground: read("--term-selection"),
    black: read("--term-bg"),
    red: read("--term-red"),
    brightRed: read("--term-red"),
    green: read("--term-green"),
    brightGreen: read("--term-green"),
    yellow: read("--term-yellow"),
    brightYellow: read("--term-bright-yellow"),
    blue: read("--term-blue"),
    brightBlue: read("--term-blue"),
    magenta: read("--term-magenta"),
    brightMagenta: read("--term-magenta"),
    cyan: read("--term-cyan"),
    brightCyan: read("--term-cyan"),
    white: read("--term-white"),
    brightBlack: read("--term-bright-black"),
    brightWhite: read("--term-fg"),
  };
}

/** The terminal's font size in pixels: .86rem, the size the app uses for code, rounded. */
export const fontPx = (rootPx: number) => Math.round(rootPx * 0.86);
