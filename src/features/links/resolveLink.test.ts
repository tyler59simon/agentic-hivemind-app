// NS-4A: where a link points when the page's own notebook does not answer it: other notebooks, then memory notes.
import { describe, expect, it } from "vitest";
import { resolveHref, resolveLink, resolveWritten, type PageEnv } from "./resolve";

const pagesBy: Record<string, string[]> = {
  "nb-1": ["Inbox.md", "Plan.md", "Work/Roadmap.md", "Notes/Daily.md"],
  "nb-2": ["Journal.md", "Plan.md", "Archive/Old.md", "Roadmap.md"],
  "nb-3": ["Plan.md", "Solo.md", "Work/Item.md"],
};
const notebooks = [{ id: "nb-1", title: "Main" }, { id: "nb-2", title: "Work" }, { id: "nb-3", title: "Side" }];
const memory = [
  { ref: "demo:aaa", title: "Release checklist", domain: "demo" },
  { ref: "demo:bbb", title: "Plan", domain: "demo" },
  { ref: "other:ccc", title: "Shared title", domain: "other" },
  { ref: "demo:ddd", title: "Shared title", domain: "demo" },
];
const env: PageEnv = { notebooks, pagesOf: (id) => pagesBy[id], memory };
const from = (path: string, notebook = "nb-1") => ({ notebook, path });

