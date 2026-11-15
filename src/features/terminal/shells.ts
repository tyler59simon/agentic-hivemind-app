// PowerShell tabs: pure helpers. A shell has no session record; the backend's `term_list` is its source of truth.
import type { ShellTarget } from "../../lib/term";

/** A PowerShell tab as the workspace sees it. `label` and `cwd` come from the backend's `TermInfo`. */
export interface ShellTab { shell: true; id: string; label: string | null; cwd: string | null; running: boolean; exitCode: number | null }

export const isShellId = (id: string) => id.startsWith("shell-");

const folderName = (path: string) => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

/** "PowerShell · paystream": the program's label and the folder it started in. */
export function shellLabel(t: Pick<ShellTab, "label" | "cwd">): string {
  const label = t.label?.trim() || "PowerShell";
  return t.cwd ? `${label} · ${folderName(t.cwd)}` : label;
}

/** The tab's hover text: the full folder. */
export const shellTitle = (t: Pick<ShellTab, "label" | "cwd">): string => t.cwd ?? shellLabel(t);

/** The status line under a shell's terminal. */
export function shellStatus(t: Pick<ShellTab, "running" | "exitCode">): { tone: "on" | "off" | "failed"; text: string } {
  if (t.running) return { tone: "on", text: "Running" };
  return t.exitCode ? { tone: "failed", text: `Exited with code ${t.exitCode}` } : { tone: "off", text: "Exited" };
}

export interface ShellPlace { label: string; target: ShellTarget }

/** Where "PowerShell here" can open, in order of preference: the active session's folder; else the picked project's first
 *  repository; else, under "Other folders", each remembered folder. Empty when there is nowhere to open. */
export function shellPlaces(c: { session: string | null; project: string | null; repo: string | null; other: boolean; folders: string[] }): ShellPlace[] {
  if (c.session) return [{ label: "PowerShell here", target: { session: c.session } }];
  if (c.project && c.repo) return [{ label: "PowerShell here", target: { checkout: { project: c.project, repo: c.repo } } }];
  if (c.other) return c.folders.map((path) => ({ label: folderName(path), target: { folder: path } }));
  return [];
}

export const NO_SHELL_PLACE = "Pick a project, or open a session tab, to open PowerShell in its folder.";
