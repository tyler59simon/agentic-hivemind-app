// NS-7B: the rows of the Tasks view, filtered, ordered and grouped.
import { describe, expect, it } from "vitest";
import { addDays, dueBucket, filterTasks, groupTasks, itemOf, sortTasks, type TaskItem } from "./taskList";

const today = "2026-12-05";
let n = 0;
const task = (text: string, extra: Partial<TaskItem> = {}, due: string | null = null) =>
  itemOf({ id: String(n++), kind: "line", notebook: "nb-1", notebookTitle: "Main", path: "A.md", title: "A", line: n, done: false, text, ...extra }, due);

describe("due dates", () => {
  it("moves days across month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("puts a date in its bucket: overdue, today, the next six days, later, or none", () => {
    expect(["2026-12-04", "2026-12-05", "2026-12-06", "2026-12-11", "2026-12-12", null].map((d) => dueBucket(d, today))).toEqual(["overdue", "today", "week", "week", "later", "none"]);
  });
});

describe("the rows", () => {
  it("take the due date from the row, else from the text, and the priority from the text", () => {
    expect(task("pay 📅 2026-12-01 ⏫").due).toBe("2026-12-01");
    expect(task("pay ⏫", {}, "2026-12-09")).toMatchObject({ due: "2026-12-09", priority: "high" });
    expect(task("plain")).toMatchObject({ due: null, priority: null });
  });

  it("filter by notebook, action items, due bucket, done and the words of the text or the page title", () => {
    const items = [
      task("overdue one", {}, "2026-12-01"), task("due today", {}, today), task("this week", {}, "2026-12-08"), task("no date"),
      task("finished late", { done: true }, "2026-12-01"), task("other book", { notebook: "lm:d:n", notebookTitle: "d · N" }),
      task("an action", { kind: "action", notebook: "d", notebookTitle: "d · action items" }),
    ];
    const f = (over: Partial<Parameters<typeof filterTasks>[1]>) => filterTasks(items, { notebook: "", due: "any", done: "open", text: "", ...over }, today).map((t) => t.text);
    expect(f({})).toEqual(["overdue one", "due today", "this week", "no date", "other book", "an action"]);
    expect(f({ done: "done" })).toEqual(["finished late"]);
    expect(f({ done: "all" })).toHaveLength(7);
    expect(f({ notebook: "lm:d:n" })).toEqual(["other book"]);
    expect(f({ notebook: "@actions" })).toEqual(["an action"]);
    expect(f({ notebook: "nb-1" })).toEqual(["overdue one", "due today", "this week", "no date"]);
    expect(f({ due: "overdue" })).toEqual(["overdue one"]);
    expect(f({ due: "overdue", done: "all" })).toEqual(["overdue one"]);
    expect(f({ due: "today" })).toEqual(["due today"]);
    expect(f({ due: "week" })).toEqual(["due today", "this week"]);
    expect(f({ due: "none" })).toEqual(["no date", "other book", "an action"]);
    expect(f({ text: "THIS WEEK" })).toEqual(["this week"]);
    expect(f({ text: "week this" })).toEqual(["this week"]);
    expect(f({ text: "a.md" })).toEqual([]);
    expect(f({ text: "a" }).length).toBeGreaterThan(3);
  });

  it("sort open before done, then by due date with none last, then priority", () => {
    const sorted = sortTasks([task("done", { done: true }), task("none"), task("later", {}, "2026-12-09"), task("low", {}, "2026-12-01"), task("high", {}, "2026-12-01"), task("a ⏫", {}, "2026-12-01")]);
    expect(sorted.map((t) => t.text)).toEqual(["a ⏫", "low", "high", "later", "none", "done"]);
  });

  it("group by page, notebook or due bucket, in the order of the rows (the buckets in time order)", () => {
    const items = [task("a", {}, "2026-12-20"), task("b", { path: "B.md", title: "B", notebook: "nb-2", notebookTitle: "Other" }, "2026-12-01"), task("c"), task("d", {}, "2026-12-01")];
    expect(groupTasks(items, "none", today)).toEqual([{ key: "", label: "", items }]);
    expect(groupTasks(items, "page", today).map((g) => [g.label, g.items.map((t) => t.text)])).toEqual([["A", ["a", "c", "d"]], ["B", ["b"]]]);
    expect(groupTasks(items, "notebook", today).map((g) => g.label)).toEqual(["Main", "Other"]);
    expect(groupTasks(items, "due", today).map((g) => [g.label, g.items.map((t) => t.text)])).toEqual([["Overdue", ["b", "d"]], ["Later", ["a"]], ["No due date", ["c"]]]);
  });
});
