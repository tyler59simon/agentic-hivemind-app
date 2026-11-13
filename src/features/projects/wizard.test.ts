import { describe, expect, it } from "vitest";
import type { Project } from "../../lib/lm";
import { sections } from "../../lib/note";
import { changedProject, charterBody, defaultCharterDomain, mergeTags, parseAliases, parseRepos, SLUG_RE, slugify, validateCreate } from "./wizard";

describe("slugify", () => {
  it("makes valid slugs", () => {
    expect(slugify("  My Cool_Project!! ")).toBe("my-cool-project");
    expect(slugify("A".repeat(60))).toHaveLength(40);
    expect(SLUG_RE.test(slugify("x".repeat(39) + " y"))).toBe(true);
    expect(slugify("---")).toBe("");
  });
});

describe("parseRepos", () => {
  it("keeps absolute paths with forward slashes, de-duplicated", () => {
    expect(parseRepos("C:\\Code\\App\n c:/code/app \n\n/home/me/x\nrel/path")).toEqual({ repos: ["C:/Code/App", "/home/me/x"], invalid: ["rel/path"] });
  });
});

describe("parseAliases", () => {
  it("trims, de-duplicates and limits", () => {
    expect(parseAliases(" a, b ,A,, c,d,e,f").aliases).toEqual(["a", "b", "c", "d", "e"]);
    expect(parseAliases("a,b,c,d,e,f").extra).toBe(1);
    expect(parseAliases("x".repeat(41)).tooLong).toHaveLength(1);
  });
});

describe("defaultCharterDomain", () => {
  const domains = [
    { name: "sandbox", bound: true, prefixes: ["C:\\Users\\tyler\\Documents\\Sandbox"] },
    { name: "agentic-living-memory", bound: true, prefixes: ["C:\\Users\\tyler\\Documents\\Sandbox\\agentic-living-memory"] },
    { name: "unbound", bound: false, prefixes: ["C:\\Users\\tyler\\Documents\\Sandbox\\agentic-hivemind"] },
  ];
  it("picks the longest containing bound prefix", () => {
    expect(defaultCharterDomain(["C:/Users/tyler/Documents/Sandbox/agentic-hivemind"], domains)).toBe("sandbox");
    expect(defaultCharterDomain(["c:/users/tyler/documents/sandbox/agentic-living-memory/src"], domains)).toBe("agentic-living-memory");
  });
  it("is segment-aware and may find nothing", () => {
    expect(defaultCharterDomain(["C:/Users/tyler/Documents/Sandbox2/x"], domains)).toBeUndefined();
    expect(defaultCharterDomain([], domains)).toBeUndefined();
  });
});

describe("charterBody", () => {
  it("round-trips the summary and details", () => {
    const body = charterBody({ purpose: " Ship it. ", objectives: "one\ntwo", guidance: "Be careful" });
    expect(sections(body)).toEqual({ summary: "Ship it.", details: "- **Objectives:** one; two\n- **Agent guidance:** Be careful" });
  });
  it("leaves details out when empty", () => {
    expect(sections(charterBody({ purpose: "Only." }))).toEqual({ summary: "Only." });
  });
});

describe("validateCreate", () => {
  const ok = { name: "App", slug: "app", repos: "C:/code/app", aliases: "", description: "", purpose: "Why" };
  it("accepts a good form and flags bad ones", () => {
    expect(validateCreate(ok)).toEqual([]);
    expect(validateCreate({ ...ok, slug: "Bad Slug", repos: "rel", purpose: " " }).length).toBe(3);
    expect(validateCreate(ok, ["app"])[0]).toMatch(/already exists/);
    expect(validateCreate({ ...ok, repos: "" })[0]).toMatch(/repository/);
  });
});

describe("changedProject", () => {
  const before: Project = { slug: "app", name: "App", status: "active", repos: ["C:\\code\\app"], aliases: ["a"], description: "d", charter: null, created: "", updated: "", tag: "project/app", tag_registered: true };
  const form = { name: "App", repos: "C:/code/app", aliases: "a", description: "d", status: "active" as const };
  it("is null when nothing changed", () => expect(changedProject(before, form)).toBeNull());
  it("holds only the changes", () => {
    expect(changedProject(before, { ...form, name: "App 2", status: "paused", aliases: "" })).toEqual({ slug: "app", name: "App 2", status: "paused", aliases: [] });
  });
});

describe("mergeTags", () => {
  it("de-duplicates", () => expect(mergeTags(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]));
});
