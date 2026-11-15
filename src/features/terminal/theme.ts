import type { ITheme } from "@xterm/xterm";

/** The blue `App.css` uses for `.type-decision`; there is no blue token. */
const BLUE = "#7fb0ff";

/** The terminal's colours, from the app's CSS tokens. `read` returns a token's value, e.g. read("--bg-code"). */
export function xtermTheme(read: (token: string) => string): ITheme {
  return {
    background: read("--bg-code"),
    foreground: read("--fg"),
    cursor: read("--accent"),
    cursorAccent: read("--bg-code"),
    selectionBackground: read("--bg-active"),
    black: read("--bg-code"),
    red: read("--error"),
    brightRed: read("--error"),
    green: read("--success"),
    brightGreen: read("--success"),
    yellow: read("--warn"),
    brightYellow: read("--warn-fg"),
    blue: BLUE,
    brightBlue: BLUE,
    magenta: read("--accent"),
    brightMagenta: read("--accent"),
    cyan: read("--teal"),
    brightCyan: read("--teal"),
    white: read("--muted"),
    brightBlack: read("--border-strong"),
    brightWhite: read("--fg"),
  };
}

/** The terminal's font size in pixels: .86rem, the size the app uses for code, rounded. */
export const fontPx = (rootPx: number) => Math.round(rootPx * 0.86);
