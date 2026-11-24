// Shared query hook for the unified graph (Living Memory notes + folder notebook pages), used by Notes -> Graph
// and by Local graph in both NoteRail and PageRail (CON-12).
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useConnection } from "../../lib/connection";
import { links } from "../../lib/lm";
import { notebooksQuery } from "../../lib/notebooks";
import { graphQuery } from "../../lib/noteindex";
import { useApp } from "../../store";
import { useWorkspace } from "../../workspace/store";
import { openPage } from "../notes/actions";
import { buildUnifiedGraph, type UnifiedNode } from "./graphData";

export function useUnifiedGraph() {
  const linksSupported = useConnection((c) => c.commands.includes("search"));
  const notebooks = useQuery(notebooksQuery());
  const memory = useQuery({
    queryKey: ["links", "*"],
    queryFn: () => links({ allDomains: true, status: "any" }),
    enabled: linksSupported,
  });
  const hasNotebooks = (notebooks.data?.length ?? 0) > 0;
  const pages = useQuery({ ...graphQuery(), enabled: hasNotebooks });

  const graph = useMemo(
    () => buildUnifiedGraph({
      memory: memory.data,
      pages: hasNotebooks ? pages.data : null,
      notebooks: notebooks.data ?? [],
    }),
    [memory.data, pages.data, hasNotebooks, notebooks.data],
  );

  return {
    graph,
    linksSupported,
    notebooks: notebooks.data ?? [],
    isLoading: (linksSupported && memory.isLoading) || notebooks.isLoading || (hasNotebooks && pages.isLoading),
    memoryError: memory.error,
    pagesError: pages.error,
  };
}

/** Open a memory note or folder notebook page from any graph view. */
export function openGraphNode(node: UnifiedNode, split: boolean) {
  if (node.kind === "note") {
    useApp.getState().setDomain(node.domain);
    useWorkspace.getState().openNote(node.ref, { split, title: node.title });
  } else {
    openPage(node.file, { split });
  }
}
