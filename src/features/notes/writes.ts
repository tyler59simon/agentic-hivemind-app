// The three writes of NS-7B, each one change to one page through `changePage`: ticking a task, setting a property and
// clearing one.
import { removeProp, setProp, type PropValue } from "./frontmatter";
import { changePage, type Written } from "./pageWrite";
import { sameTask, tickLine } from "./tasks";

/** A task as a list holds it: where it is and what it was when it was read. */
export interface TaskTarget { notebook: string; path: string; line: number; done: boolean; text: string; sha256?: string }

/** Tick (or clear) one task. Only its line changes, and only when the line is still the task that was listed: the same box
 *  and the same text at the same line number. Anything else is refused. */
export function setTaskDone(task: TaskTarget, done: boolean): Promise<Written> {
  return changePage({
    ref: { notebook: task.notebook, path: task.path },
    expected: task.sha256,
    change: (text) => {
      const lines = text.split("\n");
      const line = lines[task.line - 1];
      if (!sameTask(line, task)) return null;
      lines[task.line - 1] = tickLine(line, done)!;
      return lines.join("\n");
    },
  });
}

/** Set a property of a page, written back against the hash or revision the list showed it at. */
export function setPageProperty(page: { notebook: string; path: string; hash?: string }, key: string, value: PropValue): Promise<Written> {
  return changePage({ ref: { notebook: page.notebook, path: page.path }, expected: page.hash, change: (text) => setProp(text, key, value) });
}

/** Take a property away from a page (a card dropped in the column for "no value"). */
export function clearPageProperty(page: { notebook: string; path: string; hash?: string }, key: string): Promise<Written> {
  return changePage({ ref: { notebook: page.notebook, path: page.path }, expected: page.hash, change: (text) => removeProp(text, key) });
}
