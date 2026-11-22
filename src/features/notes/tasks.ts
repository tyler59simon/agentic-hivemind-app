// Task lines (NS-7B): reading them the way the index and Living Memory do, the Obsidian Tasks emoji fields (`📅 2026-12-01`,
// `⏫`, `✅ 2026-12-01`), and changing one line when a task is ticked. The parse is the twin of `src-tauri/src/notes_index/
// props.rs` (`task_line`, `due_of`), which is itself the twin of Living Memory's `docs_index.tasks`, so a row of the index
// and the line it came from agree on what the task is.

export type Priority = "highest" | "high" | "medium" | "low" | "lowest";

/** The Tasks plugin's priority emojis, highest first. */
export const PRIORITIES: { emoji: string; priority: Priority }[] = [
  { emoji: "🔺", priority: "highest" }, { emoji: "⏫", priority: "high" }, { emoji: "🔼", priority: "medium" },
  { emoji: "🔽", priority: "low" }, { emoji: "⏬", priority: "lowest" },
];
/** Sorts the highest priority first, and a task with none after them. */
export const priorityRank = (p: Priority | null) => (p ? PRIORITIES.findIndex((x) => x.priority === p) : PRIORITIES.length);

/** How many characters of a task's text the index keeps. */
export const TASK_CHARS = 500;

const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)\s*$/;
const DUE = /(?:\u{1F4C5}|\bdue::?)\s*(\d{4}-\d{2}-\d{2})/u;
const DONE_DATE = /\s*✅\s*\d{4}-\d{2}-\d{2}/u;

const cut = (text: string) => Array.from(text).slice(0, TASK_CHARS).join("");

/** A task line: whether its box is ticked, and its text (cut as the index cuts it); null for any other line. */
export function parseTask(line: string): { done: boolean; text: string } | null {
  const m = TASK.exec(line);
  return m ? { done: m[1] !== " ", text: cut(m[2]) } : null;
}

/** The due date of a task's text: `📅 YYYY-MM-DD` or `due:: YYYY-MM-DD`, the first one. */
export function dueOf(text: string): string | null {
  return DUE.exec(text)?.[1] ?? null;
}

export function priorityOf(text: string): Priority | null {
  for (const p of PRIORITIES) if (text.includes(p.emoji)) return p.priority;
  return null;
}

/** The task's text as the lists show it: without its due date, priority and done date, which the columns show instead. */
export function displayText(text: string): string {
  let shown = text.replace(/\s*\u{1F4C5}\s*\d{4}-\d{2}-\d{2}/gu, "").replace(DONE_DATE, "");
  for (const p of PRIORITIES) shown = shown.split(p.emoji).join("");
  return shown.replace(/\s{2,}/g, " ").trim() || text.trim();
}

/** The local date as `YYYY-MM-DD`. */
export function isoDate(d: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Whether `line` is the task the index described: a task line with the same box and the same text. */
export function sameTask(line: string | undefined, expected: { done: boolean; text: string }): boolean {
  const parsed = line === undefined ? null : parseTask(line);
  return !!parsed && parsed.done === expected.done && parsed.text === expected.text;
}

/** `line` with its box ticked (or cleared) and nothing else changed, except that clearing the box also takes away a Tasks done
 *  date (`✅ 2026-12-01`), which would otherwise say that an open task was finished. Ticking never adds a done date. Null when
 *  `line` is not a task line. */
export function tickLine(line: string, done: boolean): string | null {
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\]\s+)(.*)$/.exec(line);
  if (!m) return null;
  return `${m[1]}${done ? "x" : " "}${m[3]}${done ? m[4] : m[4].replace(DONE_DATE, "")}`;
}
