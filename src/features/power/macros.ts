// Keyboard macros for text files (NS-6A). A macro is a list of steps: text typed, and editor commands run from a key. Mouse
// actions are not recorded. Replay runs each step as its own transaction, in slices so the window stays responsive on a
// large file. Up to 10 macros are kept in localStorage by name.
import { create } from "zustand";
import { Annotation, type EditorState, type Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { canReplayHeadless, session } from "./headless";

/** The editor, or anything shaped like it: commands run on `state` and `dispatch`. */
export interface Target { state: EditorState; dispatch: (tr: Transaction) => void }
/** A command as the keymaps hold it. Most only need a state and a dispatch; the rest need the whole view, which they get
 *  when the target is one. */
export type Run = (target: Target) => boolean;

export type Step = { t: "text"; s: string } | { t: "key"; id: string };
export interface Macro { name: string; steps: Step[] }

/** Commands a macro can run, by the id a recorded key gives them (see `extensions.ts`). */
const commands = new Map<string, Run>();
export const registerCommand = (id: string, run: Run) => { if (!commands.has(id)) commands.set(id, run); };
export const hasCommand = (id: string) => commands.has(id);

interface Recorder {
  recording: boolean;
  /** A replay is running; Escape or the Stop button cancels it. */
  playing: boolean;
  /** Runs made so far by the replay in progress. */
  runs: number;
  /** The macro Play runs: what was recorded last. */
  steps: Step[];
  start: () => void;
  stop: () => void;
  text: (s: string) => void;
  key: (id: string) => void;
}

export const useRecorder = create<Recorder>()((set, get) => ({
  recording: false,
  playing: false,
  runs: 0,
  steps: [],
  start: () => set({ recording: true, steps: [] }),
  stop: () => set({ recording: false }),
  text: (s) => {
    if (!get().recording || !s) return;
    const steps = get().steps;
    const last = steps[steps.length - 1];
    // Typed letters make one step, so a replay is one transaction per word instead of one per key.
    set({ steps: last?.t === "text" ? [...steps.slice(0, -1), { t: "text", s: last.s + s }] : [...steps, { t: "text", s }] });
  },
  key: (id) => { if (get().recording) set({ steps: [...get().steps, { t: "key", id }] }); },
}));

/** Run one step on `target`. False when it did nothing: a read-only editor, an unknown command, or a command that refused. */
export function runStep(target: Target, step: Step): boolean {
  if (target.state.readOnly) return false;
  if (step.t === "text") {
    target.dispatch(target.state.update({ ...target.state.replaceSelection(step.s), userEvent: "input.type", scrollIntoView: true }));
    return true;
  }
  return commands.get(step.id)?.(target) ?? false;
}

/** How long a replay may run before it lets the window draw (milliseconds). */
const SLICE_MS = 12;
/** The most runs one replay makes, so a macro that never reaches the end of the file cannot run forever. */
export const MAX_RUNS = 1_000_000;

export interface Control { cancelled: boolean }
const yieldToWindow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Play `steps` `times` times, or with "end" until the cursor reaches the end of the file or stops moving. Returns how
 *  many runs were made. `control.cancelled` stops it between steps. */
export async function play(target: Target, steps: Step[], times: number | "end", control: Control = { cancelled: false }, progress?: (runs: number) => void): Promise<number> {
  let runs = 0;
  let sliceStart = Date.now();
  const limit = times === "end" ? MAX_RUNS : Math.min(Math.max(0, Math.floor(times)), MAX_RUNS);
  while (runs < limit && !control.cancelled) {
    const before = target.state.selection.main.head, docBefore = target.state.doc;
    for (const step of steps) {
      if (control.cancelled) break;
      runStep(target, step);
    }
    runs++;
    if (times === "end") {
      const { head } = target.state.selection.main;
      // At the end of the file, or not moved at all by a run that changed nothing: there is nowhere left to go.
      if (head >= target.state.doc.length || (head === before && target.state.doc.eq(docBefore))) break;
    }
    if (Date.now() - sliceStart > SLICE_MS) { progress?.(runs); await yieldToWindow(); sliceStart = Date.now(); }
  }
  return runs;
}

let running: Control | null = null;

/** Editors a replay is running on. Their edits are reported to the page once, when the replay ends: reporting each step
 *  would copy the whole text for every one, which is minutes of work on a large file. */
const replaying = new WeakSet<object>();
export const isReplaying = (view: object) => replaying.has(view);
/** Marks the empty transaction that ends a replay, so the editor reports the text it now has. */
export const replayDone = Annotation.define<boolean>();

const isView = (target: Target): target is Target & EditorView => "contentDOM" in target;

/** Play on the editor, one replay at a time; recording stops first. Returns the runs made, or 0 when one was already going.
 *
 *  On a real editor whose lines do not wrap, the commands run on a copy of its state (see `headless.ts`), in slices of
 *  about 14 ms with a pause for the window between them, and the editor gets everything they did as one transaction at the
 *  end: one Undo reverts the whole replay, and it is reported to the page once. Esc ends it early with what was done so far.
 *  The editor takes no typing meanwhile. If its text changed some other way during the replay (another pane saved over
 *  it), nothing is applied and this throws. Anything else is replayed step by step on its own state. */
export async function playMacro(target: Target, steps: Step[], times: number | "end"): Promise<number> {
  if (running || !steps.length) return 0;
  useRecorder.getState().stop();
  const control: Control = { cancelled: false };
  running = control;
  useRecorder.setState({ playing: true, runs: 0 });
  replaying.add(target);
  const progress = (runs: number) => useRecorder.setState({ runs });
  try {
    if (!(isView(target) && canReplayHeadless(target))) return await play(target, steps, times, control, progress);
    const view: EditorView = target;
    const began = view.state.doc;
    const copy = session(view);
    const runs = await play(copy.view as unknown as Target, steps, times, control, progress);
    if (view.state.doc !== began) throw new Error("The text changed while the macro ran, so nothing was applied");
    const changes = copy.changes();
    replaying.delete(target);
    if (changes || !copy.state().selection.eq(view.state.selection)) {
      view.dispatch({ changes: changes ?? undefined, selection: copy.state().selection, scrollIntoView: true, userEvent: "input.macro" });
    }
    return runs;
  } finally {
    const wasQuiet = !replaying.has(target);
    running = null;
    replaying.delete(target);
    useRecorder.setState({ playing: false });
    // A replay that went step by step on the editor's own state reports the text it ended with (`replayDone`).
    if (!wasQuiet) target.dispatch(target.state.update({ annotations: replayDone.of(true) }));
  }
}

export function cancelPlayback() { if (running) running.cancelled = true; }

/** Ctrl+Shift+R. */
export function toggleRecording() {
  const r = useRecorder.getState();
  if (r.recording) r.stop();
  else if (!r.playing) r.start();
}

/** Ctrl+Shift+P: the last recorded macro, once. */
export const playLast = (target: Target) => void playMacro(target, useRecorder.getState().steps, 1);

// Saved macros ------------------------------------------------------------------------------------------------------

export const MAX_MACROS = 10;
const KEY = "hivemind.macros";

/** The saved macros; an empty list when storage cannot be read or holds something else. */
export function loadMacros(): Macro[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((m): m is Macro => !!m && typeof m.name === "string" && Array.isArray(m.steps)
      && m.steps.every((s: Step) => (s.t === "text" && typeof s.s === "string") || (s.t === "key" && typeof s.id === "string"))).slice(0, MAX_MACROS);
  } catch {
    return [];
  }
}

export type SaveResult = { ok: true; macros: Macro[] } | { ok: false; error: string };

/** Save `steps` under `name`, replacing a macro of that name. Refuses an 11th name and a macro with no steps. */
export function saveMacro(name: string, steps: Step[]): SaveResult {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the macro a name" };
  if (!steps.length) return { ok: false, error: "Record a macro first" };
  const macros = loadMacros();
  const at = macros.findIndex((m) => m.name.toLowerCase() === clean.toLowerCase());
  if (at < 0 && macros.length >= MAX_MACROS) return { ok: false, error: `Up to ${MAX_MACROS} macros can be saved. Delete one first` };
  const next = at < 0 ? [...macros, { name: clean, steps }] : macros.map((m, i) => (i === at ? { name: clean, steps } : m));
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return { ok: false, error: "The macro could not be saved: this window cannot store data" };
  }
  return { ok: true, macros: next };
}

export function deleteMacro(name: string): SaveResult {
  const next = loadMacros().filter((m) => m.name !== name);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return { ok: false, error: "The macro could not be deleted: this window cannot store data" };
  }
  return { ok: true, macros: next };
}
