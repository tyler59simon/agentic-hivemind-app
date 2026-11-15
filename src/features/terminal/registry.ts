// The xterm instances, kept outside React (decision D10): a terminal keeps receiving output while its page is unmounted.
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useSyncExternalStore } from "react";
import type { Engine, SessionInfo } from "../../lib/agent";
import { termClose, termLogin, termOpen, termResize, termWrite, type StartMode, type TermExit, type TermInfo } from "../../lib/term";
import { keyAction } from "./keys";
import { decodeOsc52 } from "./osc52";
import { quotePaths } from "./paths";
import { pasteAction } from "./paste";
import { fontPx, xtermTheme } from "./theme";
import { makeWriter } from "./writer";

export interface Live {
  id: string;
  term: Terminal;
  /** The element xterm draws in. It is moved between hosts; `term.open` is called once. */
  box: HTMLDivElement;
  fit: FitAddon;
  search: SearchAddon;
  /** Whether the find bar is open, and its latest match count (`index` is -1 when none is active). */
  finding: boolean;
  matches: { index: number; count: number };
  /** Whether a program is attached on the Rust side. */
  running: boolean;
  /** The last `term_open` error, for the view. */
  error: string | null;
  /** Whether the user has pressed a key in this terminal (hides the first-run hint). */
  touched: boolean;
  /** Whether a `term_open` is in flight (disables the resume buttons). */
  starting: boolean;
  /** How many exits this terminal has seen; an exit that arrives before the start reply must not be undone by it. */
  exits: number;
  /** Whether mounting and a finished start may take the keyboard focus (false in a pane that is not focused). */
  focusable: boolean;
}

interface Source { sessionId: string | null; engine: Engine }

const lives = new Map<string, Live>();
const sources = new Map<string, Source>();
const listeners = new Set<() => void>();
let version = 0;
let exitListener = false;
let dropListener = false;

/** Colours for find matches; the addon only takes #RRGGBB. */
export const FIND_DECORATIONS = {
  matchBackground: "#5c4a1e", matchOverviewRuler: "#c9a227",
  activeMatchBackground: "#8a5a00", activeMatchBorder: "#ffd166", activeMatchColorOverviewRuler: "#ffd166",
};

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
    live.exits++;
    live.running = false;
    live.term.options.disableStdin = true;
    notify();
  }).catch(() => { exitListener = false; });
}

/** Files dropped on the window go to the visible terminal under the drop position, as a paste (WebView2's own drop event has no paths). */
function watchDrops() {
  if (dropListener) return;
  dropListener = true;
  getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type !== "drop" || e.payload.paths.length === 0) return;
    // The position is in physical pixels.
    const x = e.payload.position.x / window.devicePixelRatio;
    const y = e.payload.position.y / window.devicePixelRatio;
    for (const live of lives.values()) {
      if (!live.running || live.box.offsetParent === null) continue;
      const r = live.box.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      live.term.paste(quotePaths(e.payload.paths));
      live.term.focus();
      return;
    }
  }).catch(() => { dropListener = false; });
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
  const exits = live.exits;
  try {
    const info: TermInfo = source.sessionId
      ? await termOpen({ sessionId: source.sessionId, cols: live.term.cols, rows: live.term.rows, start, replay, output })
      : await termLogin({ engine: source.engine, cols: live.term.cols, rows: live.term.rows, output });
    if (lives.get(id) !== live) {
      // Disposed while starting (the sign-in dialog was closed before its program was found): stop what was started,
      // unless a new terminal has taken the id over and attached to it.
      if (info.running && !lives.has(id)) termClose(id).catch(() => undefined);
      return;
    }
    // The program may already have exited and its exit been handled while this reply was on its way.
    live.running = info.running && live.exits === exits;
    if (info.windowsBuild != null) live.term.options.windowsPty = { backend: "conpty", buildNumber: info.windowsBuild };
  } catch (e) {
    if (lives.get(id) !== live) return;
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
    cursorBlink: true, scrollback: 10000, allowProposedApi: true,
    linkHandler: { activate: openLink },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.loadAddon(new WebLinksAddon(openLink));
  const search = new SearchAddon();
  term.loadAddon(search);
  const live: Live = { id, term, box, fit, search, finding: false, matches: { index: -1, count: 0 }, running: false, error: null, touched: false, starting: false, exits: 0, focusable: true };
  lives.set(id, live);
  search.onDidChangeResults((r) => { live.matches = { index: r.resultIndex, count: r.resultCount }; notify(); });
  term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data);
    if (text !== null) navigator.clipboard.writeText(text).catch(() => undefined);
    return true;
  });
  // Capture phase, so this runs before xterm's own paste handler. Text is left to xterm; an image-only clipboard
  // sends the CLI's own image-paste key and the CLI reads the clipboard itself.
  box.addEventListener("paste", (e) => {
    const action = pasteAction((e.clipboardData?.getData("text/plain") ?? "") !== "", opts.engine);
    if (action === "xterm") return;
    e.preventDefault();
    e.stopPropagation();
    if (action && live.running) termWrite(id, action.send).catch(() => undefined);
  }, true);
  watchDrops();
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
        case "search":
          // The find bar sits in this terminal's own box; with two panes each has one.
          if (live.finding) live.box.closest(".term-box")?.querySelector<HTMLInputElement>(".find-bar input")?.select();
          else { live.finding = true; notify(); }
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
      if (live.focusable) focus(live);
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

/** Put the terminal's element into `host`, fit it, and focus it unless `opts.focus` is false (the pane is not the focused one). */
export function mount(id: string, host: HTMLElement, opts: { focus: boolean } = { focus: true }): void {
  const live = lives.get(id);
  if (!live) return;
  live.focusable = opts.focus;
  host.replaceChildren(live.box);
  refit(id);
  if (opts.focus) focus(live);
}

/** Give a mounted terminal the keyboard focus (its pane became the focused one). */
export function focusTerm(id: string): void {
  const live = lives.get(id);
  if (!live) return;
  live.focusable = true;
  focus(live);
}

/** Close the find bar and give the terminal the focus back. */
export function closeFind(id: string): void {
  const live = lives.get(id);
  if (!live) return;
  live.finding = false;
  live.search.clearDecorations();
  live.matches = { index: -1, count: 0 };
  notify();
  live.term.focus();
}

/** Open the find bar (the magnifier button). */
export function openFind(id: string): void {
  const live = lives.get(id);
  if (!live || live.finding) return;
  live.finding = true;
  notify();
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
