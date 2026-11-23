import { afterEach, describe, expect, it, vi } from "vitest";
import type { Milestone } from "../../lib/executive";
import type { NoteRow } from "../../lib/lm";
import type { Notebook } from "../../lib/notebooks";
import { itemOf, type TaskItem } from "../notes/taskList";
import { NO_COUNTS } from "../review/worklist";
import { dueSoon, homeSections, inboxNeeds, lastVisit, looseItems, projectItems, rememberVisit, sinceDays, visitScope } from "./home";

const TODAY = "2026-11-22";
const DAY = 86_400_000;

const action = (ref: string, text: string, o: Partial<TaskItem> = {}): TaskItem => itemOf({
  id: `${ref}:1`, kind: "action", notebook: ref.split(":")[0], notebookTitle: "pay · action items", path: "Plan", title: "Plan", line: 1, done: false, text, ref, index: 1, ...o,
}, null);
const line = (notebook: string, path: string, n: number, text: string, due: string | null = null): TaskItem => itemOf({
  id: `${notebook}:${path}:${n}`, kind: "line", notebook, notebookTitle: notebook, path, title: path.replace(/\.md$/, ""), line: n, done: false, text,
}, due);
const milestone = (o: Partial<Milestone>): Milestone => ({ id: "m1", created: 0, updated: 0, project: "pay", title: "Beta", due: "", status: "planned", note: "", ...o });
const row = (ref: string, tags: string[], title = "Plan"): NoteRow => ({
  ref, id: ref.split(":")[1], domain: ref.split(":")[0], title, type: "plan", status: "active", tags, created: "", updated: "2026-11-20T10:00:00", revision: "r", path: "",
});
const notebook = (id: string, path: string): Notebook => ({ id, path, title: id, added: "" });
const names = (entries: ReturnType<typeof homeSections>["overdue"]) => entries.map((e) => (e.kind === "task" ? e.task.text : `milestone: ${e.milestone.title}`));

describe("home sections", () => {
  const items = [
    action("pay:p1", "Late thing (due: 2026-11-10)"),
    action("pay:p1", "Do it now (due: 2026-11-22)"),
    action("pay:p1", "Later this week (owner: Dana, due: 2026-11-25)"),
    action("pay:p1", "Next month (due: 2026-12-30)"),
    line("nb-1", "Plan.md", 3, "Ship the page 📅 2026-11-24"),
    action("pay:p1", "Already done (due: 2026-11-01)", { done: true }),
  ];

  it("puts dated items in overdue, today, this week and later", () => {
    const s = homeSections(items, [], TODAY);
    expect(names(s.overdue)).toEqual(["Late thing (due: 2026-11-10)"]);
    expect(names(s.today)).toEqual(["Do it now (due: 2026-11-22)"]);
    expect(names(s.week)).toEqual(["Ship the page 📅 2026-11-24", "Later this week (owner: Dana, due: 2026-11-25)"]);
    expect(names(s.later)).toEqual(["Next month (due: 2026-12-30)"]);
    expect(dueSoon(s)).toHaveLength(4);
    expect(s.undated).toEqual([]);
  });

  it("places milestones among the tasks by date, leaves done ones out and calls a missed one overdue", () => {
    const s = homeSections(items, [
      milestone({ id: "a", title: "Beta", due: "2026-11-24" }), milestone({ id: "b", title: "Old", status: "done", due: "2026-11-01" }),
      milestone({ id: "c", title: "Lost", status: "missed", due: "2026-12-10" }), milestone({ id: "d", title: "Undated" }), milestone({ id: "e", title: "Launch", due: "2027-01-15" }),
    ], TODAY);
    expect(names(s.week)).toEqual(["Ship the page 📅 2026-11-24", "milestone: Beta", "Later this week (owner: Dana, due: 2026-11-25)"]);
    expect(names(s.overdue)).toEqual(["Late thing (due: 2026-11-10)", "milestone: Lost"]);
    expect(names(s.later)).toEqual(["Next month (due: 2026-12-30)", "milestone: Launch"]);
    expect(JSON.stringify(s)).not.toContain("Undated");
    expect(JSON.stringify(s)).not.toContain("Old");
  });

  it("orders the tasks of one day by priority", () => {
    const s = homeSections([action("pay:p1", "Low (due: 2026-11-23, priority: low)"), action("pay:p1", "High (due: 2026-11-23, priority: high)")], [], TODAY);
    expect(names(s.week).map((t) => t.split(" ")[0])).toEqual(["High", "Low"]);
  });

  it("groups undated items by note or page, with a count and the first item, the newest update first", () => {
    const s = homeSections([
      action("pay:old", "Old one", { title: "Old plan", updated: "2026-10-01T10:00:00" }),
      action("pay:new", "New B ⏬", { title: "New plan", updated: "2026-11-20T10:00:00", index: 2, line: 2 }),
      action("pay:new", "New A ⏫", { title: "New plan", updated: "2026-11-20T10:00:00", index: 1, line: 1 }),
      line("nb-1", "Ideas.md", 4, "A loose idea"), line("nb-1", "Ideas.md", 9, "Another idea"), line("nb-2", "Ideas.md", 1, "Same page name, other notebook"),
    ], [], TODAY);
    expect(s.undated.map((g) => [g.title, g.count, g.first.text])).toEqual([
      ["New plan", 2, "New A ⏫"], ["Old plan", 1, "Old one"], ["Ideas", 2, "A loose idea"], ["Ideas", 1, "Same page name, other notebook"],
    ]);
  });
});

