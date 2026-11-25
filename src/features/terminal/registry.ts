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
import { isMac } from "../../lib/platform";
import { onThemeChange } from "../../lib/theme";
import { onTypeChange } from "../../lib/typography";
import { termClose, termLogin, termOpen, termResize, termShell, termWrite, type ShellTarget, type StartMode, type TermExit, type TermInfo } from "../../lib/term";
import { keyAction } from "./keys";
import { decodeOsc52 } from "./osc52";
import { quotePaths, type PasteTarget } from "./paths";
import { pasteAction } from "./paste";
import { isShellId, type ShellTab } from "./shells";
import { setTerminalDrops } from "../notes/drops";
import { fontPx, xtermTheme } from "./theme";
import { makeWriter } from "./writer";
import { prefersReducedMotion } from "../../lib/motion";

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

/** `engine` is null for a PowerShell terminal: it has no CLI, so no image-paste key. */
interface Source { sessionId: string | null; engine: Engine | null; shell: boolean }

const lives = new Map<string, Live>();
const sources = new Map<string, Source>();
/** The PowerShell tabs, in the order they were opened. They live here so a tab outlasts its page. */
const shells = new Map<string, ShellTab>();
/** Shells the user closed: a later `term_list` must not bring their tabs back. */
const gone = new Set<string>();
let shellsLoaded = false;
let shellSnapshot: { version: number; tabs: ShellTab[] } = { version: -1, tabs: [] };
const listeners = new Set<() => void>();
let version = 0;
let exitListener = false;
/** Exit codes of shells that ended before their tab existed, by terminal id. */
const earlyExits = new Map<string, number | null>();
let dropListener = false;

/** Colours for find matches; the addon only takes #RRGGBB. */
export const FIND_DECORATIONS = {
  matchBackground: "#5c4a1e", matchOverviewRuler: "#c9a227",
  activeMatchBackground: "#8a5a00", activeMatchBorder: "#ffd166", activeMatchColorOverviewRuler: "#ffd166",
};

const notify = () => { version++; listeners.forEach((l) => l()); };
const read = (token: string) => getComputedStyle(document.documentElement).getPropertyValue(token).trim();
// A theme change recolours every open terminal, shown or not.
onThemeChange(() => {
  const theme = xtermTheme(read);
  lives.forEach((live) => { live.term.options.theme = theme; });
});
// A new code font (Settings) changes every open terminal's font and refits the ones on screen.
onTypeChange(() => {
  const fontFamily = read("--font-mono");
  lives.forEach((live, id) => { if (live.term.options.fontFamily !== fontFamily) { live.term.options.fontFamily = fontFamily; refit(id); } });
});
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
    // A shell can exit before `termShell` returns its id; `openShell` applies the exit when it adopts the shell.
    if (e.payload.id.startsWith("shell-") && !shells.has(e.payload.id) && !lives.has(e.payload.id)) {
      if (earlyExits.size > 50) earlyExits.clear();
      earlyExits.set(e.payload.id, e.payload.code);
      return;
    }
    const tab = shells.get(e.payload.id);
    if (tab) { shells.set(tab.id, { ...tab, running: false, exitCode: e.payload.code }); notify(); }
    const live = lives.get(e.payload.id);
    if (!live) return;
    live.exits++;
    live.running = false;
    live.term.options.disableStdin = true;
    notify();
  }).catch(() => { exitListener = false; });
}

/** How a dropped path is quoted for terminal `id`: shell tabs are PowerShell on Windows and the login shell on macOS
 *  (term/launch.rs `posix_shell` labels fish tabs "fish"). */
function pasteTarget(id: string): PasteTarget {
  if (!sources.get(id)?.shell) return "other";
  if (!isMac) return "powershell";
  return shells.get(id)?.label === "fish" ? "fish" : "posix";
}

/** Files dropped on the window go to the visible terminal under the drop position, as a paste (WebView2's own drop event has no paths). */
function watchDrops() {
  if (dropListener) return;
  dropListener = true;
  getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type !== "drop" || e.payload.paths.length === 0) return;
    // The position is in physical pixels.
    const live = terminalAt(e.payload.position.x / window.devicePixelRatio, e.payload.position.y / window.devicePixelRatio);
    if (!live) return;
    // A shell tab expands `$` inside double quotes, so it gets single-quoted literals in its own quoting.
    live.term.paste(quotePaths(e.payload.paths, pasteTarget(live.id)));
    live.term.focus();
  }).catch(() => { dropListener = false; });
}

/** The visible, running terminal at a point in CSS pixels: the one a drop there pastes into. */
function terminalAt(x: number, y: number): Live | undefined {
  for (const live of lives.values()) {
    if (!live.running || live.box.offsetParent === null) continue;
    const r = live.box.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return live;
  }
  return undefined;
}
// The drop router leaves a drop to a terminal only when one here pastes it (Codex review of 398b956, P3).
setTerminalDrops((x, y) => !!terminalAt(x, y));

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
    // A shell is re-attached by its own id; it has no scrollback file, so there is nothing to replay.
    const info: TermInfo = source.shell
      ? await termOpen({ sessionId: id, cols: live.term.cols, rows: live.term.rows, start: null, replay: false, output })
      : source.sessionId
        ? await termOpen({ sessionId: source.sessionId, cols: live.term.cols, rows: live.term.rows, start, replay, output })
        : await termLogin({ engine: source.engine ?? "claude", cols: live.term.cols, rows: live.term.rows, output });
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

