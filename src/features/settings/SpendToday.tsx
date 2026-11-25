// Today's spending beside the budgets in Settings > Spend (CON-20): automations and learning against Hivemind's daily budgets,
// and Living Memory maintenance against its own. Read-only; the budgets themselves are the form's fields.
import { useQuery } from "@tanstack/react-query";
import { automationSpendQuery } from "../../lib/automations";
import { useMaintenanceEnabled } from "../../lib/connection";
import { maintenanceStatus } from "../../lib/lm";
import { learningQuery } from "../../lib/skills";
import { WIKI_REBUILD_CAP_USD } from "../wiki/WeeklyRebuildToggle";

const usd = (n: number | string) => `$${Number(n).toFixed(2)}`;

export function SpendToday() {
  // A briefing or rebuild can settle while Settings is open, and the totals start again at midnight UTC: refetch while shown
  // (Codex review of 99ceaea, B3).
  const automations = useQuery({ ...automationSpendQuery(), retry: false, refetchInterval: 60_000 });
  const learning = useQuery({ ...learningQuery(), retry: false, refetchInterval: 60_000 });
  const maintenanceOn = useMaintenanceEnabled();
  const maintenance = useQuery({ queryKey: ["maintenance", "status"], queryFn: maintenanceStatus, enabled: maintenanceOn, retry: false });
  const m = maintenance.data;
  return (
    <div className="spend-today">
      <h3>Today</h3>
      <dl className="properties">
        {automations.data && <div><dt>Automations</dt><dd>{usd(automations.data.spentToday)} of {usd(automations.data.dailyUsd)}</dd></div>}
        {learning.data && <div><dt>Learning and executive</dt><dd>{usd(learning.data.spentToday)} of {usd(learning.data.dailyUsd)}</dd></div>}
        {m && <div><dt>Memory maintenance</dt><dd>
          {m.accounting ? `${usd(m.accounting.charged_usd)}${m.accounting.cost_complete ? "" : " or more"} of ${usd(m.limits.daily_budget_usd)}` : `budget ${usd(m.limits.daily_budget_usd)}`}
          {m.enabled ? "" : " (off)"}
        </dd></div>}
      </dl>
      <p className="muted small">
        A weekly wiki rebuild spends up to {usd(WIKI_REBUILD_CAP_USD)} a run, counted under Automations.
        {m ? " Memory maintenance keeps its own daily budget in Living Memory (alm maintenance enable --daily-budget-usd); see Maintenance below." : ""}
      </p>
      {(automations.error || learning.error) && <p className="error small">Could not read today's spending.</p>}
    </div>
  );
}
