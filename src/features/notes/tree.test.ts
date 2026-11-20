import { describe, expect, it } from "vitest";
import type { Entry } from "../../lib/notebooks";
import { ancestors, buildTree, dropTarget, visibleRows, type Node } from "./tree";

const e = (path: string, kind: Entry["kind"] = path.endsWith(".md") ? "page" : "dir"): Entry => ({ path, kind, size: 0, mtimeMs: 0 });
const entries = [
  e("b.md"), e("A.md"), e("Zeta"), e("Alpha"), e("Alpha/x.md"), e("Alpha/notes.txt", "text"),
  e("Plan.md"), e("Plan"), e("Plan/Step 10.md"), e("Plan/Step 2.md"),
];
const names = (nodes: Node[]) => nodes.map((n) => n.name);

describe("notebook tree", () => {
  it("puts sections first, then pages by name, numbers in numeric order", () => {
    const tree = buildTree(entries);
    expect(names(tree)).toEqual(["Alpha", "Zeta", "A.md", "b.md", "Plan.md"]);
    expect(names(tree.find((n) => n.name === "Plan.md")!.children)).toEqual(["Step 2.md", "Step 10.md"]);
  });

  it("nests a folder named like a page under that page", () => {
    const tree = buildTree(entries);
    expect(tree.some((n) => n.name === "Plan")).toBe(false);
    expect(tree.find((n) => n.name === "Plan.md")!.children.map((n) => n.path)).toEqual(["Plan/Step 2.md", "Plan/Step 10.md"]);
  });

  it("follows the sidecar order before the default", () => {
    const tree = buildTree(entries, { order: { "": ["b.md", "Zeta"], Plan: ["Step 10.md"] } });
    expect(names(tree)).toEqual(["b.md", "Zeta", "Alpha", "A.md", "Plan.md"]);
    expect(names(tree.find((n) => n.name === "Plan.md")!.children)).toEqual(["Step 10.md", "Step 2.md"]);
  });

  it("shows children only under open rows", () => {
    const tree = buildTree(entries);
    expect(visibleRows(tree, new Set()).length).toBe(5);
    const rows = visibleRows(tree, new Set(["alpha"]));
    expect(rows.map((r) => [r.node.path, r.depth])).toContainEqual(["Alpha/x.md", 1]);
  });

  it("drops into sections and under pages, never into itself", () => {
    const dir = (path: string): Node => ({ path, name: path, kind: "dir", children: [] });
    const page = (path: string): Node => ({ path, name: path, kind: "page", children: [] });
    expect(dropTarget("A.md", dir("Alpha"))).toBe("Alpha/A.md");
    expect(dropTarget("A.md", page("Plan.md"))).toBe("Plan/A.md");
    expect(dropTarget("Alpha/x.md", null)).toBe("x.md");
    expect(dropTarget("Alpha", dir("Alpha"))).toBeNull();
    expect(dropTarget("Alpha", dir("Alpha/Sub"))).toBeNull();
    expect(dropTarget("Plan.md", page("Plan.md"))).toBeNull();
    expect(dropTarget("Alpha/x.md", dir("Alpha"))).toBeNull();
  });

  it("lists the rows to open to reveal a page", () => {
    expect(ancestors("Plan/Sub/Page.md")).toEqual(["plan", "plan.md", "plan/sub", "plan/sub.md"]);
  });
});