describe("project scope", () => {
  const rows = [row("pay:p1", ["project/pay"]), row("led:l1", ["project/led"]), row("x:c1", ["concern/planning"], "Commitments: Cross-project"), row("x:o", ["concern/planning"], "Other")];
  const items = [
    action("pay:p1", "Pay action"), action("led:l1", "Ledger action"), action("x:c1", "Loose commitment (due: 2026-11-30)", { title: "Commitments: Cross-project" }),
    line("nb-pay", "Plan.md", 1, "Pay page task"), line("nb-led", "Plan.md", 1, "Ledger page task"), line("nb-misc", "Plan.md", 1, "Unrelated page task"),
    line("lm:demo:plans", "Roadmap.md", 1, "A Living Memory page task"),
  ];
  const folders = [notebook("nb-pay", "C:\\Work\\PayStream\\docs"), notebook("nb-led", "C:/work/ledger"), notebook("nb-misc", "C:/elsewhere"), notebook("nb-sibling", "C:/work/paystream-tools")];

  it("takes action items by the project tag and page tasks by the notebook folder inside a repository", () => {
    const pay = projectItems(items, { tag: "project/pay", repos: ["c:/work/paystream/"] }, rows, folders);
    expect(pay.map((t) => t.text)).toEqual(["Pay action", "Pay page task"]);
    const led = projectItems(items, { tag: "project/led", repos: ["C:/work/ledger"] }, rows, folders);
    expect(led.map((t) => t.text)).toEqual(["Ledger action", "Ledger page task"]);
    expect(projectItems(items, { tag: "project/none", repos: [] }, rows, folders)).toEqual([]);
  });

  it("finds the action items that belong to no project", () => {
    expect(looseItems(items, rows).map((t) => t.text)).toEqual(["Loose commitment (due: 2026-11-30)"]);
  });
});

describe("since you were last here", () => {
  it("reads whole days from the last visit, at least 1 and at most 90", () => {
    const now = Date.UTC(2026, 10, 22, 12);
    expect(sinceDays(now - 2 * 3600_000, now)).toBe(1);
    expect(sinceDays(now - DAY, now)).toBe(1);
    expect(sinceDays(now - DAY - 1, now)).toBe(2);
    expect(sinceDays(now - 3.2 * DAY, now)).toBe(4);
    expect(sinceDays(now - 400 * DAY, now)).toBe(90);
    expect(sinceDays(now + DAY, now)).toBe(1);
    expect(sinceDays(null, now)).toBe(7);
    expect(sinceDays(Number.NaN, now)).toBe(7);
  });

  describe("the visit stamp", () => {
    afterEach(() => vi.unstubAllGlobals());
    const store = () => {
      const data = new Map<string, string>();
      vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
      return data;
    };

    it("keeps one stamp per project and one for all projects", () => {
      const data = store();
      expect(lastVisit(visitScope(null))).toBeNull();
      rememberVisit(visitScope(null), 1000);
      rememberVisit(visitScope("pay"), 2000);
      expect([lastVisit("*"), lastVisit("pay"), lastVisit("led")]).toEqual([1000, 2000, null]);
      expect([...data.keys()].sort()).toEqual(["hivemind.home.visit.*", "hivemind.home.visit.pay"]);
    });

    it("works without browser storage", () => {
      vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
      expect(lastVisit("pay")).toBeNull();
      expect(() => rememberVisit("pay")).not.toThrow();
    });
  });
});

describe("Needs you rows for the Inbox", () => {
  it("has a row for each group with something, opening that group", () => {
    const rows = inboxNeeds({ ...NO_COUNTS, code: 4, memory: 6, pages: 1, maintenance: 2 }, 3, { unconfirmed: 2, archProposals: 1, archBehind: 2 });
    expect(rows).toEqual([
      { key: "code", text: "4 proposed file changes", kind: "code" },
      { key: "arch-proposals", text: "1 architecture update proposed", kind: "architecture" },
      { key: "arch-behind", text: "2 architecture snapshots behind", kind: "architecture" },
      { key: "due", text: "3 notes due for review", kind: "memory" },
      { key: "unconfirmed", text: "2 agent notes to confirm", kind: "memory" },
      { key: "pages", text: "1 page edit proposed by agents", kind: "pages" },
      { key: "maintenance", text: "2 changes made by maintenance to look over", kind: "maintenance" },
    ]);
  });

  it("has no row for an empty group, and none for captures (the page lists each batch)", () => {
    expect(inboxNeeds({ ...NO_COUNTS, captures: 2, skills: 1, architecture: 1 }, 0)).toEqual([]);
    expect(inboxNeeds({ ...NO_COUNTS, code: 1 }, 1).map((r) => r.text)).toEqual(["1 proposed file change", "1 note due for review"]);
  });
});