describe("resolveLink", () => {
  it("answers from the page's own notebook first, whatever other notebooks hold", () => {
    expect(resolveLink("Plan", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-1", path: "Plan.md" } });
    expect(resolveLink("Plan", from("Journal.md", "nb-2"), env)).toEqual({ ref: { notebook: "nb-2", path: "Plan.md" } });
  });

  it("then looks in the other notebooks: a name only one of them has is the answer", () => {
    expect(resolveLink("Journal", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-2", path: "Journal.md" } });
    expect(resolveLink("Solo", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-3", path: "Solo.md" } });
    expect(resolveLink("Old", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-2", path: "Archive/Old.md" } });
  });

  it("[[Notebook/Page]] names a notebook by its title in the first part", () => {
    expect(resolveLink("Work/Roadmap", from("Inbox.md", "nb-3"), env)).toEqual({ ref: { notebook: "nb-2", path: "Roadmap.md" } });
    expect(resolveLink("work/archive/old", from("Inbox.md", "nb-3"), env)).toEqual({ ref: { notebook: "nb-2", path: "Archive/Old.md" } });
    // With the title it is no tie, although two other notebooks have a Plan.
    expect(resolveLink("Side/Plan", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-3", path: "Plan.md" } });
  });

  it("[[Notebook/Page]] against a folder of the same name: the page's own notebook wins when the folder has the page", () => {
    // nb-1 has a folder Work with Roadmap in it, and nb-2 is a notebook titled Work with its own Roadmap.
    expect(resolveLink("Work/Roadmap", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-1", path: "Work/Roadmap.md" } });
    // A folder without the page does not hide the notebook.
    expect(resolveLink("Work/Journal", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-2", path: "Journal.md" } });
    // The same path from a page of the notebook titled Work is that notebook's own.
    expect(resolveLink("Work/Item", from("Journal.md", "nb-2"), env)).toEqual({ ref: { notebook: "nb-3", path: "Work/Item.md" } });
  });

  it("several equal answers are a tie, and each names the form that writes only it", () => {
    const hit = resolveLink("Plan", from("Solo.md", "nb-3"), { ...env, pagesOf: (id) => (id === "nb-3" ? ["Solo.md"] : pagesBy[id]) });
    expect(hit).toMatchObject({ ambiguous: [
      { label: "Main / Plan.md", explicit: "Main/Plan", open: { ref: { notebook: "nb-1", path: "Plan.md" } } },
      { label: "Work / Plan.md", explicit: "Work/Plan", open: { ref: { notebook: "nb-2", path: "Plan.md" } } },
    ] });
    // The explicit forms really are unambiguous.
    for (const choice of (hit as { ambiguous: { explicit: string; open: { ref: unknown } }[] }).ambiguous) {
      expect(resolveLink(choice.explicit, from("Solo.md", "nb-3"), env)).toEqual({ ref: choice.open.ref });
    }
  });

  it("ties inside the page's own notebook stay ties, with path forms", () => {
    const own = ["Archive/Plan.md", "Projects/Plan.md", "Inbox.md"];
    const hit = resolveLink("Plan", from("Inbox.md"), { ...env, pagesOf: () => own });
    expect(hit).toMatchObject({ ambiguous: [{ explicit: "Archive/Plan" }, { explicit: "Projects/Plan" }] });
  });

  it("then memory notes by exact title, ignoring case", () => {
    expect(resolveLink("release checklist", from("Inbox.md"), env)).toEqual({ note: memory[0] });
    expect(resolveLink("Release", from("Inbox.md"), env)).toEqual({ missing: "Release.md" });
  });

  it("a page of the same name beats a memory note, and [[mem:Title]] names the note", () => {
    expect(resolveLink("Plan", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-1", path: "Plan.md" } });
    expect(resolveLink("mem:Plan", from("Inbox.md"), env)).toEqual({ note: memory[1] });
    expect(resolveLink("mem: Release checklist#Part", from("Inbox.md"), env)).toEqual({ note: memory[0] });
    expect(resolveLink("mem:Nothing here", from("Inbox.md"), env)).toEqual({ absent: "No memory note is called Nothing here" });
  });

  it("two memory notes of one title are a tie that cannot be written away, since the explicit form is shared", () => {
    const hit = resolveLink("mem:Shared title", from("Inbox.md"), env);
    expect(hit).toMatchObject({ ambiguous: [{ explicit: "mem:Shared title", detail: "Memory note in other" }, { explicit: "mem:Shared title", detail: "Memory note in demo" }] });
  });

  it("with nothing found it says where a new page would go", () => {
    expect(resolveLink("Brand new", from("Work/Roadmap.md"), env)).toEqual({ missing: "Work/Brand new.md" });
  });

  it("a link names a page, not its heading or alias", () => {
    expect(resolveLink("Journal#Part", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-2", path: "Journal.md" } });
    expect(resolveLink("Journal|my journal", from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-2", path: "Journal.md" } });
  });

  it("a notebook whose pages are not known is skipped, not an error", () => {
    expect(resolveLink("Journal", from("Inbox.md"), { ...env, pagesOf: (id) => (id === "nb-1" ? pagesBy["nb-1"] : undefined) })).toEqual({ missing: "Journal.md" });
  });
});

describe("links written as Markdown or canvas cards", () => {
  const pages = ["Inbox.md", "Projects/Plan.md", "Projects/Sub/Deep.md", "Archive/Old plan.md"];
  it("resolves a relative path from the page's own folder, and from the notebook's root", () => {
    expect(resolveHref("Plan.md", from("Projects/Deep.md"), pages)).toEqual({ notebook: "nb-1", path: "Projects/Plan.md" });
    expect(resolveHref("../Inbox.md", from("Projects/Plan.md"), pages)).toEqual({ notebook: "nb-1", path: "Inbox.md" });
    expect(resolveHref("Sub/Deep.md#Part", from("Projects/Plan.md"), pages)).toEqual({ notebook: "nb-1", path: "Projects/Sub/Deep.md" });
    expect(resolveHref("Archive/Old plan.md", from("Projects/Plan.md"), pages)).toEqual({ notebook: "nb-1", path: "Archive/Old plan.md" });
    expect(resolveHref("../../Inbox.md", from("Projects/Plan.md"), pages)).toBeNull();
    expect(resolveHref("Nowhere.md", from("Inbox.md"), pages)).toBeNull();
  });

  it("resolveWritten covers every kind and says where a missing page would go", () => {
    expect(resolveWritten({ raw: "../Inbox.md", kind: "md" }, from("Projects/Plan.md"), env, pages)).toEqual({ ref: { notebook: "nb-1", path: "Inbox.md" } });
    expect(resolveWritten({ raw: "Missing.md", kind: "md" }, from("Projects/Plan.md"), env, pages)).toEqual({ missing: "Projects/Missing.md" });
    expect(resolveWritten({ raw: "Projects/Plan.md", kind: "file" }, from("Board.canvas"), env, pages)).toEqual({ ref: { notebook: "nb-1", path: "Projects/Plan.md" } });
    expect(resolveWritten({ raw: "Journal", kind: "wiki" }, from("Inbox.md"), env)).toEqual({ ref: { notebook: "nb-2", path: "Journal.md" } });
  });
});
