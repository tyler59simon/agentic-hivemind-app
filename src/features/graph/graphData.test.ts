import { describe, expect, it } from "vitest";
import type { LinkGraph } from "../../lib/lm";
import type { IndexGraph } from "../../lib/noteindex";
import { buildUnifiedGraph, filterGraph, neighborhood, PAGE_COLOR, pageNodeId, toGraphology, typeColor } from "./graphData";

const note = (ref: string, extra: Partial<LinkGraph["nodes"][0]> = {}) =>
  ({ ref, id: ref.split(":")[1], domain: ref.split(":")[0], title: ref, type: "knowledge", status: "active", tags: [], ...extra }) as LinkGraph["nodes"][0];

const memory: LinkGraph = {
  domains: ["d", "e", "page"],
  nodes: [
    note("d:a", { title: "SQLite Search", tags: ["project/core", "technology/rust"] }),
    note("d:b", { title: "Lock Bug", type: "bug", tags: ["project/core", "concern/bug"] }),
    note("d:c", { title: "Old Plan", status: "archived", tags: ["project/core"] }),
    note("e:x", { title: "Other Note", tags: ["project/other"] }),
    note("d:lone", { title: "Lone" }),
    note("page:nb1:Roadmap.md", { title: "Domain named page" }),
  ],
  edges: [
    { from: "d:a", to: "d:b", kind: "link" },
    { from: "d:b", to: "d:c", kind: "supersedes" },
    { from: "e:x", to: "d:a", kind: "link" },
  ],
  unresolved: [
    { from: "d:a", target: "Architecture" },
    { from: "d:a", target: "Nowhere" },
  ],
};

const pages: IndexGraph = {
  pages: [
    { notebook: "nb1", path: "Architecture.md", kind: "md", title: "Architecture", tags: ["technology/rust", "q4"] },
    { notebook: "nb1", path: "Roadmap.md", kind: "md", title: "Roadmap", tags: ["q4"] },
    { notebook: "nb2", path: "Notes.md", kind: "md", title: "Notes", tags: [] },
    { notebook: "unregistered", path: "Ghost.md", kind: "md", title: "Ghost", tags: [] },
  ],
  links: [
    { notebook: "nb1", path: "Architecture.md", raw: "Roadmap", kind: "wiki" },
    { notebook: "nb1", path: "Architecture.md", raw: "mem:SQLite Search", kind: "wiki" },
    { notebook: "nb2", path: "Notes.md", raw: "Lock Bug", kind: "wiki" },
    { notebook: "nb1", path: "Architecture.md", raw: "Architecture", kind: "wiki" }, // self-loop dropped
  ],
};

const notebooks = [{ id: "nb1", title: "Work" }, { id: "nb2", title: "Personal" }];

