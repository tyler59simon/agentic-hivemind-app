/** What receives a dropped path: a PowerShell tab, a zsh or bash tab or a fish tab (macOS), or anything else (an agent's
 *  prompt, cmd). */
export type PasteTarget = "powershell" | "posix" | "fish" | "other";

/** PowerShell reads all of these as a single quote, so each is doubled inside a single-quoted string. */
const POWERSHELL_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

/** Dropped file paths as one paste, a space after each. In PowerShell each is a single-quoted literal (nothing inside is
 *  expanded: `$`, a backtick and `"` stay as they are) with its single quotes doubled; elsewhere each is in double quotes. */
export function quotePaths(paths: string[], target: PasteTarget = "other"): string {
  if (target === "powershell") return paths.map((p) => `'${p.replace(POWERSHELL_QUOTES, "$&$&")}' `).join("");
  // zsh and bash expand nothing inside single quotes; a single quote is closed, escaped and reopened.
  if (target === "posix") return paths.map((p) => `'${p.replace(/'/g, "'\\''")}' `).join("");
  // fish reads \\ and \' inside single quotes as escapes.
  if (target === "fish") return paths.map((p) => `'${p.replace(/[\\']/g, "\\$&")}' `).join("");
  return paths.map((p) => `"${p}" `).join("");
}
