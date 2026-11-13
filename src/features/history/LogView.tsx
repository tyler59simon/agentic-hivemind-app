import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useProjectsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { domains, log, type LogRow } from "../../lib/lm";
import { openChange } from "../../store";
import { useWorkspace } from "../../workspace/store";
import { HoverPreview } from "../preview/HoverPreview";
import { projectsQuery } from "../projects/useProject";
import { groupByDay, LOG_EVENTS, sessionLine, targetOf } from "./log";

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function Title({ row }: { row: LogRow }) {
  const target = targetOf(row);
  if (!target) return <span className="small">{row.event === "session" ? sessionLine(row) : row.title}</span>;
  if (target.kind === "change") return <button className="link-row" onClick={() => openChange(target.id)}>{row.ref} {row.title}</button>;
  return (
    <HoverPreview refId={target.ref}>
      <button className="link-row" onClick={() => useWorkspace.getState().openNote(target.ref, { title: row.title })}>{row.title}</button>
    </HoverPreview>
  );
}

/** The journal of note, change and session events from the `log` command, newest first, grouped by day. */
export function LogView() {
  const projectsOn = useProjectsEnabled();
  const [domain, setDomain] = useState("");
  const [project, setProject] = useState("");
  const [event, setEvent] = useState("");
  const [since, setSince] = useState("");
  const [limit, setLimit] = useState(100);
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const registry = useQuery({ ...projectsQuery(), enabled: projectsOn });
  const filters = { domain, project, event, since, limit };
  const rows = useQuery({ queryKey: ["log", filters], queryFn: () => log(filters) });
  const days = useMemo(() => groupByDay(rows.data?.rows ?? []), [rows.data]);
  return (
    <div className="activity">
      <div className="graph-filters">
        <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
          <option value="">All domains</option>
          {known.data?.domains.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
        </select>
        {projectsOn && (
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            {registry.data?.projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
          </select>
        )}
        <select value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event">
          <option value="">Any event</option>
          {LOG_EVENTS.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        <label className="muted small">Since <input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></label>
      </div>
      {rows.isLoading && <p className="muted pad">Loading…</p>}
      {rows.error && <p className="error pad">{classify(rows.error).message}</p>}
      {rows.data && !rows.data.rows.length && <p className="muted pad">Nothing matches these filters.</p>}
      <div className="work-list pad">
        {days.map((d) => (
          <section key={d.label} className="work-group">
            <h4 className="work-day">{d.label}</h4>
            {d.rows.map((r, i) => (
              <div key={`${r.time}-${r.event}-${r.ref}-${i}`}>
                <div className="work-head">
                  <span className="muted small">{time(r.time)}</span>
                  <span className="badge">{r.event}</span>
                  {r.type && r.event !== "session" && <span className={`badge type-${r.type}`}>{r.type}</span>}
                  <Title row={r} />
                  {r.event === "session" && r.title && <span className="muted small">{r.title}</span>}
                </div>
                {r.detail && <div className="muted small">{r.detail}</div>}
              </div>
            ))}
          </section>
        ))}
      </div>
      {rows.data && rows.data.count >= limit && <div className="pad"><button onClick={() => setLimit(limit + 100)}>Show older events</button></div>}
    </div>
  );
}
