import type { ITheme } from "@xterm/xterm";

/** The terminal's colours, from the app's --term-* CSS tokens. `read` returns a token's value, e.g. read("--term-bg"). */
export function xtermTheme(read: (token: string) => string): ITheme {
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
