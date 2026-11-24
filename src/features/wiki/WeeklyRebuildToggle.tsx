// The "Rebuild weekly" switch of a project's agent-written wiki: an automation that runs `wiki --agent --build` for the project
// every Sunday at 03:00, capped at $2 a run and counted against the automation budget. It is made the first time the switch goes
// on; after that the switch flips `enabled`. A build with no changed notes makes no model call and costs nothing.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { toast } from "../../ui/toast";
import { automationPut, automationsQuery, type Automation } from "../../lib/automations";
import { usd } from "./wiki";

export const WEEKLY_REBUILD = "Weekly wiki rebuild";
export const WIKI_REBUILD_CAP_USD = 2;
const CAP_USD = WIKI_REBUILD_CAP_USD;

/** The project's weekly rebuild, if one was made. */
export const rebuildOf = (automations: Automation[], project: string) =>
  // By kind and project, not by name: the name can be edited in Settings, Schedules (Codex re-review of 55cfab2).
  automations.find((a) => a.action.kind === "wiki_rebuild" && a.project === project);

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function WeeklyRebuildToggle({ domain, project }: { domain: string; project: string }) {
  const client = useQueryClient();
  const automations = useQuery({ ...automationsQuery(), retry: false });
  const [busy, setBusy] = useState(false);
  const found = rebuildOf(automations.data?.automations ?? [], project);
  const toggle = async (on: boolean) => {
    if (automations.isError) return;
    setBusy(true);
    try {
      const action = { kind: "wiki_rebuild" as const, domain };
      await automationPut(found ? { ...found, enabled: on, action } : {
        id: "", name: WEEKLY_REBUILD, enabled: on, trigger: { kind: "weekly", days: [6], at: 3 * 60 }, action,
        project, repo: null, askFirst: false, notify: "failures", budgetUsd: CAP_USD, createdAt: 0, lastRun: null, nextDue: null, lastSeen: null,
      });
      await client.invalidateQueries({ queryKey: ["automations"] });
    } catch (e) { toast(classify(e).message, "error"); }
    finally { setBusy(false); }
  };
  const ran = found?.lastRun ? `, last ran ${when(found.lastRun)}` : "";
  return (
    <>
      <label className="check" title="Rebuilds this project's agent-written wiki every Sunday at 03:00 while Hivemind is open or in the tray. It writes nothing, and costs nothing, when no note changed.">
        <input type="checkbox" checked={!!found?.enabled} disabled={busy || automations.isLoading || automations.isError} onChange={(e) => void toggle(e.target.checked)} />
        Rebuild weekly<span className="muted small"> (Sundays, up to {usd(found?.budgetUsd ?? CAP_USD)} a run{ran})</span>
      </label>
      {automations.isError && <p className="error small">Could not load the rebuild schedule: {classify(automations.error).message}</p>}
    </>
  );
}
