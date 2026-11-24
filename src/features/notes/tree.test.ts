import { describe, expect, it } from "vitest";
import type { Entry } from "../../lib/notebooks";
import { ancestors, buildTree, dropTarget, treeMove, visibleRows, type Node } from "./tree";

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
    // A page holding subpages may be Markdown or a rich page (NS-3C).
    expect(ancestors("Plan/Sub/Page.md")).toEqual(["plan", "plan.md", "plan.hmdoc", "plan/sub", "plan/sub.md", "plan/sub.hmdoc"]);
  });
});

describe("tree rows for the keyboard and screen readers (DESK-6)", () => {
  const rows = () => visibleRows(buildTree(entries), new Set(["alpha", "plan.md"]));
  const at = (path: string) => rows().findIndex((r) => r.node.path === path);

  it("say each row's parent and its place among its siblings", () => {
    const shown = rows().map((r) => [r.node.path, r.parent, r.posinset, r.setsize]);
    expect(shown).toEqual([
      ["Alpha", null, 1, 5], ["Alpha/notes.txt", "Alpha", 1, 2], ["Alpha/x.md", "Alpha", 2, 2], ["Zeta", null, 2, 5],
      ["A.md", null, 3, 5], ["b.md", null, 4, 5], ["Plan.md", null, 5, 5], ["Plan/Step 2.md", "Plan.md", 1, 2], ["Plan/Step 10.md", "Plan.md", 2, 2],
    ]);
  });

  it("move up and down, open and close branches with Right and Left, and go to a parent", () => {
    const r = rows();
    expect(treeMove(r, 0, "ArrowDown")).toEqual({ focus: 1 });
    expect(treeMove(r, 0, "ArrowUp")).toBeNull();
    expect(treeMove(r, r.length - 1, "ArrowDown")).toBeNull();
    expect(treeMove(r, 3, "End")).toEqual({ focus: r.length - 1 });
    expect(treeMove(r, 3, "Home")).toEqual({ focus: 0 });
    expect(treeMove(r, at("Alpha"), "ArrowRight")).toEqual({ focus: at("Alpha/notes.txt") });
    expect(treeMove(r, at("Alpha"), "ArrowLeft")).toEqual({ collapse: "Alpha" });
    expect(treeMove(r, at("Zeta"), "ArrowRight")).toEqual({ expand: "Zeta" });
    expect(treeMove(r, at("Zeta"), "ArrowLeft")).toBeNull();
    expect(treeMove(r, at("Plan/Step 10.md"), "ArrowLeft")).toEqual({ focus: at("Plan.md") });
    expect(treeMove(r, at("A.md"), "ArrowRight")).toBeNull();
    expect(treeMove(r, 0, "x")).toBeNull();
  });
});
