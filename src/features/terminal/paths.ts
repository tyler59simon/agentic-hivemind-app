/** What receives a dropped path: a PowerShell tab, or anything else (an agent's prompt, cmd, a POSIX shell). */
export type PasteTarget = "powershell" | "other";

/** PowerShell reads all of these as a single quote, so each is doubled inside a single-quoted string. */
const POWERSHELL_QUOTES = /['\u2018\u2019\u201a\u201b]/g;

/** Dropped file paths as one paste, a space after each. In PowerShell each is a single-quoted literal (nothing inside is
 *  expanded: `$`, a backtick and `"` stay as they are) with its single quotes doubled; elsewhere each is in double quotes. */
export function quotePaths(paths: string[], target: PasteTarget = "other"): string {
  if (target === "powershell") return paths.map((p) => `'${p.replace(POWERSHELL_QUOTES, "$&$&")}' `).join("");
  return paths.map((p) => `"${p}" `).join("");
}
