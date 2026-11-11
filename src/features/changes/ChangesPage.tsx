import { useChangesEnabled } from "../../lib/connection";
import { ChangesList } from "./ChangesList";
import { PlansFallback } from "./PlansFallback";

/** Changes: the registry's list and detail, or the plan-note page when this Living Memory has no `changes` command. */
export function ChangesPage() {
  const enabled = useChangesEnabled();
  if (!enabled) return <PlansFallback />;
  return <ChangesList />;   // commit B6 adds the detail branch (route.view === "detail")
}
