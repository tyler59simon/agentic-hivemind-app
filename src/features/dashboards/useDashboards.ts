// Queries and the toggle for note dashboards. Every key starts with "views", so refreshStore (note changes) refetches them.
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { classify } from "../../lib/errors";
import { addView, removeView, viewModel, views, viewRef, type ViewRow } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { useViewsEnabled } from "../../lib/connection";
import { toast } from "../../ui/toast";

export const viewsQuery = () => ({ queryKey: ["views"], queryFn: () => views() });
export const viewModelQuery = (ref: string) => ({ queryKey: ["views", "model", ref], queryFn: () => viewModel(ref) });

/** The registered views (`fresh`: refetch when the page opens, since views.json is not watched), or an empty list while loading and when this Living Memory has no `views` command. */
export function useViews({ fresh = false } = {}) {
  const enabled = useViewsEnabled();
  const query = useQuery({ ...viewsQuery(), enabled, ...(fresh ? { refetchOnMount: "always" as const } : {}) });
  return { enabled, query, rows: query.data?.views ?? [] };
}

/** The models of several views, in the same order. They share cache entries with the selected dashboard. */
export const useViewModels = (rows: ViewRow[]) =>
  useQueries({ queries: rows.map((r) => viewModelQuery(viewRef(r))) });

const short = (id?: string) => (id ? ` Operation ${id.slice(0, 8)}.` : "");

/** Turn a note's dashboard on or off. These are direct, journaled writes (like `check`), not plans. */
export function useDashboardToggle(refId: string, noteTitle: string) {
  const client = useQueryClient();
  const { rows } = useViews();
  const row = rows.find((r) => viewRef(r) === refId);
  const mutation = useMutation({
    mutationFn: async () => (row ? removeView(refId) : addView(refId, noteTitle.length > 120 ? noteTitle.slice(0, 120) : undefined)),
    onSuccess: (r) => {
      recordOperation(r.operation_id);
      client.invalidateQueries({ queryKey: ["views"] });
      toast(r.status === "removed" ? `Dashboard removed.${short(r.operation_id)}` : r.status === "exists" ? "This note already has a dashboard." : `Dashboard added.${short(r.operation_id)}`);
    },
    onError: (e) => toast(classify(e).message, "error"),
  });
  return { row, on: !!row, toggle: () => mutation.mutate(), pending: mutation.isPending };
}
