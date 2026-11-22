// NS-4A: the plan that follows a rename or a move: which links are found, what they are rewritten to, and the pages that
// are left alone when they changed meanwhile.
import { describe, expect, it } from "vitest";
import type { Loaded, SaveOutcome } from "../../lib/notebooks";
import type { IncomingLink } from "../../lib/noteindex";
import { applyPlan, mapLinks, mapRichLinks, planRewrite, rewriteText, type PageIo, type Plan } from "./rewrite";
import type { PageEnv } from "./resolve";

const swap = (from: string, to: string) => (l: { page: string }) => (l.page === from ? to : null);

describe("mapLinks", () => {
  it("rewrites the page part of a wiki link and keeps its heading, block and alias", () => {
    const text = "See [[Old]], [[Old#Part]], [[Old|alias]], [[Old#Part|alias]], [[ Old ]] and ![[Old]] here.";
    expect(mapLinks(text, swap("Old", "New"))).toBe("See [[New]], [[New#Part]], [[New|alias]], [[New#Part|alias]], [[ New ]] and ![[New]] here.");
    expect(mapLinks("[[Old^block-1]] [[Other]]", swap("Old", "New"))).toBe("[[New^block-1]] [[Other]]");
  });

  it("leaves code, frontmatter and look-alikes alone", () => {
    const text = "---\nrelated: \"[[Old]]\"\n---\n[[Old]] here\n```\n[[Old]]\n```\nand `[[Old]]` but [[Old]]\n~~~md\n[[Old]]\n~~~\n    [[Old]]";
    expect(mapLinks(text, swap("Old", "New"))).toBe("---\nrelated: \"[[Old]]\"\n---\n[[New]] here\n```\n[[Old]]\n```\nand `[[Old]]` but [[New]]\n~~~md\n[[Old]]\n~~~\n    [[New]]");
  });

  it("rewrites a Markdown link's path, escaping spaces, and keeps its text, fragment and title", () => {
    const text = "[a](Old.md) [b](Old%20Page.md#Part) [c](<Old Page.md> \"t\") ![img](Old.md) [d](https://x.y/Old.md) [e](Other.md)";
    const out = mapLinks(text, (l) => (l.kind === "md" && l.page === "Old.md" ? "Sub/New page.md" : l.kind === "md" && l.page === "Old Page.md" ? "Sub/New page.md" : null));
    expect(out).toBe("[a](Sub/New%20page.md) [b](Sub/New%20page.md#Part) [c](<Sub/New page.md> \"t\") ![img](Old.md) [d](https://x.y/Old.md) [e](Other.md)");
  });

  it("a link in a table cell keeps its escaped pipe", () => {
    expect(mapLinks("| [[Old\\|alias]] | x |", swap("Old", "New"))).toBe("| [[New\\|alias]] | x |");
  });

  it("answers null for a link it leaves", () => {
    const seen: string[] = [];
    mapLinks("[[A]] [b](B.md)", (l) => { seen.push(`${l.kind}:${l.page}`); return null; });
    expect(seen).toEqual(["wiki:A", "md:B.md"]);
  });
});

describe("mapRichLinks", () => {
  const page = (value: string) => JSON.stringify({ schemaVersion: 1, content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "wikiLink", attrs: { value } }] }] } }, null, 2) + "\n";
  it("rewrites the target of a wikiLink node and keeps its heading and alias", () => {
    const out = mapRichLinks(page("Old#Part|alias"), swap("Old", "New"))!;
    expect(JSON.parse(out).content.content[0].content[0].attrs.value).toBe("New#Part|alias");
    expect(out.endsWith("\n")).toBe(true);
  });
  it("is null for text that is not a rich page", () => {
    expect(mapRichLinks("# Markdown", swap("a", "b"))).toBeNull();
  });
});

// ---- the plan --------------------------------------------------------------------------------------------------------

