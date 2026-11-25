// Webview logging into the app's log file (DESK-LOGS). Outside the Tauri app (tests, a plain browser) every call does
// nothing, and none of them throws. Log names, codes, counts and stacks, never note text or command arguments.
import { error as logError, warn as logWarn } from "@tauri-apps/plugin-log";
import { inTauri } from "./native";

const send = (write: (message: string) => Promise<void>, message: string): void => {
  if (!inTauri()) return;
  try { write(message).catch(() => undefined); } catch { /* logging must never break the caller */ }
};

export const logErrorLine = (message: string): void => send(logError, message);
export const logWarnLine = (message: string): void => send(logWarn, message);

/** `text` cut to `max` characters, with a mark when it was cut. */
export const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

const MESSAGE_MAX = 300;

/** An error as one line: name, message, then the stack when it has one. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return [`${e.name}: ${cap(e.message, MESSAGE_MAX)}`, e.stack].filter(Boolean).join("\n");
  return cap(String(e), MESSAGE_MAX);
}

/** Log what the window did not catch: a script error and a promise nobody handled. */
export function installGlobalLogging(): void {
  window.addEventListener("error", (e) => {
    logErrorLine([`Uncaught error: ${cap(e.message, MESSAGE_MAX)} (${e.filename}:${e.lineno})`, e.error instanceof Error ? e.error.stack : ""].filter(Boolean).join("\n"));
  });
  window.addEventListener("unhandledrejection", (e) => {
    logErrorLine(`Unhandled promise rejection: ${describeError(e.reason)}`);
  });
}
