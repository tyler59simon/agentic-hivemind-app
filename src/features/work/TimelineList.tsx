import { useWorkspace } from "../../workspace/store";
import { dayLabel } from "../history/activity";
import { HoverPreview } from "../preview/HoverPreview";
import type { TimelineEntry } from "./work";

/** Notes grouped by day, newest first (the caller sorts). */
export function TimelineList({ rows }: { rows: TimelineEntry[] }) {
  if (!rows.length) return <p className="muted pad">No notes yet</p>;
  const days: { label: string; rows: TimelineEntry[] }[] = [];
  for (const r of rows) {
    const label = dayLabel(r.date);
    const last = days[days.length - 1];
    if (last?.label === label) last.rows.push(r);
    else days.push({ label, rows: [r] });
  }
  return (
    <div className="work-list">
      {days.map((d) => (
        <section key={d.label} className="work-group">
          <h4 className="work-day">{d.label}</h4>
          {d.rows.map((r) => (
            <div key={r.ref} className={`work-head${r.status === "active" ? "" : " retired"}`}>
              <span className={`badge type-${r.type}`}>{r.type}</span>
              <HoverPreview refId={r.ref}>
                <button className="link-row" onClick={() => useWorkspace.getState().openNote(r.ref, { title: r.title })}>{r.title}</button>
              </HoverPreview>
              {r.status !== "active" && <span className={`badge status-${r.status}`}>{r.status}</span>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
