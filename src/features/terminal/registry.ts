// The xterm instances, kept outside React (decision D10): a terminal keeps receiving output while its page is unmounted.
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useSyncExternalStore } from "react";
import type { Engine, SessionInfo } from "../../lib/agent";
import { termLogin, termOpen, termResize, termWrite, type StartMode, type TermExit, type TermInfo } from "../../lib/term";
import { keyAction } from "./keys";
import { fontPx, xtermTheme } from "./theme";
import { makeWriter } from "./writer";

export interface Live {
  id: string;
  term: Terminal;
  /** The element xterm draws in. It is moved between hosts; `term.open` is called once. */
  box: HTMLDivElement;
  fit: FitAddon;
  /** Whether a program is attached on the Rust side. */
  running: boolean;
  /** The last `term_open` error, for the view. */
  error: string | null;
  /** Whether the user has pressed a key in this terminal (hides the first-run hint). */
  touched: boolean;
  /** Whether a `term_open` is in flight (disables the resume buttons). */
  starting: boolean;
}

interface Source { sessionId: string | null; engine: Engine }

const lives = new Map<string, Live>();
const sources = new Map<string, Source>();
const listeners = new Set<() => void>();
let version = 0;
let exitListener = false;

const notify = () => { version++; listeners.forEach((l) => l()); };
const read = (token: string) => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
const rootPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
const openLink = (_e: MouseEvent, uri: string) => { if (/^https?:/i.test(uri)) openUrl(uri).catch(() => undefined); };

/** Subscribe to changes of any terminal's `running`, `error`, `touched` or `starting` (for `useSyncExternalStore`). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const get = (id: string): Live | undefined => lives.get(id);

/** Whether this session's program is running: the registry's value when it has the terminal, else the session's stored status
 *  (a running session the page has not attached to yet, for example right after a reload). */
export function isRunning(s: Pick<SessionInfo, "id" | "status">): boolean {
  const live = lives.get(s.id);
  return live ? live.running : s.status === "running";
}

/** The same, as a hook that re-renders when it changes. */
export function useRunning(s: Pick<SessionInfo, "id" | "status">): boolean {
  return useSyncExternalStore(subscribe, () => isRunning(s));
}

/** The terminal's entry, re-read whenever anything in the registry changes. */
export function useLive(id: string): Live | undefined {
  useSyncExternalStore(subscribe, () => version);
  return lives.get(id);
}

function watchExits() {
  if (exitListener) return;
  exitListener = true;
  listen<TermExit>("term-exit", (e) => {
    const live = lives.get(e.payload.id);
    if (!live) return;
    live.running = false;
    live.term.options.disableStdin = true;
    notify();
  }).catch(() => { exitListener = false; });
}

/** Attach to the Rust side: `term_open` for a session, `term_login` for a sign-in terminal. */
async function attach(id: string, start: StartMode | null, replay: boolean): Promise<void> {
  const live = lives.get(id);
  const source = sources.get(id);
  if (!live || !source) return;
  live.starting = true;
  live.error = null;
  notify();
  const output = new Channel<ArrayBuffer>();
  output.onmessage = (bytes) => { live.term.write(new Uint8Array(bytes)); };
  try {
    const info: TermInfo = source.sessionId
      ? await termOpen({ sessionId: source.sessionId, cols: live.term.cols, rows: live.term.rows, start, replay, output })
      : await termLogin({ engine: source.engine, cols: live.term.cols, rows: live.term.rows, output });
    if (!lives.has(id)) return;
    live.running = info.running;
    if (info.windowsBuild != null) live.term.options.windowsPty = { backend: "conpty", buildNumber: info.windowsBuild };
  } catch (e) {
    if (!lives.has(id)) return;
    live.error = String(e);
  }
  live.starting = false;
  live.term.options.disableStdin = !live.running;
  notify();
}

/** Create the terminal for `id` if there is none, then attach to the Rust side. Safe to call twice. */
export function ensure(id: string, opts: { sessionId: string | null; engine: Engine; start: StartMode | null }): Live {
  const existing = lives.get(id);
  if (existing) return existing;
  watchExits();
  const box = document.createElement("div");
  box.className = "term-box-inner";
  const term = new Terminal({
    fontFamily: read("--font-mono"), fontSize: fontPx(rootPx()), theme: xtermTheme(read),
    cursorBlink: true, scrollback: 5000, allowProposedApi: true,
    linkHandler: { activate: openLink },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon(openLink));
  const live: Live = { id, term, box, fit, running: false, error: null, touched: false, starting: false };
  lives.set(id, live);
  sources.set(id, { sessionId: opts.sessionId, engine: opts.engine });

  void (async () => {
    // xterm measures the cell when it opens, so the font has to be loaded first (gotcha 18).
    await document.fonts.load(`${fontPx(rootPx())}px "JetBrains Mono Variable"`).catch(() => undefined);
    if (lives.get(id) !== live) return;
    term.open(box);
    const writeInput = makeWriter((data) => termWrite(id, data));
    term.attachCustomKeyEventHandler((e) => {
      const action = keyAction(e, term.hasSelection());
      switch (action) {
        case "copy":
          navigator.clipboard.writeText(term.getSelection()).catch(() => undefined);
          term.clearSelection();
          return false;
        case "paste":
          return false;
        case "leave":
          document.querySelector<HTMLInputElement>(".top-search input")?.focus();
          return false;
        case "newline":
          if (e.type === "keydown") writeInput("\x1b\r");
          return false;
        default:
          return true;
      }
    });
    term.onKey(() => { if (!live.touched) { live.touched = true; notify(); } });
    term.onData(writeInput);
    term.onResize(({ cols, rows }) => { termResize(id, cols, rows).catch(() => undefined); });
    // The renderer measures its cell after `open`, so a fit in the same task can use a default cell size (17 rows
    // where 25 fit). Fit again on the next frame; the host's size does not change, so nothing else would.
    if (box.isConnected) refit(id);
    requestAnimationFrame(() => refit(id));
    await attach(id, opts.start, true);
    if (lives.get(id) === live && box.isConnected) {
      refit(id);
      focus(live);
    }
  })();
  return live;
}

/** Start or resume the program in an existing terminal. */
export async function start(id: string, mode: StartMode): Promise<void> {
  await attach(id, mode, false);
}

/** Focus the terminal unless a dialog or a menu is open that it is not part of (the sign-in terminal sits in a dialog). */
function focus(live: Live) {
  const open = document.querySelector('[role="dialog"], [role="menu"]');
  if (open && !open.contains(live.box)) return;
  live.term.focus();
}

/** Put the terminal's element into `host`, fit it, focus it. */
export function mount(id: string, host: HTMLElement): void {
  const live = lives.get(id);
  if (!live) return;
  host.replaceChildren(live.box);
  refit(id);
  focus(live);
}

/** Refit after the host changed size; skipped while the host is hidden. */
export function refit(id: string): void {
  const live = lives.get(id);
  if (!live || live.box.offsetParent === null || !live.term.element) return;
  const px = fontPx(rootPx());
  if (live.term.options.fontSize !== px) live.term.options.fontSize = px;
  try { live.fit.fit(); } catch { /* the host has no size yet */ }
}

/** Forget a terminal and free it. Does not stop its program. */
export function dispose(id: string): void {
  const live = lives.get(id);
  if (!live) return;
  lives.delete(id);
  sources.delete(id);
  live.term.dispose();
  live.box.remove();
  notify();
}
