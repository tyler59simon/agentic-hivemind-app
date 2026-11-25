// What the webview tells the app's log (DESK-LOGS). The log goes into Copy diagnostics, so an event carries only fixed
// kinds, names that pass an identifier check, numbers and source locations of this app's own bundle. Never a message, a
// reason, a stack header or any text of a note, a page or a file. Rust checks every field again (`log_client`).
// Outside the Tauri app (tests, a plain browser) nothing is looked at or sent, and nothing here throws.
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "./native";

export type ClientKind = "render_error" | "window_error" | "unhandled_rejection" | "lm_failure";
export interface ClientFrame { file: string; line: number; column: number }
export interface ClientEvent {
  kind: ClientKind;
  name?: string;
  code?: string;
  exit?: number;
  frames?: ClientFrame[];
  component?: string[];
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
/** The text if it is a plain identifier, else nothing. */
export const ident = (value: unknown): string | undefined => (typeof value === "string" && IDENT.test(value) ? value : undefined);

const MAX_FRAMES = 8;
const MAX_COMPONENTS = 12;
const MAX_POSITION = 10_000_000;
/** A file of this app's own bundle (`/assets/index-abc.js`) or of its dev server (`/src/main.tsx`). */
const BUNDLE = /^\/(assets|src)\/[A-Za-z0-9_./-]{1,100}$/;

/** Where this app's pages and scripts come from: the packaged app (`tauri.localhost`, `tauri://localhost`) and its dev server. */
const OWN_HOSTS = ["tauri.localhost", "localhost", "127.0.0.1"];

/** The path of a script URL when it is one of this app's own files, without origin, query or hash. */
function ownPath(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const u = new URL(url);
    if (!["http:", "https:", "tauri:"].includes(u.protocol) || !OWN_HOSTS.includes(u.hostname)) return undefined;
    return BUNDLE.test(u.pathname) && !u.pathname.includes("..") ? u.pathname : undefined;
  } catch {
    return undefined;
  }
}

const position = (value: unknown): number | undefined => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_POSITION ? (value as number) : undefined);

function frame(url: unknown, line: unknown, column: unknown): ClientFrame | undefined {
  const file = ownPath(url);
  const [l, c] = [position(line), position(column)];
  return file !== undefined && l !== undefined && c !== undefined ? { file, line: l, column: c } : undefined;
}

/** `    at fn (url:line:col)` or `    at url:line:col` (V8: Chromium, WebView2). */
const V8_FRAME = /^ +at (?:.+? \()?([^\s()]+):(\d+):(\d+)\)?$/;
/** `name@url:line:col` (WebKit). */
const WEBKIT_FRAME = /^[^\s@()]*@([^\s()]+):(\d+):(\d+)$/;

/** The source locations in a stack string: only the `url:line:column` of lines that have the shape of a stack frame, and
 *  only for this app's own files. A V8 stack starts with the error's own text (`Name: message`, which can run over several
 *  lines and end in anything), so `header` is that text and is cut off first; a stack that does not start with it yields
 *  nothing. A WebKit stack has no such text. */
export function framesOf(stack: unknown, header = ""): ClientFrame[] {
  if (typeof stack !== "string") return [];
  const v8 = header !== "" && stack.startsWith(header);
  const rows = (v8 ? stack.slice(header.length) : stack).split(/\r?\n/);
  const webkit = !v8 && WEBKIT_FRAME.test(rows[0]);
  if (!v8 && !webkit) return [];
  const frames: ClientFrame[] = [];
  for (const row of rows) {
    if (frames.length >= MAX_FRAMES) break;
    const m = (webkit ? WEBKIT_FRAME : V8_FRAME).exec(row);
    const found = m && frame(m[1], Number(m[2]), Number(m[3]));
    if (found) frames.push(found);
  }
  return frames;
}

/** The component names in React's component stack (`at Name (url)`), when they are identifiers of at most 40 characters:
 *  they are names in this app's own code (or DOM tags), never user text. */
export function componentsOf(stack: unknown): string[] {
  if (typeof stack !== "string") return [];
  const names: string[] = [];
  for (const row of stack.split("\n")) {
    if (names.length >= MAX_COMPONENTS) break;
    // `at Name (url)` (V8) or `Name@url` (WebKit).
    const m = /^\s*(?:at\s+([A-Za-z][A-Za-z0-9_]{0,39})(?=[\s(]|$)|([A-Za-z][A-Za-z0-9_]{0,39})(?=@))/.exec(row);
    if (m) names.push(m[1] ?? m[2]);
  }
  return names;
}

/** What may be said about a thrown value: its error name and its source locations. A value that is not an Error says
 *  nothing: a string or an object may be anything. */
function errorFields(value: unknown): Pick<ClientEvent, "name" | "frames"> {
  try {
    if (value instanceof Error) {
      const [name, message] = [String(value.name), String(value.message)];
      // V8 starts the stack with `name: message` (or only one of them when the other is empty).
      return { name: ident(name) ?? "other", frames: framesOf(value.stack, name && message ? `${name}: ${message}` : name || message) };
    }
  } catch { /* a getter that throws: nothing is said */ }
  return {};
}

export function sendClientEvent(event: ClientEvent): void {
  if (!inTauri()) return;
  try { invoke("log_client", { event }).catch(() => undefined); } catch { /* logging must never break the caller */ }
}

/** Run `build` and send what it makes, only inside the app, and never let either throw. */
function report(build: () => ClientEvent): void {
  if (!inTauri()) return;
  try { sendClientEvent(build()); } catch { /* nothing is logged */ }
}

/** A render error caught by an ErrorBoundary. */
export function logRenderError(error: unknown, componentStack: unknown): void {
  report(() => ({ kind: "render_error", ...errorFields(error), component: componentsOf(componentStack) }));
}

/** An uncaught error of the window. */
export function logWindowError(e: ErrorEvent): void {
  report(() => {
    const fields = errorFields(e.error);
    const own = frame(e.filename, e.lineno, e.colno);
    return { kind: "window_error", ...fields, frames: fields.frames?.length ? fields.frames : own ? [own] : [] };
  });
}

/** A promise nobody handled. */
export function logRejection(reason: unknown): void {
  report(() => ({ kind: "unhandled_rejection", ...errorFields(reason) }));
}

/** A Living Memory command that failed: its name (a command of lm.ts, a literal), its code and its exit status. */
export function logLmFailure(command: unknown, code: unknown, exit: unknown): void {
  report(() => ({
    kind: "lm_failure",
    name: ident(typeof command === "string" ? command.replace(/-/g, "_") : undefined) ?? "other",
    code: ident(code) ?? "other",
    ...(position(exit) !== undefined ? { exit: exit as number } : {}),
  }));
}

/** Log what the window did not catch: a script error and a promise nobody handled. */
export function installGlobalLogging(): void {
  window.addEventListener("error", logWindowError);
  window.addEventListener("unhandledrejection", (e) => logRejection(e.reason));
}