const pagesBy: Record<string, string[]> = {
  "nb-1": ["Inbox.md", "Plan.md", "Projects/Roadmap.md", "Projects/Sub/Deep.md", "Archive/Old.md", "Board.canvas", "Rich.hmdoc"],
  "nb-2": ["Journal.md", "Plan.md"],
};
const env: PageEnv = { notebooks: [{ id: "nb-1", title: "Main" }, { id: "nb-2", title: "Work" }], pagesOf: (id) => pagesBy[id], memory: [] };
const link = (notebook: string, path: string, raw: string, kind: IncomingLink["kind"] = "wiki", sha = "h-" + path): IncomingLink => ({ notebook, path, sha256: sha, raw, kind, embed: false, line: 1, context: raw });
const fixesOf = (plan: Plan, notebook: string, path: string) => plan.pages.find((p) => p.notebook === notebook && p.path === path)?.fixes;

describe("planRewrite", () => {
  it("a renamed page: bare links get the new name, links that still resolve are left alone", () => {
    const plan = planRewrite({
      notebook: "nb-1", from: "Plan.md", to: "Strategy.md", moved: ["Plan.md"], env,
      incoming: [link("nb-1", "Inbox.md", "Plan"), link("nb-1", "Projects/Roadmap.md", "Plan#Part"), link("nb-1", "Inbox.md", "Plan.md", "wiki"), link("nb-2", "Journal.md", "Main/Plan")],
    });
    // A link that wrote the extension keeps writing it.
    expect(fixesOf(plan, "nb-1", "Inbox.md")).toEqual([{ kind: "wiki", from: "Plan", to: "Strategy" }, { kind: "wiki", from: "Plan.md", to: "Strategy.md" }]);
    expect(fixesOf(plan, "nb-1", "Projects/Roadmap.md")).toEqual([{ kind: "wiki", from: "Plan", to: "Strategy" }]);
    // From another notebook the link names the notebook and keeps naming it.
    expect(fixesOf(plan, "nb-2", "Journal.md")).toEqual([{ kind: "wiki", from: "Main/Plan", to: "Main/Strategy" }]);
    expect(plan.stuck).toEqual([]);
    expect(plan.pages.find((p) => p.path === "Inbox.md")).toMatchObject({ links: 2, sha256: "h-Inbox.md" });
  });

  it("a page moved to another folder: a bare name still reaches it, a path does not", () => {
    const plan = planRewrite({
      notebook: "nb-1", from: "Projects/Roadmap.md", to: "Archive/Roadmap.md", moved: ["Projects/Roadmap.md"], env,
      incoming: [link("nb-1", "Inbox.md", "Roadmap"), link("nb-1", "Inbox.md", "Projects/Roadmap"), link("nb-1", "Plan.md", "Projects/Roadmap.md")],
    });
    expect(fixesOf(plan, "nb-1", "Inbox.md")).toEqual([{ kind: "wiki", from: "Projects/Roadmap", to: "Archive/Roadmap" }]);
    expect(fixesOf(plan, "nb-1", "Plan.md")).toEqual([{ kind: "wiki", from: "Projects/Roadmap.md", to: "Archive/Roadmap.md" }]);
    // Only links that must change are counted: the bare name in Inbox.md keeps working.
    expect(plan.pages.find((p) => p.path === "Inbox.md")?.links).toBe(1);
  });

  it("a name that would be a tie after the move is written as a path", () => {
    const tied: PageEnv = { ...env, pagesOf: (id) => (id === "nb-1" ? ["Inbox.md", "Plan.md", "Projects/Roadmap.md", "Archive/Roadmap.md"] : pagesBy[id]) };
    const plan = planRewrite({ notebook: "nb-1", from: "Projects/Roadmap.md", to: "Roadmap.md", moved: ["Projects/Roadmap.md"], env: tied, incoming: [link("nb-1", "Inbox.md", "Projects/Roadmap")] });
    // Roadmap at the root and in Archive/ tie as a bare name from Inbox.md, so the path from the root is written.
    expect(fixesOf(plan, "nb-1", "Inbox.md")).toEqual([{ kind: "wiki", from: "Projects/Roadmap", to: "Roadmap" }]);
    // From the folder that has a Roadmap of its own, the same-folder rule always picks that one: no spelling reaches the
    // moved page, so the link is reported, not guessed at.
    const second = planRewrite({ notebook: "nb-1", from: "Projects/Roadmap.md", to: "Roadmap.md", moved: ["Projects/Roadmap.md"], env: tied, incoming: [link("nb-1", "Archive/Roadmap.md", "Projects/Roadmap")] });
    expect(second.pages).toEqual([]);
    expect(second.stuck).toEqual([{ notebook: "nb-1", path: "Archive/Roadmap.md", raw: "Projects/Roadmap", why: "no way of writing the link reaches the page again" }]);
  });

  it("a moved folder rewrites path links into it, including links between the moved pages", () => {
    const plan = planRewrite({
      notebook: "nb-1", from: "Projects", to: "Elsewhere/Stuff", moved: ["Projects/Roadmap.md", "Projects/Sub/Deep.md"], env,
      incoming: [
        link("nb-1", "Inbox.md", "Projects/Roadmap"), link("nb-1", "Inbox.md", "Deep"),
        link("nb-1", "Projects/Roadmap.md", "Projects/Sub/Deep"), link("nb-1", "Projects/Roadmap.md", "Sub/Deep"),
        link("nb-1", "Projects/Sub/Deep.md", "../Roadmap.md", "md"),
      ],
    });
    // A path that named the old folder names the new one; a bare name still finds its page.
    expect(fixesOf(plan, "nb-1", "Inbox.md")).toEqual([{ kind: "wiki", from: "Projects/Roadmap", to: "Elsewhere/Stuff/Roadmap" }]);
    // The page that moved is named by where it will be, and a link relative to its own folder keeps working.
    expect(fixesOf(plan, "nb-1", "Elsewhere/Stuff/Roadmap.md")).toEqual([{ kind: "wiki", from: "Projects/Sub/Deep", to: "Elsewhere/Stuff/Sub/Deep" }]);
    // A relative link between two moved pages still works.
    expect(plan.pages.some((p) => p.path === "Elsewhere/Stuff/Sub/Deep.md")).toBe(false);
    expect(plan.stuck).toEqual([]);
  });

  it("a link whose path still ends the same way after a move needs no rewrite", () => {
    const plan = planRewrite({ notebook: "nb-1", from: "Projects", to: "Work/Projects", moved: ["Projects/Roadmap.md"], env, incoming: [link("nb-1", "Inbox.md", "Projects/Roadmap")] });
    expect(plan.pages).toEqual([]);
  });

  it("a Markdown link is rewritten as a relative path from where its page will be", () => {
    const plan = planRewrite({
      notebook: "nb-1", from: "Archive/Old.md", to: "Projects/Sub/Old.md", moved: ["Archive/Old.md"], env,
      incoming: [link("nb-1", "Inbox.md", "Archive/Old.md", "md"), link("nb-1", "Projects/Roadmap.md", "../Archive/Old.md", "md")],
    });
    expect(fixesOf(plan, "nb-1", "Inbox.md")).toEqual([{ kind: "md", from: "Archive/Old.md", to: "Projects/Sub/Old.md" }]);
    expect(fixesOf(plan, "nb-1", "Projects/Roadmap.md")).toEqual([{ kind: "md", from: "../Archive/Old.md", to: "Sub/Old.md" }]);
  });

  it("links the resolver does not send to the moved page are not touched, and canvases are listed as stuck", () => {
    const plan = planRewrite({
      notebook: "nb-1", from: "Plan.md", to: "Strategy.md", moved: ["Plan.md"], env,
      // Journal.md is in another notebook that has its own Plan; the canvas card names the file.
      incoming: [link("nb-2", "Journal.md", "Plan"), link("nb-1", "Board.canvas", "Plan.md", "file")],
    });
    expect(plan.pages).toEqual([]);
    expect(plan.stuck).toEqual([{ notebook: "nb-1", path: "Board.canvas", raw: "Plan.md", why: "Hivemind does not rewrite links in this kind of page" }]);
  });

  it("a rich page's links are planned like any other page's", () => {
    const plan = planRewrite({ notebook: "nb-1", from: "Plan.md", to: "Strategy.md", moved: ["Plan.md"], env, incoming: [link("nb-1", "Rich.hmdoc", "Plan")] });
    expect(fixesOf(plan, "nb-1", "Rich.hmdoc")).toEqual([{ kind: "wiki", from: "Plan", to: "Strategy" }]);
  });
});

