import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useProjectsEnabled, useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { review, systemPlan, type System, type SystemUpdate } from "../../lib/lm";
import { openSession, openSystem } from "../../store";
import { ArrowLink, PageHeader, Section, Tabs } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { PlanDialog } from "../plans/PlanDialog";
import { systemsForProject } from "../projects/scope";
import { useCurrentProject, useProject } from "../projects/useProject";
import { systemsQuery, useSystemProposals } from "../systems/useSystem";
import { ReviewQueue } from "../work/ReviewQueue";

type Kind = "all" | "memory" | "architecture";

/** Review: what waits for you before it counts as accepted. Today that is notes due for confirmation and
 *  registry changes an agent proposed; agent code edits join them with the diff review. */
export function ReviewPage() {
  const client = useQueryClient();
  const projectsOn = useProjectsEnabled();
  const systemsOn = useSystemsEnabled();
  const { project } = useCurrentProject();
  const mine = useProject(project?.slug).due;
  const everything = useQuery({ queryKey: ["review", "*"], queryFn: () => review({ allDomains: true, limit: 100 }), enabled: projectsOn && !project });
  const due = project ? mine : everything;
  const registry = useQuery({ ...systemsQuery(), enabled: systemsOn });
  const all = useMemo(() => registry.data?.systems ?? [], [registry.data]);
  const scoped = useMemo(() => (project ? systemsForProject(project, all) : all).filter((s) => s.status !== "retired"), [project, all]);
  const { items, dismiss } = useSystemProposals(scoped, all);
  const proposals = items.filter((i) => i.update && i.proposer);
  const [kind, setKind] = useState<Kind>("all");
  const [reviewing, setReviewing] = useState<{ system: System; update: SystemUpdate } | null>(null);
  const notes = due.data?.notes ?? [];
  const total = notes.length + proposals.length;

  return (
    <div className="page">
      <PageHeader title="Review" subtitle={project ? "What waits for you in this project before it counts as accepted." : "What waits for you before it counts as accepted."} />
      <Tabs pill label="Kind" value={kind} onChange={setKind}
        items={[{ id: "all", label: "All", count: total }, { id: "memory", label: "Memory", count: notes.length }, { id: "architecture", label: "Architecture", count: proposals.length }]} />
      {!projectsOn && <p className="muted">Review needs a newer Living Memory (API 2 with the <code>review</code> command).</p>}
      {due.data && registry.data && !total && <p className="muted">Nothing is waiting for you.</p>}
      {kind !== "memory" && !!proposals.length && (
        <Section title="Architecture" count={proposals.length}>
          {proposals.map(({ system, update, fields, proposer }) => (
            <div key={system.slug} className="work-group">
              <div className="work-head"><span className="badge">system</span><button className="link-row" onClick={() => openSystem(system.slug)}>{system.name}</button></div>
              <div>An agent session proposed changes to {fields}.</div>
              <div className="work-actions">
                <button className="primary" onClick={() => setReviewing({ system, update: update! })}>Review…</button>
                <button onClick={() => dismiss(proposer!.id)}>Dismiss</button>
                <ArrowLink onClick={() => openSession(proposer!.id)}>Open session</ArrowLink>
              </div>
            </div>
          ))}
        </Section>
      )}
      {kind !== "architecture" && projectsOn && (
        <Section title="Memory" count={due.data?.due} loading={due.isLoading} error={due.error && classify(due.error).message}
          empty={due.data && !notes.length ? "No notes are due for review." : undefined}>
          <ReviewQueue rows={notes} />
        </Section>
      )}
      {reviewing && (
        <PlanDialog title={`Update system ${reviewing.system.name}`} applyLabel="Update system"
          intro={<p>These are the registry fields the agent proposed. Nothing changes until you apply the plan.</p>}
          make={() => systemPlan("update", reviewing.update)}
          onApplied={() => { client.invalidateQueries({ queryKey: ["systems"] }); toast(`Updated ${reviewing.system.name}`); }}
          onClose={() => setReviewing(null)} />
      )}
    </div>
  );
}
