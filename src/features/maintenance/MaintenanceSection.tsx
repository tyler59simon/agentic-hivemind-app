// Settings > Maintenance (CON-22): Living Memory's automatic note review. On and off with the domain it covers, its limits, the next
// run and today's spending, and its runs with each decision and Restore. Applied decisions are also in the Inbox.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useMaintenanceEnabled, useRestoreEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import {
  domains as listDomains, maintenanceDisable, maintenanceEnable, maintenanceHistory, maintenanceRun, maintenanceStatus, meta, restoreNote,
  type MaintenanceDecision, type MaintenanceRun, type MaintenanceStatus,
} from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { toastWriteFailure } from "../../lib/stale";
import { refreshStore } from "../../lib/refresh";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { isUnbound } from "../recap/recap";
import { costText, HISTORY_LIMIT, nextRunText, resultText, runSummary, sortDecisions, usd, wasArchived } from "./maintenance";

// The store's file watcher does not cover maintenance/ (run records and accounting), so the section polls while Settings is open.
const POLL_MS = 60_000;
/** Runs listed at first, and added by each Show more. */
const PAGE = 30;

function NoteLink({ refId, title }: { refId: string; title?: string | null }) {
  const openNote = useWorkspace((s) => s.openNote);
  return (
    <a href="#" className="wikilink" onClick={(e) => { e.preventDefault(); openNote(refId, { split: e.ctrlKey || e.metaKey, title: title ?? undefined }); }}>
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
  const [picked, setPicked] = useState("");
  // Only a domain the picker lists can be enabled; until the user picks, default to a configured domain that is still listed.
  const target = choices.includes(picked) ? picked : (s.domains.find((d) => choices.includes(d)) ?? "");
  const toggle = useMutation({
    mutationFn: () => (s.enabled ? maintenanceDisable() : maintenanceEnable(target)),
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
    <div className="maintenance-status">
      <div className="section-head">
        <h3>{s.enabled ? "On" : "Off"}</h3>
        <span className="fill" />
        {!s.enabled && (
          <select aria-label="Domain to maintain" value={target} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Choose a domain…</option>
            {choices.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <button className={s.enabled ? "" : "primary"} onClick={() => toggle.mutate()} disabled={toggle.isPending || (!s.enabled && !target)}>
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
        <h3 className="work-day">Today ({a.day})</h3>
        <p>{a.reviewed} notes reviewed, {costText(a.charged_usd, a.cost_complete)} charged{Number(a.reserved_usd) > 0 ? `, ${usd(a.reserved_usd)} reserved for a run in progress` : ""}.</p>
      </>}
      {last && <p className="muted">Last run: {when(last.attempted_at)}, {last.status}. {runSummary(last)}.</p>}
      {s.errors.map((e, i) => <p key={i} className="error">{e}</p>)}
    </div>
  );
}

function Decision({ d, restoreOn, onDone }: { d: MaintenanceDecision; restoreOn: boolean; onDone: () => void }) {
  const client = useQueryClient();
  const note = useQuery({ queryKey: ["maintenance", "note", d.ref], queryFn: () => meta(d.ref), retry: false });
  const archivedNow = note.data?.status === "archived";
  const restore = useMutation({
    mutationFn: (revision: string) => restoreNote(d.ref, revision),
    onSuccess: (r) => { recordOperation(r.operation_id); toast("Restored. The note is active and pinned."); onDone(); },
    onError: (e) => toastWriteFailure(client, e),
  });
  const reason = [d.rule, d.reason].filter(Boolean).join(": ");
  return (
    <div>
      <div className="work-head wraps">
        <span className="badge">{resultText(d)}</span>
        <NoteLink refId={d.ref} title={note.data?.title} />
        {note.data && note.data.status !== "active" && <span className="muted small">now {note.data.status}</span>}
        {wasArchived(d) && restoreOn && archivedNow && (
          <button className="text" onClick={() => restore.mutate(note.data!.revision)} disabled={restore.isPending}>Restore</button>
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

/** Maintenance in Settings, from Living Memory's `maintenance` commands. Nothing shows when this Living Memory has none. */
export function MaintenanceSection() {
  const enabled = useMaintenanceEnabled();
  const status = useQuery({ queryKey: ["maintenance", "status"], queryFn: maintenanceStatus, enabled, refetchInterval: POLL_MS });
  const history = useQuery({ queryKey: ["maintenance", "history"], queryFn: () => maintenanceHistory(HISTORY_LIMIT), enabled, refetchInterval: POLL_MS });
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  if (!enabled) return null;
  const error = status.error ?? history.error;
  const unbound = isUnbound(error);
  const runs = history.data?.runs ?? [];
  return (
    <section className="settings maintenance" id="settings-maintenance">
      <h2>Maintenance</h2>
      <p className="muted small">Automatic review of notes: what it checks, what it changed, and how to undo it.</p>
      {(status.isLoading || history.isLoading) && <p className="muted">Loading…</p>}
      {unbound ? <p className="muted">This project has no bound domain, so there is nothing to maintain yet.</p> : error ? <p className="error">{classify(error).message}</p> : null}
      {status.data && <StatusCard s={status.data} />}
      {history.data && (
        <>
          <h3>Runs</h3>
          {!runs.length && <p className="muted">No maintenance runs yet.</p>}
          {runs.slice(0, shown).map((r) => <RunRow key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />)}
          {runs.length > shown && <button type="button" className="link" onClick={() => setShown(shown + PAGE)}>Show more ({runs.length - shown} older)</button>}
        </>
      )}
    </section>
  );
}
