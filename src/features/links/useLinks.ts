import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { links, type LinkGraph, type LinkNode } from "../../lib/lm";
import { useConnection } from "../../lib/connection";

/** The domain's link graph (all statuses), or null when this Living Memory has no `links` command yet. */
export function useLinks(domain: string | null | undefined) {
  const supported = useConnection((c) => c.commands.includes("links"));
  return useQuery({
    queryKey: ["links", domain],
    queryFn: () => links({ domain: domain!, status: "any" }),
    enabled: !!domain && supported,
  });
}

export interface NoteLinks {
  out: Map<string, LinkNode>;      // casefolded target title -> note it resolved to
  unresolved: Set<string>;          // casefolded targets that match no note
  incoming: { node: LinkNode; kind: "link" | "supersedes" }[];
  outgoing: { node: LinkNode; kind: "link" | "supersedes" }[];
}

/** Links of one note: where each [[target]] it writes resolved, and who links to it. */
export function noteLinks(graph: LinkGraph | undefined, ref: string | undefined): NoteLinks | null {
  if (!graph || !ref) return null;
  const nodes = new Map(graph.nodes.map((n) => [n.ref, n]));
  const out = new Map<string, LinkNode>();
  const incoming: NoteLinks["incoming"] = [], outgoing: NoteLinks["outgoing"] = [];
  for (const e of graph.edges) {
    if (e.from === ref && nodes.has(e.to)) {
      const node = nodes.get(e.to)!;
      outgoing.push({ node, kind: e.kind });
      if (e.kind === "link") out.set(node.title.trim().toLowerCase(), node);
    }
    if (e.to === ref && nodes.has(e.from)) incoming.push({ node: nodes.get(e.from)!, kind: e.kind });
  }
  const unresolved = new Set(graph.unresolved.filter((u) => u.from === ref).map((u) => u.target.trim().toLowerCase()));
  return { out, unresolved, incoming, outgoing };
}

export function useNoteLinks(ref: string | undefined) {
  const domain = ref ? ref.slice(0, ref.indexOf(":")) : null;
  const graph = useLinks(domain);
  return { ...graph, note: useMemo(() => noteLinks(graph.data, ref), [graph.data, ref]) };
}
