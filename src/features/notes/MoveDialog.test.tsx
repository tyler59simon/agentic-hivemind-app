// @vitest-environment jsdom
// Move to offers each destination folder once, under the page that owns it (Codex re-review, DESK-R11).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Entry } from "../../lib/notebooks";
import { MoveDialog } from "./MoveDialog";
import { buildTree, type Node } from "./tree";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const e = (path: string): Entry => ({ path, kind: path.includes(".") ? "page" : "dir", size: 0, mtimeMs: 0 });
const all = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...all(n.children)]);

describe("Move to", () => {
  it.each([["Plan.hmdoc", "Plan.md"], ["Plan.md", "Plan.hmdoc"]])("names the Markdown page for the folder it shares with a rich page (%s first)", async (...order) => {
    const nodes = all(buildTree([...order, "Inbox.md"].map(e)));
    const inbox = nodes.find((n) => n.path === "Inbox.md")!;
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<MoveDialog node={inbox} targets={nodes} onMove={() => {}} onClose={() => {}} />));
    const options = [...document.querySelectorAll("option")].map((o) => [o.value, o.textContent]);
    expect(options).toEqual([["Plan.md", "Plan (as a subpage)"]]);
  });
});
