import { useChangesEnabled } from "../../lib/connection";
import { useApp } from "../../store";
import { ChangeDetail } from "./ChangeDetail";
import { ChangesList } from "./ChangesList";
import { PlansFallback } from "./PlansFallback";

/** Changes: the registry's list and detail, or the plan-note page when this Living Memory has no `changes` command. */
export function ChangesPage() {
  const enabled = useChangesEnabled();
  const route = useApp((s) => s.route);
  if (!enabled) return <PlansFallback />;
  return route.page === "changes" && route.view === "detail" && route.id ? <ChangeDetail key={route.id} id={route.id} /> : <ChangesList />;
}