describe("unified graph data", () => {
  it("merges notes and registered folder pages with cross-links and collision-free ids", () => {
    const g = buildUnifiedGraph({ memory, pages, notebooks });
    const archId = pageNodeId({ notebook: "nb1", path: "Architecture.md" });
    const roadId = pageNodeId({ notebook: "nb1", path: "Roadmap.md" });
    const notesId = pageNodeId({ notebook: "nb2", path: "Notes.md" });

    // Unregistered notebook page is dropped; domain named "page" does not collide with page ids.
    expect(g.nodes.map((n) => n.id)).not.toContain(pageNodeId({ notebook: "unregistered", path: "Ghost.md" }));
    expect(g.nodes.some((n) => n.kind === "note" && n.id === "page:nb1:Roadmap.md")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "page" && n.id === roadId)).toBe(true);

    // Page -> page, page -> note (mem: and exact title), and note -> page (unresolved wikilink) edges all resolve.
    expect(g.edges).toEqual(expect.arrayContaining([
      { from: "d:a", to: "d:b", kind: "link" },
      { from: archId, to: roadId, kind: "link" },
      { from: archId, to: "d:a", kind: "link" },
      { from: notesId, to: "d:b", kind: "link" },
      { from: "d:a", to: archId, kind: "link" },
    ]));
    expect(g.edges.some((e) => e.from === archId && e.to === archId)).toBe(false);
  });

  it("filters by showNotes, showPages, project, notebook, type, tag and archived status", () => {
    const g = buildUnifiedGraph({ memory, pages, notebooks });
    const archId = pageNodeId({ notebook: "nb1", path: "Architecture.md" });
    const roadId = pageNodeId({ notebook: "nb1", path: "Roadmap.md" });

    const active = filterGraph(g, {});
    expect(active.nodes.some((n) => n.id === "d:c")).toBe(false);
    expect(filterGraph(g, { includeRetired: true }).nodes.some((n) => n.id === "d:c")).toBe(true);

    // Project tag scopes notes while keeping pages.
    const proj = filterGraph(g, { projectTag: "project/core" });
    expect(proj.nodes.filter((n) => n.kind === "note").map((n) => n.id)).toEqual(["d:a", "d:b"]);
    expect(proj.nodes.filter((n) => n.kind === "page")).toHaveLength(3);

    // Notebook scopes pages.
    const nb = filterGraph(g, { showNotes: false, notebook: "nb1" });
    expect(nb.nodes.map((n) => n.id)).toEqual([archId, roadId]);
    expect(nb.edges).toEqual([{ from: archId, to: roadId, kind: "link" }]);

    // Tag matches both notes and pages (case-insensitive, ignoring leading #).
    const tagged = filterGraph(g, { tag: "#Technology/Rust" });
    expect(tagged.nodes.map((n) => n.id).sort()).toEqual(["d:a", archId].sort());

    // Note type narrows to matching notes only.
    const bugs = filterGraph(g, { types: ["bug"] });
    expect(bugs.nodes.map((n) => n.id)).toEqual(["d:b"]);
  });

  it("finds a neighbourhood across notes and pages in both directions", () => {
    const g = buildUnifiedGraph({ memory, pages, notebooks });
    const archId = pageNodeId({ notebook: "nb1", path: "Architecture.md" });
    const roadId = pageNodeId({ notebook: "nb1", path: "Roadmap.md" });

    expect(neighborhood(g, archId, 1).nodes.map((n) => n.id).sort()).toEqual(["d:a", archId, roadId].sort());
    expect(neighborhood(g, archId, 2).nodes.map((n) => n.id).sort()).toEqual(["d:a", "d:b", "e:x", archId, roadId].sort());
    expect(neighborhood(g, "d:lone", 2).nodes.map((n) => n.id)).toEqual(["d:lone"]);
  });

  it("builds a laid-out graphology graph coloured by note type or page colour", () => {
    const g = buildUnifiedGraph({ memory, pages, notebooks });
    const archId = pageNodeId({ notebook: "nb1", path: "Architecture.md" });
    const graph = toGraphology(g);
    expect(graph.order).toBe(9);
    expect(graph.getNodeAttribute("d:b", "size")).toBeGreaterThan(graph.getNodeAttribute("d:lone", "size"));
    expect(graph.getNodeAttribute(archId, "color")).toBe(PAGE_COLOR);
    expect(graph.getNodeAttribute("d:b", "color")).toBe("#ef4444");
    const { x, y } = graph.getNodeAttributes(archId);
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  });

  it("colours custom types grey, including one named after an Object property", () => {
    expect(typeColor("bug")).toBe("#ef4444");
    expect(typeColor("incident")).toBe("#999");
    expect(typeColor("constructor")).toBe("#999");
    const g = buildUnifiedGraph({ memory: { domains: ["d"], nodes: [note("d:k", { type: "constructor" })], edges: [], unresolved: [] } });
    expect(toGraphology(g).getNodeAttribute("d:k", "color")).toBe("#999");
  });
});
