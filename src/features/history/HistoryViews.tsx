import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { domains, history } from "../../lib/lm";
import type { Tab } from "../../workspace/store";
import { domainOfOp, visible, type ActorKind } from "./activity";
import { OperationList, useActors, useNotesById } from "./OperationList";

/** Right-sidebar panel: every journaled change to the focused note. */
export function HistoryPanel({ tab }: { tab: Tab }) {
  const id = tab.ref!.split(":")[1];
  const ops = useQuery({ queryKey: ["history", id], queryFn: () => history({ note: id, limit: 100 }) });
  const notes = useNotesById();
  const shown = useMemo(() => (ops.data ?? []).filter(visible), [ops.data]);
  const actorFor = useActors(shown, notes);
  if (ops.isLoading) return <p className="muted pad">Loading…</p>;
  if (ops.error) return <p className="error pad">{String(ops.error)}</p>;
  if (!shown.length) return <p className="muted pad">No recorded changes.</p>;
  return <OperationList ops={shown} notes={notes} actorFor={actorFor} showNotes={false} />;
}

const ACTORS: { kind: ActorKind | ""; label: string }[] = [
  { kind: "", label: "Everyone" }, { kind: "agent", label: "Agents" }, { kind: "you", label: "You (Hivemind)" },
  { kind: "obsidian", label: "You (Obsidian)" }, { kind: "plan", label: "Approved plans" },
];

/** Activity tab: what agents and people changed recently, newest first. */
export function ActivityView() {
  const [domain, setDomain] = useState("");
  const [who, setWho] = useState<ActorKind | "">("");
  const [limit, setLimit] = useState(100);
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const ops = useQuery({ queryKey: ["activity", limit], queryFn: () => history({ limit }) });
  const notes = useNotesById();
  const base = useMemo(() => (ops.data ?? []).filter(visible).filter((o) => !domain || domainOfOp(o) === domain), [ops.data, domain]);
  const actorFor = useActors(base, notes);
  const shown = base.filter((o) => !who || actorFor(o).kind === who);
  return (
    <div className="activity">
      <div className="graph-filters">
        <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
          <option value="">All domains</option>
          {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        <div className="segmented compact">
          {ACTORS.map((a) => <button key={a.label} className={who === a.kind ? "on" : ""} onClick={() => setWho(a.kind)}>{a.label}</button>)}
        </div>
        <span className="muted small">Who made a change is inferred: Living Memory's journal does not record it.</span>
      </div>
      {ops.isLoading && <p className="muted pad">Loading…</p>}
      {ops.error && <p className="error pad">{String(ops.error)}</p>}
      {ops.data && !shown.length && <p className="muted pad">Nothing yet.</p>}
      <div className="pad"><OperationList ops={shown} notes={notes} actorFor={actorFor} /></div>
      {ops.data && ops.data.length >= limit && <div className="pad"><button onClick={() => setLimit(limit + 100)}>Show older changes</button></div>}
    </div>
  );
}
