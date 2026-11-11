// Queries and actions for changes: the joined views, the guarded one-click stage move, and the Start-session hand-off.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { sessionsQuery } from "../../lib/agent";
import { useChangesEnabled, useSystemsEnabled } from "../../lib/connection";
import { applyPlan, changePlan, changes, list, LmError, review, type ChangeStage, type ChangesResult } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { startSession, useApp } from "../../store";
import { useSessionDraft } from "../agents/draft";
import { useAllLinks } from "../projects/useProject";
import { systemsQuery } from "../systems/useSystem";
import { contextRefs, viewOf, type ChangeView } from "./changes";

export const changesQuery = () => ({ queryKey: ["changes"], queryFn: () => changes() });

/** Every change with what the screens show about it. One query per source; all are shared with other pages by key. */
export function useChangeViews(): { enabled: boolean; query: UseQueryResult<ChangesResult>; views: ChangeView[] } {
  const enabled = useChangesEnabled();
  const systemsOn = useSystemsEnabled();
  const query = useQuery({ ...changesQuery(), enabled });
  const sessions = useQuery({ ...sessionsQuery(), enabled });
  const links = useAllLinks(enabled);
  const systems = useQuery({ ...systemsQuery(), enabled: enabled && systemsOn });
  const due = useQuery({ queryKey: ["review", "*"], queryFn: () => review({ allDomains: true, limit: 100 }), enabled });
  const plans = useQuery({
    queryKey: ["list", "*", "any", "plans"], queryFn: () => list({ allDomains: true, status: "any", types: ["plan"], summary: true }), enabled,
  });
  const views = useMemo(() => {
    const ctx = {
      sessions: sessions.data ?? [], graph: links.data, due: new Set((due.data?.notes ?? []).map((n) => n.ref)),
      rows: new Map((plans.data?.notes ?? []).map((n) => [n.ref, n])), systems: systems.data?.systems ?? [],
    };
    return (query.data?.changes ?? []).map((c) => viewOf(c, ctx));
  }, [query.data, sessions.data, links.data, due.data, plans.data, systems.data]);
  return { enabled, query, views };
}

/** Plan and apply a stage change at once (section 4.6). Resolves with the operation id; rejects without applying when the plan is not a stage-only, one-file update. */
export async function moveStage(id: number, stage: ChangeStage): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const plan = await changePlan("update", { id, stage });
    const s = plan.summary;
    if (plan.kind !== "change_update" || s.id !== id || s.files !== 1 || s.fields.join() !== "stage")
      throw new Error("Living Memory returned a plan that is not a stage-only update; nothing was applied.");
    try {
      const done = await applyPlan(plan);
      recordOperation(done.operation_id);
      return done.operation_id;
    } catch (e) {
      if (!(e instanceof LmError && e.stale) || attempt) throw e;   // one fresh plan after a stale apply
    }
  }
}

/** Fill the session draft from a change and show the Start screen. */
export function startSessionFor(view: ChangeView) {
  const { change } = view;
  const draft = useSessionDraft.getState();
  useSessionDraft.setState({ change: change.id });          // the draft has no setter for `change`; reset() clears it
  contextRefs(view).forEach(draft.addContext);              // keeps notes the user already added; ignores duplicates
  if (change.system) draft.setSystem(change.system, change.element);
  const app = useApp.getState();
  if (app.project !== change.project) app.setProject(change.project);   // the Start screen works on the picked project
  startSession();
}
