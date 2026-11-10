import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { domains, history } from "../../lib/lm";
import type { Tab } from "../../workspace/store";
import { dayMonth } from "../../ui/Page";
import { useCurrentProject, useProject, useProjectOps } from "../projects/useProject";
import { domainOfOp, verbOf, visible, type ActorKind } from "./activity";
import { OperationList, useActors, useNotesById } from "./OperationList";

function useNoteHistory(refId: string) {
  const id = refId.split(":")[1];
  const ops = useQuery({ queryKey: ["history", id], queryFn: () => history({ note: id, limit: 100 }) });
  const notes = useNotesById();
  const shown = useMemo(() => (ops.data ?? []).filter(visible), [ops.data]);
  return { ops, notes, shown, actorFor: useActors(shown, notes) };
}

/** The History tab of a note: every journaled change to it, with its diff and an Undo plan. */
export function HistoryPanel({ tab }: { tab: Tab }) {
  const { ops, notes, shown, actorFor } = useNoteHistory(tab.ref!);
  if (ops.isLoading) return <p className="muted pad">Loading…</p>;
  if (ops.error) return <p className="error pad">{String(ops.error)}</p>;
  if (!shown.length) return <p className="muted pad">No recorded changes.</p>;
  return (
    <>
      <p className="muted small">{shown.length} recorded change{shown.length === 1 ? "" : "s"}{ops.data && ops.data.length >= 100 ? " (the newest 100)" : ""}</p>
      <OperationList ops={shown} notes={notes} actorFor={actorFor} showNotes={false} />
    </>
  );
}

/** The newest few changes to a note as a timeline, for the context rail. */
export function SourceHistory({ refId }: { refId: string }) {
  const { ops, shown, actorFor } = useNoteHistory(refId);
  if (ops.isLoading) return <p className="muted">Loading…</p>;
  if (ops.error) return <p className="error">{String(ops.error)}</p>;
  if (!shown.length) return <p className="muted">No recorded changes.</p>;
  return (
    <ol className="timeline">
      {shown.slice(0, 4).map((op) => (
        <li key={op.operation_id}><strong>{dayMonth(op.created)}</strong><span>{actorFor(op).label} {verbOf(op.kind)}</span></li>
      ))}
    </ol>
  );
}

const ACTORS: { kind: ActorKind | ""; label: string }[] = [
  { kind: "", label: "Everyone" }, { kind: "agent", label: "Agents" }, { kind: "you", label: "You (Hivemind)" },
  { kind: "obsidian", label: "You (Obsidian)" }, { kind: "plan", label: "Approved plans" },
];

const PROJECT = "@project";

/** What agents and people changed recently, newest first; scoped to the picked project unless a domain is chosen. */
export function ActivityView() {
  const { project } = useCurrentProject();
  const [picked, setDomain] = useState<string | null>(null);
  const domain = picked ?? (project ? PROJECT : "");
  const [who, setWho] = useState<ActorKind | "">("");
  const [limit, setLimit] = useState(100);
  const inProject = domain === PROJECT && !!project;
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const ops = useQuery({ queryKey: ["activity", limit], queryFn: () => history({ limit }), enabled: !inProject });
  const members = useProject(inProject ? project.slug : undefined).rows;
  const mine = useProjectOps(project?.slug, members.data?.notes, inProject);
  const notes = useNotesById();
  const base = useMemo(
    () => (inProject ? mine.shown : (ops.data ?? []).filter(visible).filter((o) => !domain || domain === PROJECT || domainOfOp(o) === domain)),
    [inProject, mine.shown, ops.data, domain],
  );
  const actorFor = useActors(base, notes);
  const shown = base.filter((o) => !who || actorFor(o).kind === who);
  const source = inProject ? mine.ops : ops;
  return (
    <div className="activity">
      <div className="graph-filters">
        <select value={inProject ? PROJECT : domain === PROJECT ? "" : domain} onChange={(e) => setDomain(e.target.value)} aria-label="Scope">
          {project && <option value={PROJECT}>This project</option>}
          <option value="">All domains</option>
          {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <div className="segmented compact">
          {ACTORS.map((a) => <button key={a.label} className={who === a.kind ? "on" : ""} onClick={() => setWho(a.kind)}>{a.label}</button>)}
        </div>
        <span className="muted small">Who made a change is inferred: Living Memory's journal does not record it.</span>
      </div>
      {source.isLoading && <p className="muted pad">Loading…</p>}
      {source.error && <p className="error pad">{String(source.error)}</p>}
      {source.data && !shown.length && <p className="muted pad">{inProject ? "No recent changes among the last 200 operations." : "Nothing yet."}</p>}
      <div className="pad"><OperationList ops={shown} notes={notes} actorFor={actorFor} /></div>
      {!inProject && ops.data && ops.data.length >= limit && <div className="pad"><button onClick={() => setLimit(limit + 100)}>Show older changes</button></div>}
    </div>
  );
}
