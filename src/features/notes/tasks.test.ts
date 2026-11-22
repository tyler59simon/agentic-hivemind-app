// NS-7B: task lines and the one line a tick changes.
import { describe, expect, it } from "vitest";
import { displayText, dueOf, fieldsOf, parseTask, priorityOf, priorityRank, sameTask, TASK_CHARS, tickLine } from "./tasks";
import cases from "./fixtures/task_lines.json";

/** The cases `fixtures/task_lines.json` shares with Living Memory and the Rust index: `text` follows the box (cut at 500
 *  characters), `task` is the text people read, and the fields are read from `text`. */
type Case = { line: string; task: { done: boolean; text: string; task: string; due: string | null; owner: string | null; priority: string | null } | null };

describe("the shared task line cases", () => {
  it("has cases of both kinds", () => {
    expect((cases as Case[]).length).toBeGreaterThanOrEqual(30);
    expect((cases as Case[]).some((c) => c.task === null) && (cases as Case[]).some((c) => c.task !== null)).toBe(true);
  });

  it.each(cases as Case[])("reads $line", ({ line, task }) => {
    const parsed = parseTask(line);
    if (task === null) {
      expect(parsed).toBeNull();
      return;
    }
    expect(parsed).toEqual({ done: task.done, text: task.text });
    expect(fieldsOf(task.text)).toEqual({ due: task.due, owner: task.owner, priority: task.priority });
    expect(dueOf(task.text)).toBe(task.due);
    expect(priorityOf(task.text)).toBe(task.priority);
    expect(displayText(task.text)).toBe(task.task);
  });
});

describe("reading a task line", () => {
  it("reads a box and its text from any list marker, as the index does", () => {
    expect(parseTask("- [ ] call Ana")).toEqual({ done: false, text: "call Ana" });
    expect(parseTask("  * [x] done thing  ")).toEqual({ done: true, text: "done thing" });
    expect(parseTask("12) [X] numbered")).toEqual({ done: true, text: "numbered" });
    for (const not of ["- [ ]", "- [ ] ", "- [-] cancelled", "-[ ] no space", "- [ ]no space", "[ ] no marker", "- [] empty box", "text - [ ] later"]) expect(parseTask(not), not).toBeNull();
    expect([...parseTask(`- [ ] ${"é".repeat(600)}`)!.text]).toHaveLength(TASK_CHARS);
  });

  it("finds the due date from the emoji or the Dataview field, the first one", () => {
    expect(dueOf("call 📅 2026-12-01 soon")).toBe("2026-12-01");
    expect(dueOf("call 📅2026-12-01")).toBe("2026-12-01");
    expect(dueOf("call due:: 2026-12-02")).toBe("2026-12-02");
    // A single colon counts only inside the tail.
    expect(dueOf("call due: 2026-12-03")).toBeNull();
    expect(dueOf("call (due: 2026-12-03)")).toBe("2026-12-03");
    expect(dueOf("overdue:: 2026-12-03")).toBeNull();
    expect(dueOf("📅 soon")).toBeNull();
    expect(dueOf("due:: 2026-01-02 and 📅 2026-02-03")).toBe("2026-01-02");
  });

  it("finds the priority and drops the fields from the text the lists show", () => {
    expect(priorityOf("pay ⏫ 📅 2026-12-01")).toBe("high");
    expect(priorityOf("pay 🔺")).toBe("highest");
    expect(priorityOf("pay")).toBeNull();
    expect(priorityRank("high") < priorityRank("low") && priorityRank("low") < priorityRank(null)).toBe(true);
    expect(displayText("pay the bill ⏫ 📅 2026-12-01 ✅ 2026-12-02")).toBe("pay the bill");
    expect(displayText("📅 2026-12-01")).toBe("📅 2026-12-01");
  });

  it("recognises the line the index described, and only that line", () => {
    const row = { done: false, text: "call Ana 📅 2026-12-01" };
    expect(sameTask("- [ ] call Ana 📅 2026-12-01", row)).toBe(true);
    expect(sameTask("* [ ]   call Ana 📅 2026-12-01  ", row)).toBe(true);
    expect(sameTask("- [x] call Ana 📅 2026-12-01", row)).toBe(false);
    expect(sameTask("- [ ] call Bo 📅 2026-12-01", row)).toBe(false);
    expect(sameTask("call Ana", row)).toBe(false);
    expect(sameTask(undefined, row)).toBe(false);
  });
});

describe("ticking a task changes the box and nothing else", () => {
  it("ticks and clears a task by its box alone, whatever else the line says", () => {
    expect(tickLine("- [ ] call Ana", true)).toBe("- [x] call Ana");
    expect(tickLine("  1. [ ]   spaced   text  ", true)).toBe("  1. [x]   spaced   text  ");
    expect(tickLine("- [ ] pay 📅 2026-12-01 ⏫", true)).toBe("- [x] pay 📅 2026-12-01 ⏫");
    expect(tickLine("- [x] call Ana", false)).toBe("- [ ] call Ana");
    expect(tickLine("- [X] call Ana", false)).toBe("- [ ] call Ana");
  });

  it("takes a done date away when the box is cleared, and never adds one", () => {
    expect(tickLine("- [x] pay 📅 2026-12-01 ✅ 2026-12-05", false)).toBe("- [ ] pay 📅 2026-12-01");
    expect(tickLine("- [ ] pay 📅 2026-12-01 ✅ 2026-11-30", true)).toBe("- [x] pay 📅 2026-12-01 ✅ 2026-11-30");
  });

  it("gives null for a line that is not a task", () => {
    expect(tickLine("just text", true)).toBeNull();
    expect(tickLine("- plain bullet", true)).toBeNull();
  });
});