/** A shell that `openShell` already started: its reply, its output channel and the bytes that arrived before the terminal existed. */
interface Adopt { info: TermInfo; output: Channel<ArrayBuffer>; early: ArrayBuffer[] }

/** Create the terminal for `id` if there is none, then attach to the Rust side. Safe to call twice.
 *  `shell` marks a PowerShell terminal (`id` is its `shell-<uuid>`); with `adopt` it is already attached. */
export function ensure(id: string, opts: { sessionId: string | null; engine: Engine | null; start: StartMode | null; shell?: boolean; adopt?: Adopt }): Live {
  const existing = lives.get(id);
  if (existing) return existing;
  watchExits();
  const box = document.createElement("div");
  box.className = "term-box-inner";
  const term = new Terminal({
    fontFamily: read("--font-mono"), fontSize: fontPx(rootPx()), theme: xtermTheme(read),
    cursorBlink: !prefersReducedMotion(), scrollback: 10000, allowProposedApi: true,
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
    const action = pasteAction((e.clipboardData?.getData("text/plain") ?? "") !== "", opts.shell ? null : opts.engine);
    if (action === "xterm") return;
    e.preventDefault();
    e.stopPropagation();
    if (action && live.running) termWrite(id, action.send).catch(() => undefined);
  }, true);
  watchDrops();
  sources.set(id, { sessionId: opts.sessionId, engine: opts.engine, shell: !!opts.shell });
  if (opts.adopt) {
    // xterm takes writes before `open`, so what the shell printed on the way here is not lost.
    const { info, output, early } = opts.adopt;
    const put = (bytes: ArrayBuffer) => { term.write(new Uint8Array(bytes)); };
    early.forEach(put);
    output.onmessage = put;
    live.running = info.running;
    term.options.disableStdin = !live.running;
    if (info.windowsBuild != null) term.options.windowsPty = { backend: "conpty", buildNumber: info.windowsBuild };
  }

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
    if (!opts.adopt) await attach(id, opts.start, true);
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

/** Allow or forbid a finished start to take the keyboard focus. Clearing the flag does not blur the terminal. */
export function setFocusable(id: string, value: boolean): void {
  const live = lives.get(id);
  if (live) live.focusable = value;
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

const tabOf = (t: TermInfo): ShellTab => ({ shell: true, id: t.id, label: t.label, cwd: t.cwd, running: t.running, exitCode: t.exitCode });

/** Open a PowerShell tab: start the shell, then give its terminal the id the backend chose (`shell-<uuid>`).
 *  The output channel is made first and buffers what arrives before the terminal exists. Rejects with the backend's error
 *  (for example the tab limit). The terminal starts at 80 by 24 and is fitted when its pane shows it. */
export async function openShell(target: ShellTarget): Promise<string> {
  watchExits();
  const output = new Channel<ArrayBuffer>();
  const early: ArrayBuffer[] = [];
  output.onmessage = (bytes) => { early.push(bytes); };
  const info = await termShell(target, 80, 24, output);
  gone.delete(info.id);
  shells.set(info.id, tabOf(info));
  const live = ensure(info.id, { sessionId: null, engine: null, start: null, shell: true, adopt: { info, output, early } });
  if (earlyExits.has(info.id)) {
    const code = earlyExits.get(info.id) ?? null;
    earlyExits.delete(info.id);
    shells.set(info.id, { ...tabOf(info), running: false, exitCode: code });
    live.exits++;
    live.running = false;
    live.term.options.disableStdin = true;
  }
  notify();
  return info.id;
}

/** Learn the running shells from `term_list` (after a page reload they still run in Rust). Shells already known and shells the
 *  user closed are left alone. Marks the list as loaded: until then the layout keeps shell ids it cannot match yet. */
export function loadShells(list: TermInfo[]): void {
  watchExits();
  for (const t of list) {
    if (t.sessionId === null && isShellId(t.id) && t.running && !shells.has(t.id) && !gone.has(t.id)) shells.set(t.id, tabOf(t));
  }
  shellsLoaded = true;
  notify();
}

/** The shell tabs and whether `loadShells` has run (the tab list is stable until something changes). */
export function useShells(): { tabs: ShellTab[]; loaded: boolean } {
  useSyncExternalStore(subscribe, () => version);
  if (shellSnapshot.version !== version) shellSnapshot = { version, tabs: [...shells.values()] };
  return { tabs: shellSnapshot.tabs, loaded: shellsLoaded };
}

/** Forget a terminal and free it. Does not stop its program. */
export function dispose(id: string): void {
  if (shells.delete(id)) { gone.add(id); notify(); }
  const live = lives.get(id);
  if (!live) return;
  lives.delete(id);
  sources.delete(id);
  live.term.dispose();
  live.box.remove();
  notify();
}
