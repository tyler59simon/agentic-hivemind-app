// NS-7A: date tokens, the daily path and the date it names, the settings a notebook resolves to, and template expansion.
import { describe, expect, it } from "vitest";
import { addDays, dailyDateOf, dailyPatch, dailyPath, DEFAULT_DAILY, expandTemplate, formatDate, lineAndColumn, resolveDaily, templatePath, templatesIn, type DailySettings } from "./daily";

// Local time on purpose: the functions use the local zone, so the tests build local dates.
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s);
const settings = (over: Partial<DailySettings> = {}): DailySettings => ({ ...DEFAULT_DAILY, ...over });

describe("date tokens", () => {
  const d = at(2026, 11, 22, 14, 5, 9); // a Sunday

  it("writes the numeric tokens, padded or not", () => {
    expect(formatDate(d, "YYYY-MM-DD")).toBe("2026-11-22");
    expect(formatDate(at(2026, 3, 4), "YY/M/D")).toBe("26/3/4");
    expect(formatDate(d, "HH:mm:ss")).toBe("14:05:09");
    expect(formatDate(d, "H:m:s")).toBe("14:5:9");
    expect(formatDate(d, "hh:mm A")).toBe("02:05 PM");
    expect(formatDate(at(2026, 1, 1, 0, 30), "h:mm a")).toBe("12:30 am");
  });

  it("writes names", () => {
    expect(formatDate(d, "dddd, MMMM D")).toBe("Sunday, November 22");
    expect(formatDate(d, "ddd MMM DD")).toBe("Sun Nov 22");
    expect(formatDate(d, "dd")).toBe("Su");
  });

  it("writes the week of the year both ways: ww from Sunday with January 1 in week 1, WW the ISO week", () => {
    // 2026-01-01 is a Thursday: week 1 of the Sunday-first calendar runs Dec 28 to Jan 3, and so does ISO week 1.
    expect(formatDate(at(2026, 1, 1), "ww")).toBe("01");
    expect(formatDate(at(2026, 1, 3), "ww")).toBe("01");
    expect(formatDate(at(2026, 1, 4), "ww")).toBe("02");
    expect(formatDate(at(2026, 11, 22), "ww")).toBe("48");
    expect(formatDate(at(2026, 11, 22), "WW")).toBe("47");
    expect(formatDate(at(2026, 11, 23), "W")).toBe("48");
    // 2021-01-01 is a Friday: ISO calls it week 53 of 2020; the Sunday-first week is 1.
    expect(formatDate(at(2021, 1, 1), "WW")).toBe("53");
    expect(formatDate(at(2021, 1, 1), "ww")).toBe("01");
    expect(formatDate(at(2026, 5, 6), "Q")).toBe("2");
  });

  it("keeps [text] and other characters as written", () => {
    expect(formatDate(d, "YYYY-[W]WW")).toBe("2026-W47");
    expect(formatDate(d, "[Today is] dddd")).toBe("Today is Sunday");
    expect(formatDate(d, "YYYY/MM/YYYY-MM-DD")).toBe("2026/11/2026-11-22");
    expect(formatDate(d, "")).toBe("");
  });
});

describe("the daily page", () => {
  const day = at(2026, 11, 22);

  it("is in the folder, named by the format", () => {
    expect(dailyPath(settings(), day)).toBe("Daily/2026-11-22.md");
    expect(dailyPath(settings({ folder: "" }), day)).toBe("2026-11-22.md");
    expect(dailyPath(settings({ folder: "Journal", format: "YYYY/MM/DD ddd" }), day)).toBe("Journal/2026/11/22 Sun.md");
  });

  it("gives the date back from its path", () => {
    for (const s of [settings(), settings({ folder: "" }), settings({ folder: "J", format: "YYYY/MM/DD ddd" }), settings({ format: "D MMMM YYYY" }), settings({ format: "YY.M.D" })]) {
      const date = at(2026, 3, 7);
      expect(dailyDateOf(s, dailyPath(s, date))?.getTime(), JSON.stringify(s)).toBe(date.getTime());
    }
  });

  it("is not claimed by a page that only looks similar", () => {
    const s = settings();
    expect(dailyDateOf(s, "Daily/2026-13-01.md")).toBeNull();
    expect(dailyDateOf(s, "Daily/2026-02-30.md")).toBeNull();
    expect(dailyDateOf(s, "Daily/notes.md")).toBeNull();
    expect(dailyDateOf(s, "Other/2026-11-22.md")).toBeNull();
    expect(dailyDateOf(s, "Daily/2026-11-22.txt")).toBeNull();
    expect(dailyDateOf(s, "Daily/sub/2026-11-22.md")).toBeNull();
    // A weekday name that is wrong for the date does not write the same path back.
    expect(dailyDateOf(settings({ format: "YYYY-MM-DD ddd" }), "Daily/2026-11-22 Mon.md")).toBeNull();
    // A format with no day to find has no date.
    expect(dailyDateOf(settings({ format: "YYYY-[W]WW" }), "Daily/2026-W47.md")).toBeNull();
  });

  it("matches the folder and name without regard to case, as Windows does", () => {
    expect(dailyDateOf(settings(), "daily/2026-11-22.MD")?.getDate()).toBe(22);
  });

  it("steps by whole days across a month and a year", () => {
    expect(formatDate(addDays(at(2026, 12, 31), 1), "YYYY-MM-DD")).toBe("2027-01-01");
    expect(formatDate(addDays(at(2026, 3, 1), -1), "YYYY-MM-DD")).toBe("2026-02-28");
  });

  it("finds the template page by name", () => {
    expect(templatePath("Templates/Daily")).toBe("Templates/Daily.md");
    expect(templatePath("Templates/Daily.md")).toBe("Templates/Daily.md");
  });
});

