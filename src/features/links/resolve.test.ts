import { describe, expect, it } from "vitest";
import { resolvePage } from "./resolve";

const pages = ["Inbox.md", "Projects/Plan.md", "Projects/Notes.md", "Archive/Plan.md", "Archive/Old/Notes.md", "Logs/run.log", "Deep/a/b/Only.md"];
const from = (path: string) => ({ notebook: "nb-1", path });
const at = (path: string) => ({ ref: { notebook: "nb-1", path } });

describe("resolvePage", () => {
  it("prefers the page in the same folder", () => {
    expect(resolvePage("Plan", from("Projects/Notes.md"), pages)).toEqual(at("Projects/Plan.md"));
    expect(resolvePage("plan", from("Archive/x.md"), pages)).toEqual(at("Archive/Plan.md"));
  });

  it("then the shortest path anywhere, and reports a tie", () => {
    expect(resolvePage("Notes", from("Inbox.md"), pages)).toEqual(at("Projects/Notes.md"));
    expect(resolvePage("Only", from("Inbox.md"), pages)).toEqual(at("Deep/a/b/Only.md"));
    expect(resolvePage("Plan", from("Inbox.md"), pages)).toEqual({ ambiguous: [{ notebook: "nb-1", path: "Projects/Plan.md" }, { notebook: "nb-1", path: "Archive/Plan.md" }] });
  });

  it("takes a path from the root, then from this folder", () => {
    expect(resolvePage("Archive/Plan", from("Projects/Notes.md"), pages)).toEqual(at("Archive/Plan.md"));
    expect(resolvePage("Old/Notes", from("Archive/Plan.md"), pages)).toEqual(at("Archive/Old/Notes.md"));
    // Or any page whose path ends with it, not a page that only shares the name.
    expect(resolvePage("Old/Notes", from("Inbox.md"), pages)).toEqual(at("Archive/Old/Notes.md"));
    expect(resolvePage("Archive\\Plan.md", from("Inbox.md"), pages)).toEqual(at("Archive/Plan.md"));
  });

  it("names other files by their full name", () => {
    expect(resolvePage("run.log", from("Inbox.md"), pages)).toEqual(at("Logs/run.log"));
    expect(resolvePage("run", from("Inbox.md"), pages)).toEqual({ missing: "run.md" });
  });

  it("suggests where a missing page would go", () => {
    expect(resolvePage("New idea", from("Projects/Plan.md"), pages)).toEqual({ missing: "Projects/New idea.md" });
    expect(resolvePage("Later/Thing", from("Projects/Plan.md"), pages)).toEqual({ missing: "Later/Thing.md" });
  });
});
