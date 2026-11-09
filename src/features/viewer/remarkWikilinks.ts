// Turn [[Title]], [[Title|alias]] and [[Title#heading]] in text into links the reading view can resolve.
// Code spans and code blocks are left alone (their text is not a `text` node).
import { wikilinks } from "../../lib/note";

interface MdNode { type: string; value?: string; url?: string; children?: MdNode[]; data?: Record<string, unknown> }

export const WIKI_PREFIX = "wikilink:";

function splitText(node: MdNode): MdNode[] {
  const text = node.value ?? "";
  const found = wikilinks(text);
  if (!found.length) return [node];
  const out: MdNode[] = [];
  let at = 0;
  for (const link of found) {
    if (link.from > at) out.push({ type: "text", value: text.slice(at, link.from) });
    const label = link.alias ?? (link.heading ? `${link.target} › ${link.heading}` : link.target);
    out.push({ type: "link", url: WIKI_PREFIX + encodeURIComponent(link.target), children: [{ type: "text", value: label }] });
    at = link.to;
  }
  if (at < text.length) out.push({ type: "text", value: text.slice(at) });
  return out;
}

function walk(node: MdNode) {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value?.includes("[[")) return splitText(child);
    if (child.type !== "link" && child.type !== "linkReference") walk(child);
    return [child];
  });
}

export function remarkWikilinks() {
  return (tree: MdNode) => walk(tree);
}