describe("the settings a notebook resolves to", () => {
  it("are the defaults with nothing set", () => {
    expect(resolveDaily(undefined)).toEqual(DEFAULT_DAILY);
    expect(resolveDaily("not an object")).toEqual(DEFAULT_DAILY);
    expect(resolveDaily([1])).toEqual(DEFAULT_DAILY);
  });

  it("take what the user stored, ignoring a field of the wrong kind", () => {
    const got = resolveDaily({ folder: "Journal\\2026/", format: "DD-MM-YYYY", template: "Templates/Day", templates: "T", inbox: "In.md", extra: 1 });
    expect(got).toEqual({ folder: "Journal/2026", format: "DD-MM-YYYY", template: "Templates/Day", templates: "T", inbox: "In.md" });
    expect(resolveDaily({ folder: 3, format: null, template: ["x"] })).toEqual(DEFAULT_DAILY);
  });

  it("fall back to the vault's Obsidian settings, below what the user stored", () => {
    const obsidian = { daily: { folder: "Days", format: "YYYY/MM/DD", template: "Tpl/Day" }, templates: { folder: "Tpl" } };
    expect(resolveDaily({}, {}, obsidian)).toEqual({ folder: "Days", format: "YYYY/MM/DD", template: "Tpl/Day", templates: "Tpl", inbox: "Inbox.md" });
    expect(resolveDaily({ format: "DD" }, {}, obsidian)).toMatchObject({ folder: "Days", format: "DD" });
    // An Obsidian vault that keeps daily notes in its root says so with an empty folder.
    expect(resolveDaily({}, {}, { daily: { folder: "" } }).folder).toBe("");
    // A damaged Obsidian file is ignored.
    expect(resolveDaily({}, {}, { daily: "x", templates: 3 })).toEqual(DEFAULT_DAILY);
  });

  it("count a folder notebook's older top-level templates and inbox after the daily object's own", () => {
    expect(resolveDaily({}, { templates: "Tpls", inbox: "Box.md" })).toMatchObject({ templates: "Tpls", inbox: "Box.md" });
    expect(resolveDaily({ templates: "Mine" }, { templates: "Tpls" }, { templates: { folder: "Obs" } }).templates).toBe("Mine");
    expect(resolveDaily({}, { templates: "Tpls" }, { templates: { folder: "Obs" } }).templates).toBe("Tpls");
  });

  it("are patched from the dialog: blank fields go, other stored fields stay", () => {
    expect(dailyPatch({ folder: "A", inbox: "I.md", future: true }, { folder: "B", format: " YYYY ", template: "" })).toEqual({ folder: "B", format: "YYYY", inbox: "I.md", future: true });
    expect(dailyPatch(undefined, { folder: "" })).toEqual({});
    expect(dailyPatch({ folder: "A" }, { folder: "", template: null })).toEqual({});
  });
});

describe("template expansion", () => {
  const ctx = { title: "Plan", date: at(2026, 11, 22, 9, 7), notebook: "Work", project: "Hivemind" };

  it("fills every variable", () => {
    const { text, cursor } = expandTemplate("# {{title}}\nnotebook {{notebook}}, project {{project}}\n{{date}} {{time}}\n", ctx);
    expect(text).toBe("# Plan\nnotebook Work, project Hivemind\n2026-11-22 09:07\n");
    expect(cursor).toBeNull();
  });

  it("takes a format for the date and the time", () => {
    expect(expandTemplate("{{date:dddd D MMMM}} / {{date:YYYY-[W]WW}} / {{time:hh:mm A}}", ctx).text).toBe("Sunday 22 November / 2026-W47 / 09:07 AM");
  });

  it("leaves what it does not know as written", () => {
    expect(expandTemplate("{{unknown}} {{Title}} {{ title }} {{title:x}} {{notebook:y}} {{ date }} {title} {{date", ctx).text)
      .toBe("{{unknown}} {{Title}} {{ title }} {{title:x}} {{notebook:y}} {{ date }} {title} {{date");
  });

  it("leaves an empty project empty and does not expand what a variable's value holds", () => {
    expect(expandTemplate("[{{project}}]", { ...ctx, project: undefined }).text).toBe("[]");
    expect(expandTemplate("{{title}}", { ...ctx, title: "{{date}}" }).text).toBe("{{date}}");
  });

  it("removes {{cursor}} and says where it was, in the expanded text", () => {
    const { text, cursor } = expandTemplate("# {{title}}\n\n{{cursor}}\n\nend {{cursor}}", ctx);
    expect(text).toBe("# Plan\n\n\n\nend ");
    expect(cursor).toBe(8);
    expect(lineAndColumn(text, cursor!)).toEqual({ line: 2, col: 0 });
    expect(lineAndColumn("ab\ncde", 5)).toEqual({ line: 1, col: 2 });
  });

  it("finds the templates under the folder", () => {
    expect(templatesIn(["Templates/B.md", "Templates/A.md", "Templates/img.png", "Other/C.md", "templates2/D.md", "Templates/Sub/E.markdown"], "Templates"))
      .toEqual(["Templates/A.md", "Templates/B.md", "Templates/Sub/E.markdown"]);
    expect(templatesIn(["a.md", "B/c.md"], "")).toEqual(["a.md", "B/c.md"]);
  });
});