describe("rewriteText", () => {
  it("rewrites by the page's kind", () => {
    const fixes = [{ kind: "wiki" as const, from: "Plan", to: "Strategy" }];
    expect(rewriteText("A.md", "[[plan]] and [[Plan#H]]", fixes)).toBe("[[Strategy]] and [[Strategy#H]]");
    const rich = JSON.stringify({ content: { type: "doc", content: [{ type: "wikiLink", attrs: { value: "Plan" } }] } });
    expect(JSON.parse(rewriteText("A.hmdoc", rich, fixes)!).content.content[0].attrs.value).toBe("Strategy");
    expect(rewriteText("A.hmdoc", "not json", fixes)).toBeNull();
  });
});

// ---- applying it -----------------------------------------------------------------------------------------------------

describe("applyPlan", () => {
  const plan: Plan = {
    notebook: "nb-1", from: "Plan.md", to: "Strategy.md", stuck: [],
    pages: ["A.md", "B.md", "C.md", "D.md", "E.md"].map((path) => ({ notebook: "nb-1", path, sha256: `sha-${path}`, links: 1, fixes: [{ kind: "wiki" as const, from: "Plan", to: "Strategy" }] })),
  };
  const files = new Map<string, { text: string; sha: string }>();
  const saved: string[] = [];
  const written: string[] = [];
  const io = (overrides: Partial<PageIo> = {}): PageIo => ({
    read: async (_nb, path) => {
      const f = files.get(path);
      if (!f) throw new Error(`${path} does not exist`);
      return { text: f.text, sha256: f.sha, size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false } as Loaded;
    },
    save: async (_nb, path, text, pre) => {
      if (files.get(path)?.sha !== pre.sha256) return { status: "stale", sha256: "x" } as SaveOutcome;
      saved.push(path);
      files.set(path, { text, sha: `new-${path}` });
      return { status: "saved", sha256: `new-${path}`, size: 1, mtimeMs: 2 } as SaveOutcome;
    },
    unsaved: () => false,
    written: (_nb, path) => { written.push(path); },
    ...overrides,
  });

  it("writes every page that still has the bytes the plan was made from, and lists the rest with the reason", async () => {
    files.clear(); saved.length = 0; written.length = 0;
    files.set("A.md", { text: "[[Plan]]", sha: "sha-A.md" });
    files.set("B.md", { text: "[[Plan]] edited elsewhere", sha: "changed" });          // changed meanwhile
    files.set("C.md", { text: "[[Plan]]", sha: "sha-C.md" });                           // has unsaved edits in a tab
    // D.md is gone.
    files.set("E.md", { text: "no links any more", sha: "sha-E.md" });                  // already says what it should
    const out = await applyPlan(plan, io({ unsaved: (_nb, path) => path === "C.md" }));
    expect(saved).toEqual(["A.md"]);
    expect(files.get("A.md")!.text).toBe("[[Strategy]]");
    expect(files.get("B.md")!.text).toBe("[[Plan]] edited elsewhere");
    expect(written).toEqual(["A.md"]);
    expect(out.updated.map((p) => p.path)).toEqual(["A.md"]);
    expect(out.skipped.map((s) => [s.page.path, s.why])).toEqual([
      ["B.md", "it changed after Hivemind read it"],
      ["C.md", "it has unsaved edits in a tab"],
      ["D.md", "D.md does not exist"],
      ["E.md", "its links already say what they should"],
    ]);
  });

  it("a page that changes between the read and the save is skipped, not overwritten", async () => {
    files.clear(); saved.length = 0;
    files.set("A.md", { text: "[[Plan]]", sha: "sha-A.md" });
    const out = await applyPlan({ ...plan, pages: [plan.pages[0]] }, io({
      save: async () => ({ status: "stale", sha256: "newer" }),
    }));
    expect(out.updated).toEqual([]);
    expect(out.skipped[0].why).toBe("it changed while the links were written");
    expect(files.get("A.md")!.text).toBe("[[Plan]]");
  });

  it("a read-only page is skipped", async () => {
    files.clear();
    const out = await applyPlan({ ...plan, pages: [plan.pages[0]] }, io({ read: async () => ({ text: "[[Plan]]", sha256: "sha-A.md", size: 1, mtimeMs: 1, format: {}, readOnly: "This file is read-only on disk", binary: false } as unknown as Loaded) }));
    expect(out.skipped[0].why).toBe("This file is read-only on disk");
  });
});
