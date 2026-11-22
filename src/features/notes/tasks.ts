// Task lines (NS-7B): reading them the way the index and Living Memory do, the Obsidian Tasks emoji fields (`📅 2026-12-01`,
// `⏫`, `✅ 2026-12-01`), and changing one line when a task is ticked. The parse is the twin of `src-tauri/src/notes_index/
// props.rs` (`task_line`, `fields_of`), which is itself the twin of Living Memory's `docs_index.tasks` and `note_format.
// item_fields`, so a row of the index and the line it came from agree on what the task is. `fixtures/task_lines.json` holds the
// cases all three are checked against.

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
// The tail: a parenthesis group at the very end that holds only `due`, `owner` and `priority` pairs.
const PAIR = String.raw`(?:due|owner|priority)\s*:\s*[^,()]+`;
const TAIL = new RegExp(String.raw`\s*\(\s*(${PAIR}(?:\s*,\s*${PAIR})*)\s*\)\s*$`, "i");
// The Tasks and Dataview forms, read when the tail does not give the field; `due` must start a word.
const DUE_FORM = /(?:\u{1F4C5}|(?<![\p{L}\p{N}_])due::)\s*(\d{4}-\d{2}-\d{2})/u;
// What the text shown to people drops besides the tail.
const SHOWN_OUT = /\s*(?:[\u{1F4C5}\u2705]\s*\d{4}-\d{2}-\d{2}|[\u{1F53A}\u23EB\u{1F53C}\u{1F53D}\u23EC])/gu;
const DONE_DATE = /\s*✅\s*\d{4}-\d{2}-\d{2}/u;

const cut = (text: string) => Array.from(text).slice(0, TASK_CHARS).join("");

/** A task line: whether its box is ticked, and its text (cut as the index cuts it); null for any other line. */
export function parseTask(line: string): { done: boolean; text: string } | null {
  const m = TASK.exec(line);
  return m ? { done: m[1] !== " ", text: cut(m[2]) } : null;
}

/** Whether `value` is a real `YYYY-MM-DD` date (year 1 or later). */
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= days;
}

export interface TaskFields { due: string | null; owner: string | null; priority: Priority | null }

/** The text without its tail, and the fields the tail gives. A tail at the very end, `(due: YYYY-MM-DD, owner: NAME, priority:
 *  high)`, gives them in any order, with the keys in any case; a bad value is ignored and the first of a repeated key wins. A group
 *  holding anything else is plain text. */
function splitTail(text: string): { rest: string; fields: TaskFields } {
  text = text.trim();
  const fields: TaskFields = { due: null, owner: null, priority: null };
  const tail = TAIL.exec(text);
  if (!tail) return { rest: text, fields };
  const seen = new Set<string>();
  for (const pair of tail[1].split(",")) {
    const at = pair.indexOf(":");
    const key = pair.slice(0, at).trim().toLowerCase();
    const value = pair.slice(at + 1).split(/\s+/).filter(Boolean).join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === "due" && validDate(value)) fields.due = value;
    else if (key === "owner") fields.owner = value;
    else if (key === "priority" && PRIORITIES.some((p) => p.priority === value.toLowerCase())) fields.priority = value.toLowerCase() as Priority;
  }
  return { rest: text.slice(0, tail.index).trimEnd(), fields };
}

/** The due date, owner and priority of a task's text: the one rule. What the tail does not give comes from the text: the due date
 *  from the first `📅 YYYY-MM-DD` or `due:: YYYY-MM-DD`, the priority from the first priority emoji. The owner is the tail's only. */
export function fieldsOf(text: string): TaskFields {
  const { rest, fields } = splitTail(text);
  if (fields.due === null) {
    const found = DUE_FORM.exec(rest)?.[1];
    if (found && validDate(found)) fields.due = found;
  }
  if (fields.priority === null) {
    for (const ch of rest) {
      const hit = PRIORITIES.find((p) => p.emoji === ch);
      if (hit) { fields.priority = hit.priority; break; }
    }
  }
  return fields;
}

export const dueOf = (text: string): string | null => fieldsOf(text).due;

export const priorityOf = (text: string): Priority | null => fieldsOf(text).priority;

/** The task's text as the lists show it: without its tail, due date, priority and done date, which the columns show instead. */
export function displayText(text: string): string {
  return splitTail(text).rest.replace(SHOWN_OUT, "").trim() || text.trim();
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
