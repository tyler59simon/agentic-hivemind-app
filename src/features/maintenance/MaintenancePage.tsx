import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useMaintenanceEnabled, useRestoreEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import {
  domains as listDomains, maintenanceDisable, maintenanceEnable, maintenanceHistory, maintenanceRun, maintenanceStatus, meta, restoreNote,
  type MaintenanceDecision, type MaintenanceRun, type MaintenanceStatus,
} from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { useApp } from "../../store";
import { PageHeader } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { isUnbound } from "../recap/recap";
import { costText, nextRunText, resultText, runSummary, sortDecisions, usd, wasArchived } from "./maintenance";

const HISTORY_LIMIT = 30;
// The store's file watcher does not cover maintenance/ (run records and accounting), so the open page polls.
const POLL_MS = 60_000;

function NoteLink({ refId, title }: { refId: string; title?: string | null }) {
  const go = useApp((s) => s.go);
  const openNote = useWorkspace((s) => s.openNote);
  return (
    <a href="#" className="wikilink" onClick={(e) => { e.preventDefault(); go({ page: "memory", view: "notes" }); openNote(refId, { split: e.ctrlKey || e.metaKey, title: title ?? undefined }); }}>
      {title || refId}
    </a>
  );
}

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "");

function StatusCard({ s }: { s: MaintenanceStatus }) {
  const client = useQueryClient();
  // Enabling gives a model edit and archive authority over a domain, so the user names it here; nothing is inferred.
  const known = useQuery({ queryKey: ["domains"], queryFn: listDomains });
  const choices = (known.data?.domains ?? []).filter((d) => d.bound && !(known.data?.global_domains ?? []).includes(d.name)).map((d) => d.name);
  const [picked, setPicked] = useState<string>(s.domains[0] ?? "");
  const toggle = useMutation({
    mutationFn: () => (s.enabled ? maintenanceDisable() : maintenanceEnable(picked)),
    onSuccess: (r) => {
      recordOperation(r.operation_id);
      client.invalidateQueries({ queryKey: ["maintenance"] });
      toast(s.enabled ? "Maintenance turned off." : "Maintenance turned on.");
    },
    onError: (e) => toast(classify(e).message, "error"),
  });
  const a = s.accounting;
  const last = s.last_run;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{s.enabled ? "On" : "Off"}</h2>
        <span className="fill" />
        {!s.enabled && (
          <select aria-label="Domain to maintain" value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Choose a domain…</option>
            {choices.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <button className={s.enabled ? "" : "primary"} onClick={() => toggle.mutate()} disabled={toggle.isPending || (!s.enabled && !picked)}>
          {s.enabled ? "Disable" : "Enable"}
        </button>
      </div>
      <p>{s.enabled
        ? "A model reviews a few notes each day and keeps, confirms, updates or retires them. Every change is journaled and can be undone."
        : "Maintenance is off. Enable it and a model reviews a few notes each day, within the limits below."}</p>
      <p className="muted">{nextRunText(s)}</p>
      <dl className="properties">
        <div><dt>Model</dt><dd>{s.limits.model}</dd></div>
        <div><dt>Notes per day</dt><dd>{s.limits.max_notes_per_day}</dd></div>
        <div><dt>Daily budget</dt><dd>{usd(s.limits.daily_budget_usd)}</dd></div>
        <div><dt>Timeout</dt><dd>{s.limits.timeout_seconds} seconds</dd></div>
        <div><dt>Minimum interval</dt><dd>{Math.round(s.limits.min_interval_seconds / 3600)} hours</dd></div>
        <div><dt>Domains</dt><dd>{s.domains.length ? s.domains.join(", ") : "none"}</dd></div>
        {s.enabled_at && <div><dt>Enabled</dt><dd>{when(s.enabled_at)}</dd></div>}
      </dl>
      {a && <>
        <h4 className="work-day">Today ({a.day})</h4>
        <p>{a.reviewed} notes reviewed, {costText(a.charged_usd, a.cost_complete)} charged{Number(a.reserved_usd) > 0 ? `, ${usd(a.reserved_usd)} reserved for a run in progress` : ""}.</p>
      </>}
      {last && <p className="muted">Last run: {when(last.attempted_at)}, {last.status}. {runSummary(last)}.</p>}
      {s.errors.map((e, i) => <p key={i} className="error">{e}</p>)}
    </section>
  );
}

function Decision({ d, restoreOn, onDone }: { d: MaintenanceDecision; restoreOn: boolean; onDone: () => void }) {
  const note = useQuery({ queryKey: ["maintenance", "note", d.ref], queryFn: () => meta(d.ref), retry: false });
  const archivedNow = note.data?.status === "archived";
  const restore = useMutation({
    mutationFn: () => restoreNote(d.ref),
    onSuccess: (r) => { recordOperation(r.operation_id); toast("Restored. The note is active and pinned."); onDone(); },
    onError: (e) => toast(classify(e).message, "error"),
  });
  const reason = [d.rule, d.reason].filter(Boolean).join(": ");
  return (
    <div>
      <div className="work-head wraps">
        <span className="badge">{resultText(d)}</span>
        <NoteLink refId={d.ref} title={note.data?.title} />
        {note.data && note.data.status !== "active" && <span className="muted small">now {note.data.status}</span>}
        {wasArchived(d) && restoreOn && archivedNow && (
          <button className="text" onClick={() => restore.mutate()} disabled={restore.isPending}>Restore</button>
        )}
      </div>
      {reason && <div className="muted small">{reason}</div>}
    </div>
  );
}

function RunDetail({ id }: { id: string }) {
  const client = useQueryClient();
  const restoreOn = useRestoreEnabled();
  const q = useQuery({ queryKey: ["maintenance", "run", id], queryFn: () => maintenanceRun(id) });
  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.error) return <p className="error">{classify(q.error).message}</p>;
  const decisions = sortDecisions(q.data?.decisions ?? []);
  if (!decisions.length) return <p className="muted">This run recorded no decisions.</p>;
  return <>{decisions.map((d) => <Decision key={d.ref} d={d} restoreOn={restoreOn} onDone={() => refreshStore(client)} />)}</>;
}

function RunRow({ r, open, onToggle }: { r: MaintenanceRun; open: boolean; onToggle: () => void }) {
  return (
    <div className="work-group">
      <div className="work-head wraps">
        <button className="link" aria-expanded={open} onClick={onToggle}>{when(r.attempted_at)}</button>
        <span className="badge">{r.status}</span>
        <span className="muted small">{costText(r.charged_usd, r.cost_complete)}</span>
      </div>
      <div className="muted small">{runSummary(r)}{r.reason_code ? ` (${r.reason_code.replace(/_/g, " ")})` : ""}</div>
      {open && <RunDetail id={r.id} />}
    </div>
  );
}

/** Maintenance: automatic note review, from Living Memory's `maintenance` commands. */
export function MaintenancePage() {
  const enabled = useMaintenanceEnabled();
  const status = useQuery({ queryKey: ["maintenance", "status"], queryFn: maintenanceStatus, enabled, refetchInterval: POLL_MS });
  const history = useQuery({ queryKey: ["maintenance", "history"], queryFn: () => maintenanceHistory(HISTORY_LIMIT), enabled, refetchInterval: POLL_MS });
  const [open, setOpen] = useState<string | null>(null);
  const title = "Maintenance";
  const sub = "Automatic review of notes: what it checks, what it changed, and how to undo it.";
  if (!enabled) {
    return (
      <div className="page">
        <PageHeader title={title} subtitle={sub} />
        <p className="muted">This version of Living Memory has no <code>maintenance</code> command. Update Living Memory to use maintenance.</p>
      </div>
    );
  }
  const error = status.error ?? history.error;
  const unbound = isUnbound(error);
  return (
    <div className="page">
      <PageHeader title={title} subtitle={sub} />
      {(status.isLoading || history.isLoading) && <p className="muted">Loading…</p>}
      {unbound ? <p className="muted">This project has no bound domain, so there is nothing to maintain yet.</p> : error ? <p className="error">{classify(error).message}</p> : null}
      {status.data && <StatusCard s={status.data} />}
      {history.data && (
        <section className="section">
          <div className="section-head"><h2>Runs</h2></div>
          {!history.data.runs.length && <p className="muted">No maintenance runs yet.</p>}
          {history.data.runs.map((r) => <RunRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
        </section>
      )}
    </div>
  );
}
