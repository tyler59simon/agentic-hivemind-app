// Queries and actions for changes: the joined views, the guarded one-click stage move, and the Start-session hand-off.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";
import { sessionsQuery } from "../../lib/agent";
import { useChangesEnabled, useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { changes, links, list, LmError, review, writeChange, type ChangeStage, type ChangesResult } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { startSession, useApp } from "../../store";
import { useSessionDraft } from "../agents/draft";
import { useAllLinks } from "../projects/useProject";
import { systemsQuery } from "../systems/useSystem";
import { toast } from "../../ui/toast";
import { contextRefs, displayId, linkedContext, STAGE_LABELS, viewOf, type ChangeView } from "./changes";

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

/** Move a change to another stage in one direct write (section 4.6). Resolves with the operation id; rejects without writing when the change has moved on since it was shown. */
export async function moveStage(id: number, stage: ChangeStage, from: ChangeStage): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    // Someone else may have moved the change since it was shown (or since a stale write): never overwrite that move.
    const now = (await changes()).changes.find((c) => c.id === id);
    if (now?.stage !== from) throw new Error(`${displayId(id)} is now at ${now ? STAGE_LABELS[now.stage] : "an unknown stage"}; nothing was changed.`);
    try {
      const done = await writeChange("update", { id, stage });
      recordOperation(done.operation_id);
      return done.operation_id;
    } catch (e) {
      if (!(e instanceof LmError && e.stale) || attempt) throw e;   // one fresh read after a stale write
    }
  }
}

/** Fill the session draft from a change and show the Start screen. The link graph is read here, so the draft gets the
 *  change's decisions and questions even when the screen's own copy had not loaded yet. */
export async function startSessionFor(view: ChangeView) {
  const { change } = view;
  try { view = { ...view, ...linkedContext(await links({ allDomains: true, status: "any" }), change) }; }
  catch (e) { toast(`The notes linked to ${change.display} could not be read: ${classify(e).message}`, "error"); return; }
  const draft = useSessionDraft.getState();
  useSessionDraft.setState({ change: change.id });          // the draft has no setter for `change`; reset() clears it
  contextRefs(view).forEach(draft.addContext);              // keeps notes the user already added; ignores duplicates
  if (change.system) draft.setSystem(change.system, change.element);
  const app = useApp.getState();
  if (app.project !== change.project) app.setProject(change.project);   // the Start screen works on the picked project
  startSession();
}
