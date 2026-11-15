import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useRecapEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { realProject } from "../../lib/folders";
import { recap, type Recap } from "../../lib/lm";
import { useApp } from "../../store";
import { PageHeader } from "../../ui/Page";
import { useWorkspace } from "../../workspace/store";
import { serverActor } from "../history/activity";
import { changeGroups, DAY_CHOICES, harnessLine, isQuiet, repeatLabel } from "./recap";

/** The recap for the last `days` days, across every domain or one project. Key starts with "recap" so store changes refetch it. */
export function useRecap(days: number, project: string | undefined, enabled: boolean) {
  return useQuery({ queryKey: ["recap", days, project ?? "*"], queryFn: () => recap({ days, project }), enabled });
}

function NoteLink({ refId, title }: { refId: string; title?: string | null }) {
  const go = useApp((s) => s.go);
  const openNote = useWorkspace((s) => s.openNote);
  return (
    <a href="#" className="wikilink" onClick={(e) => { e.preventDefault(); go({ page: "memory", view: "notes" }); openNote(refId, { split: e.ctrlKey || e.metaKey, title: title ?? undefined }); }}>
      {title || refId}
    </a>
  );
}

/** Notes a change group lists before "Show all" (a busy week has hundreds of created notes). */
const GROUP_SHOWN = 10;

function Body({ r }: { r: Recap }) {
  const groups = changeGroups(r);
  const m = r.maintenance;
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <>
      <div className="status-strip">
        <span>{groups.reduce((n, g) => n + g.total, 0)} changes</span>
        <span>{r.sessions.count} sessions</span>
        <span>{m.runs} maintenance runs</span>
        <span>{r.open_work.items} open items</span>
        <span>{r.review.due} due for review</span>
      </div>
      <section className="section">
        <div className="section-head"><h2>Changes</h2></div>
        {!groups.length && <p className="muted">No note changes in this period.</p>}
        {groups.map(({ group, items, total }) => (
          <div key={group} className="work-group">
            <h4 className="work-day">{group} ({total})</h4>
            {(open.has(group) ? items : items.slice(0, GROUP_SHOWN)).map((c) => (
              <div key={c.ref}>
                <div className="work-head wraps">
                  {c.type && <span className={`badge type-${c.type}`}>{c.type}</span>}
                  <NoteLink refId={c.ref} title={c.title} />
                  {c.actor && <span className={`actor actor-${serverActor(c.actor).kind}`}>{serverActor(c.actor).label}</span>}
                  {repeatLabel(c.count) && <span className="muted small">{repeatLabel(c.count)}</span>}
                </div>
                {c.summary && <div className="muted small">{c.summary}</div>}
              </div>
            ))}
            {items.length > GROUP_SHOWN && !open.has(group) && (
              <button className="link small" onClick={() => setOpen(new Set(open).add(group))}>Show all {items.length}</button>
            )}
          </div>
        ))}
      </section>
      <section className="section">
        <div className="section-head"><h2>Maintenance</h2></div>
        {!m.runs ? <p className="muted">No maintenance runs.</p> : (
          <>
            <p>{m.runs} runs reviewed {m.reviewed} notes: {m.updated} updated, {m.confirmed} confirmed, {m.retired} retired, {m.kept} kept, {m.deferred} deferred. Charged {m.charged_usd} USD for these runs, across every domain they covered.</p>
            {m.retired_notes.map((n) => (
              <div key={n.ref}>
                <div className="work-head wraps"><span className="badge">{n.action}</span><NoteLink refId={n.ref} title={n.title} /></div>
                {(n.rule || n.reason) && <div className="muted small">{[n.rule, n.reason].filter(Boolean).join(": ")}</div>}
              </div>
            ))}
          </>
        )}
      </section>
      <section className="section">
        <div className="section-head"><h2>Sessions</h2></div>
        {!r.sessions.count ? <p className="muted">No agent sessions.</p> : <p>{r.sessions.count} sessions ({harnessLine(r.sessions.by_harness)}), {r.sessions.notes_saved} notes saved.</p>}
      </section>
      <section className="section">
        <div className="section-head"><h2>Open work</h2></div>
        {!r.open_work.top.length ? <p className="muted">Nothing open.</p> : r.open_work.top.map((t) => (
          <div key={t.ref} className="work-head wraps"><NoteLink refId={t.ref} title={t.title} /><span className="muted small">{t.open} open</span></div>
        ))}
      </section>
      <section className="section">
        <div className="section-head"><h2>Due for review</h2></div>
        {!r.review.due ? <p className="muted">Nothing due.</p> : <p>{r.review.due} notes: {Object.entries(r.review.by_kind).map(([k, n]) => `${k} ${n}`).join(", ")}.</p>}
      </section>
    </>
  );
}

/** Recap: what changed in the store over the last days, from Living Memory's `recap` command. */
export function RecapPage() {
  const enabled = useRecapEnabled();
  const project = useApp((s) => realProject(s.project)) ?? undefined;
  const [days, setDays] = useState<number>(7);
  const q = useRecap(days, project, enabled);
  const title = "Recap";
  const sub = project ? `What changed in ${project} recently.` : "What changed in the store recently.";
  if (!enabled) {
    return (
      <div className="page">
        <PageHeader title={title} subtitle={sub} />
        <p className="muted">This version of Living Memory has no <code>recap</code> command. Update Living Memory to use the recap.</p>
      </div>
    );
  }
  const unbound = q.error && (q.error as { code?: string }).code === "unbound_project";
  return (
    <div className="page">
      <PageHeader title={title} subtitle={sub}
        actions={<div className="segmented compact">{DAY_CHOICES.map((d) => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d} days</button>)}</div>} />
      {q.isLoading && <p className="muted">Loading…</p>}
      {unbound ? <p className="muted">This project has no bound domain, so there is nothing to recap yet.</p> : q.error ? <p className="error">{classify(q.error).message}</p> : null}
      {q.data && (isQuiet(q.data) ? <p className="muted">Nothing happened in the last {days} days.</p> : <Body r={q.data} />)}
    </div>
  );
}
