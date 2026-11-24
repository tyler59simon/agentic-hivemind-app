// Settings > Schedules (CON-20): the work Hivemind starts on its own, on a schedule or after an event. The three built-in
// schedules (morning briefing, memory maintenance, weekly wiki rebuilds) always show; every other automation is listed only
// while "Show custom automations" is on, a per-computer choice. Hidden automations keep running. Rust runs them all.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { rolesQuery, type Role } from "../../lib/agent";
import { BRIEFING_KINDS, BRIEFING_LABEL, type BriefingKind } from "../../lib/executive";
import { useProjectsEnabled, useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import {
  automationAct, automationDelete, automationPut, automationsQuery,
  type Automation, type AutomationRun, type AutomationView,
} from "../../lib/automations";
import { openSession, useApp } from "../../store";
import { Confirm } from "../../ui/Modal";
import { ArrowLink, Row } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useShownEngines } from "../agents/engines";
import { repoName } from "../agents/session";
import { morningBriefing } from "../home/BriefingCard";
import { projectsQuery } from "../projects/useProject";
import { systemsQuery } from "../systems/useSystem";
import {
  ACTION_HELP, ACTION_LABELS, actionOf, AUTOMATION_ROLES, AUTOMATION_RUN_WORDS, blankAutomation, builtIn, CAUSE_WORDS, clock, minutesOf, needsProject,
  nextText, scoped, showCustom, tone, TRIGGER_LABELS, triggerOf, useShowCustom, WEEKDAYS,
} from "./schedules";

const when = (ms: number) => new Date(ms).toLocaleString();
const fail = (e: unknown) => toast(classify(e).message, "error");

function useRoleLabels() {
  const roles = useQuery({ ...rolesQuery(), retry: false });
  return (role: Role) => roles.data?.find((r) => r.role === role)?.label ?? role;
}

function useProjects() {
  const enabled = useProjectsEnabled();
  return useQuery({ ...projectsQuery(), enabled }).data?.projects.filter((p) => p.status !== "archived" && p.repos.length) ?? [];
}

/** Project and repository selects; picking a project picks its first repository. */
function ProjectRepo({ project, repo, onChange }: { project: string; repo: string; onChange: (project: string, repo: string) => void }) {
  const projects = useProjects();
  const repos = projects.find((p) => p.slug === project)?.repos ?? [];
  return (
    <div className="flow-row">
      <label className="field grow">
        <span>Project</span>
        <select value={project} onChange={(e) => onChange(e.target.value, projects.find((p) => p.slug === e.target.value)?.repos[0] ?? "")}>
          <option value="">Pick a project</option>
          {projects.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
        </select>
      </label>
      <label className="field grow">
        <span>Repository</span>
        <select value={repo} onChange={(e) => onChange(project, e.target.value)} disabled={!repos.length}>
          {!repos.length && <option value="">No repository</option>}
          {repos.map((r) => <option key={r} value={r}>{repoName(r)}</option>)}
        </select>
      </label>
    </div>
  );
}

function AutomationForm({ initial, onDone }: { initial: Automation; onDone: (saved?: Automation) => void }) {
  const client = useQueryClient();
  const systems = useQuery({ ...systemsQuery(), enabled: useSystemsEnabled() });
  const label = useRoleLabels();
  const engines = useShownEngines();
  // A briefing may be about any project, with or without repositories.
  const projectList = useQuery({ ...projectsQuery(), enabled: useProjectsEnabled() }).data?.projects.filter((p) => p.status !== "archived") ?? [];
  const [a, setA] = useState<Automation>(initial);
  // A new automation made before the settings arrived may name a hidden engine; the form has no engine to pick.
  useEffect(() => {
    if (engines.ready && !initial.id && a.action.kind === "role" && !engines.shows(a.action.engine)) setA({ ...a, action: { ...a.action, engine: engines.first } });
  }, [engines, initial.id, a]);
  const [time, setTime] = useState("at" in initial.trigger ? clock(initial.trigger.at) : "09:00");
  const [busy, setBusy] = useState(false);
  const t = a.trigger;
  const setTimeText = (text: string) => {
    setTime(text);
    const m = minutesOf(text);
    if (m != null && "at" in t) setA({ ...a, trigger: { ...t, at: m } });
  };
  const save = () => {
    setBusy(true);
    automationPut(scoped(a)).then((saved) => { toast(`Saved ${saved.name}`); client.invalidateQueries({ queryKey: ["automations"] }); onDone(saved); }, fail).finally(() => setBusy(false));
  };
  const timeOk = !("at" in t) || minutesOf(time) != null;
  return (
    <div className="schedule-form">
      <h4>{initial.id ? `Edit ${initial.name}` : "New automation"}</h4>
      <label className="field"><span>Name</span><input value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></label>
      <div className="flow-row">
        <label className="field grow">
          <span>When</span>
          <select value={t.kind} onChange={(e) => setA({ ...a, trigger: triggerOf(e.target.value as Automation["trigger"]["kind"], t) })}>
            {Object.entries(TRIGGER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {t.kind === "every" && (
          <label className="field"><span>Hours</span><input type="number" min="1" max="168" value={t.hours} onChange={(e) => setA({ ...a, trigger: { ...t, hours: Math.max(1, Number(e.target.value) || 1) } })} /></label>
        )}
        {"at" in t && <label className="field"><span>Time (24-hour)</span><input value={time} aria-invalid={!timeOk} onChange={(e) => setTimeText(e.target.value)} /></label>}
      </div>
      {t.kind === "weekly" && (
        <div className="flow-checks" role="group" aria-label="Weekdays">
          {WEEKDAYS.map((d, i) => (
            <label key={d} className="check"><input type="checkbox" checked={t.days.includes(i)}
              onChange={() => setA({ ...a, trigger: { ...t, days: t.days.includes(i) ? t.days.filter((x) => x !== i) : [...t.days, i].sort() } })} /> {d}</label>
          ))}
        </div>
      )}
      <label className="field">
        <span>What it does</span>
        <select value={a.action.kind} onChange={(e) => setA({ ...a, action: actionOf(e.target.value as Automation["action"]["kind"], a.action, engines.first) })}>
          {/* Knowledge from new commits and briefings run on Claude Code. A wiki rebuild is made by the wiki's own switch, so only an existing one is listed. */}
          {Object.entries(ACTION_LABELS).filter(([k]) => k === "wiki_rebuild" ? initial.action.kind === k : (k !== "commit_capture" && k !== "executive_briefing") || engines.shows("claude") || initial.action.kind === k)
            .map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <p className="muted small">{ACTION_HELP[a.action.kind]}</p>
      {a.action.kind === "role" && (() => {
        const act = a.action;
        return (
          <>
            <label className="field">
              <span>Role</span>
              <select value={act.role} onChange={(e) => setA({ ...a, action: { ...act, role: e.target.value as Role } })}>
                {AUTOMATION_ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}
              </select>
            </label>
            <label className="field"><span>Instructions</span><textarea rows={4} value={act.prompt} onChange={(e) => setA({ ...a, action: { ...act, prompt: e.target.value } })} /></label>
          </>
        );
      })()}
      {a.action.kind === "architecture_check" && (() => {
        const act = a.action;
        return (
          <label className="field">
            <span>System</span>
            <select value={act.system} onChange={(e) => setA({ ...a, action: { ...act, system: e.target.value } })}>
              <option value="">Pick a system</option>
              {(systems.data?.systems ?? []).filter((s) => s.status !== "retired" && s.architecture).map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
            </select>
          </label>
        );
      })()}
      {a.action.kind === "executive_briefing" && (() => {
        const act = a.action;
        return (
          <>
            <label className="field">
              <span>Briefing</span>
              <select value={act.briefing} onChange={(e) => setA({ ...a, action: { ...act, briefing: e.target.value as BriefingKind } })}>
                {BRIEFING_KINDS.map((k) => <option key={k} value={k}>{BRIEFING_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Period</span>
              <select value={act.days} onChange={(e) => setA({ ...a, action: { ...act, days: Number(e.target.value) } })}>
                {[...new Set([1, 7, 14, 30, act.days])].sort((x, y) => x - y).map((d) => <option key={d} value={d}>Last {d} {d === 1 ? "day" : "days"}</option>)}
              </select>
            </label>
            <label className="field">
              <span>About</span>
              <select value={a.project ?? ""} onChange={(e) => setA({ ...a, project: e.target.value || null, repo: null })}>
                <option value="">All active projects</option>
                {projectList.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
              </select>
            </label>
          </>
        );
      })()}
      {needsProject(a) && <ProjectRepo project={a.project ?? ""} repo={a.repo ?? ""} onChange={(project, repo) => setA({ ...a, project, repo })} />}
      <div className="flow-row">
        <label className="field">
          <span>Notify me</span>
          <select value={a.notify} onChange={(e) => setA({ ...a, notify: e.target.value as Automation["notify"] })}>
            <option value="failures">When a run fails</option>
            <option value="all">After every run</option>
            <option value="none">Never</option>
          </select>
        </label>
        {(a.action.kind === "role" || a.action.kind === "wiki_rebuild") && (
          <label className="field"><span>{a.action.kind === "wiki_rebuild" ? "Budget per run (USD)" : "Budget per session (USD)"}</span>
            <input type="number" min="0.1" step="0.1" value={a.budgetUsd ?? ""} placeholder="Settings" onChange={(e) => setA({ ...a, budgetUsd: e.target.value ? Number(e.target.value) : null })} />
          </label>
        )}
      </div>
      <label className="check"><input type="checkbox" checked={a.askFirst} onChange={(e) => setA({ ...a, askFirst: e.target.checked })} /> Ask before each run (it waits here until you start it)</label>
      <label className="check"><input type="checkbox" checked={a.enabled} onChange={(e) => setA({ ...a, enabled: e.target.checked })} /> On</label>
      <p className="muted small">Automations run while Hivemind is open or in the tray. A scheduled run missed while it was closed runs once at the next start. Sessions and wiki rebuilds count against the daily automation budget under Spend, and start only when their budget per session fits in what is left (Codex sessions use your ChatGPT plan and are not counted); commit reviews and briefings count against the learning and executive budget.</p>
      <div className="work-actions">
        <button type="button" className="primary" disabled={busy || !a.name.trim() || !timeOk} onClick={save}>Save</button>
        <button type="button" disabled={busy} onClick={() => onDone()}>Cancel</button>
      </div>
    </div>
  );
}

function RunRow({ run, name }: { run: AutomationRun; name?: string }) {
  const client = useQueryClient();
  const act = (action: "approve" | "cancel") => automationAct(action, run.id).then(() => client.invalidateQueries({ queryKey: ["automations"] }), fail);
  return (
    <Row icon={<Clock size="1.3em" aria-hidden />} meta={<span className={`status-chip ${tone(run.state)}`}>{AUTOMATION_RUN_WORDS[run.state]}</span>}
      title={run.event ?? undefined}>
      {name ? <strong>{name}: </strong> : null}{CAUSE_WORDS[run.cause]}, {when(run.at)}{run.costUsd != null ? ` · $${run.costUsd.toFixed(2)}` : ""}
      {run.detail && <><br /><span className={`small ${run.state === "failed" ? "error" : "muted"}`}>{run.detail}</span></>}
      <span className="work-actions">
        {run.session && <ArrowLink onClick={() => openSession(run.session!)}>Session</ArrowLink>}
        {run.state === "waiting" && <button type="button" className="primary" onClick={() => act("approve")}>Start it</button>}
        {(run.state === "waiting" || run.state === "running") && <button type="button" onClick={() => act("cancel")}>Cancel</button>}
      </span>
    </Row>
  );
}

/** One automation: its schedule, an on/off switch, Run now, and its runs behind a disclosure. Custom ones also edit and remove. */
function ScheduleRow({ a, runs, onEdit, onRemove }: {
  a: AutomationView; runs: AutomationRun[]; onEdit?: () => void; onRemove?: () => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const refresh = () => client.invalidateQueries({ queryKey: ["automations"] });
  const projects = useQuery({ ...projectsQuery(), enabled: useProjectsEnabled() }).data?.projects ?? [];
  const about = a.project ? projects.find((p) => p.slug === a.project)?.name ?? a.project : a.action.kind === "executive_briefing" ? "All projects" : null;
  const toggle = (on: boolean) => {
    setBusy(true);
    automationPut({ ...a, enabled: on }).then(refresh, fail).finally(() => setBusy(false));
  };
  const runNow = () => automationAct("run", a.id).then((row) => {
    toast(row ? (row.state === "failed" ? row.detail ?? "The run failed" : `${a.name} started`) : `${a.name} is already running`, row?.state === "failed" ? "error" : undefined);
    refresh();
  }, fail);
  const mine = runs.filter((r) => r.automation === a.id);
  return (
    <div className="schedule-row" id={`automation-${a.id}`}>
      <label className="check" title={ACTION_HELP[a.action.kind]}>
        <input type="checkbox" checked={a.enabled} disabled={busy} onChange={(e) => toggle(e.target.checked)} />
        <span><strong>{a.name}</strong>{about ? ` · ${about}` : ""}{a.repo ? ` · ${repoName(a.repo)}` : ""}<br />
          <span className="muted small">{a.triggerText} · {nextText(a)}{a.askFirst ? " · Asks first" : ""}{a.lastRun ? ` · Last run ${when(a.lastRun)}` : ""}</span></span>
      </label>
      <div className="work-actions">
        <button type="button" onClick={runNow}>Run now</button>
        {onEdit && <button type="button" onClick={onEdit}>Edit</button>}
        {onRemove && <button type="button" className="ghost" onClick={onRemove}>Remove</button>}
      </div>
      {!!mine.length && (
        <details>
          <summary className="small">Runs ({mine.length})</summary>
          {mine.slice(0, 10).map((r) => <RunRow key={r.id} run={r} />)}
        </details>
      )}
    </div>
  );
}

/** A built-in schedule not made yet: its switch makes it, already on. */
function AddRow({ title, hint, make }: { title: string; hint: string; make: () => Automation }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const add = () => {
    setBusy(true);
    automationPut(make()).then(() => client.invalidateQueries({ queryKey: ["automations"] }), fail).finally(() => setBusy(false));
  };
  return (
    <div className="schedule-row">
      <label className="check" title={hint}>
        <input type="checkbox" checked={false} disabled={busy} onChange={(e) => { if (e.target.checked) add(); }} />
        <span><strong>{title}</strong><br /><span className="muted small">{hint}</span></span>
      </label>
    </div>
  );
}

/** Settings > Schedules. Outside the settings form: everything here takes effect at once, without Save. */
export function SchedulesSection() {
  const client = useQueryClient();
  const data = useQuery({ ...automationsQuery(), retry: false });
  const engines = useShownEngines();
  const current = useApp((s) => (typeof s.project === "string" ? s.project : null));
  const projects = useQuery({ ...projectsQuery(), enabled: useProjectsEnabled() }).data?.projects.filter((p) => p.status !== "archived" && p.repos.length) ?? [];
  const custom = useShowCustom();
  // A link to one automation (a session's Automation chip, Home's activity) shows it even while custom ones are hidden.
  const linked = useApp((s) => s.settings?.automation);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [asking, setAsking] = useState<Automation | null>(null);
  const list = data.data?.automations ?? [];
  const runs = data.data?.runs ?? [];
  const templates = data.data?.templates ?? [];
  const waiting = runs.filter((r) => r.state === "waiting");
  const nameOf = (id: string) => list.find((a) => a.id === id)?.name ?? "Removed automation";
  const built = list.filter(builtIn);
  const others = list.filter((a) => !builtIn(a));
  const home = projects.find((p) => p.slug === current) ?? projects[0];
  const fromTemplate = (t: Automation) => setEditing({
    ...t, action: t.action.kind === "role" && !engines.shows(t.action.engine) ? { ...t.action, engine: engines.first } : t.action,
    id: "", enabled: true, project: t.project === null ? null : home?.slug ?? "", repo: t.project === null ? null : home?.repos[0] ?? "",
  });
  const nightly = templates.find((t) => t.action.kind === "memory_maintenance");
  const claude = engines.shows("claude");
  const remove = (a: Automation) => automationDelete(a.id).then(() => client.invalidateQueries({ queryKey: ["automations"] }), fail);
  return (
    <section className="settings schedules" id="settings-schedules" aria-labelledby="schedules-title">
      <h3 id="schedules-title">Schedules</h3>
      <p className="muted small">Work Hivemind starts on its own while it is open or in the tray. A scheduled run missed while it was closed runs once at the next start. Changes here take effect at once and do not need Save.</p>
      {data.isLoading && <p className="muted small">Loading…</p>}
      {data.error && <p className="error small">{classify(data.error).message}</p>}
      {!!waiting.length && (
        <div className="schedule-waiting">
          <h4>Waiting for you ({waiting.length})</h4>
          {waiting.map((r) => <RunRow key={r.id} run={r} name={nameOf(r.automation)} />)}
        </div>
      )}
      {data.isSuccess && (
        <>
          {built.map((a) => editing?.id === a.id
            ? <AutomationForm key={a.id} initial={editing} onDone={() => setEditing(null)} />
            : <ScheduleRow key={a.id} a={a} runs={runs} onEdit={() => setEditing(a)} onRemove={() => setAsking(a)} />)}
          {claude && !built.some((a) => a.action.kind === "executive_briefing") && (
            <AddRow title="Morning briefing" hint="A priorities briefing about all active projects every day at 08:00, kept on Home. Counts against the learning budget." make={() => morningBriefing(null, true)} />
          )}
          {nightly && !built.some((a) => a.action.kind === "memory_maintenance") && (
            <AddRow title={nightly.name} hint={`${nightly.triggerText}. ${ACTION_HELP.memory_maintenance}`} make={() => ({ ...nightly, id: "", enabled: true })} />
          )}
          {!built.some((a) => a.action.kind === "wiki_rebuild") && <p className="muted small">A weekly wiki rebuild is turned on per project with Rebuild weekly in Notes, Wiki.</p>}
          <label className="check"><input type="checkbox" checked={custom} onChange={(e) => showCustom(e.target.checked)} /> Show custom automations{others.length ? ` (${others.length})` : ""}</label>
          {!custom && others.filter((a) => a.id === linked).map((a) => editing?.id === a.id
            ? <AutomationForm key={a.id} initial={editing} onDone={() => setEditing(null)} />
            : <ScheduleRow key={a.id} a={a} runs={runs} onEdit={() => setEditing(a)} onRemove={() => setAsking(a)} />)}
          {custom && (
            <div className="schedule-custom">
              {others.map((a) => editing?.id === a.id
                ? <AutomationForm key={a.id} initial={editing} onDone={() => setEditing(null)} />
                : <ScheduleRow key={a.id} a={a} runs={runs} onEdit={() => setEditing(a)} onRemove={() => setAsking(a)} />)}
              {editing && !editing.id
                ? <AutomationForm key={editing.name || "new"} initial={editing} onDone={() => setEditing(null)} />
                : (
                  <div className="work-actions">
                    <button type="button" onClick={() => setEditing(blankAutomation(home?.slug ?? null, home?.repos[0] ?? null, engines.first))}>New automation</button>
                    <select aria-label="Add a built-in automation" value="" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) fromTemplate(t); }}>
                      <option value="">Add from a template…</option>
                      {templates.filter((t) => !builtIn(t) && ((t.action.kind !== "commit_capture" && t.action.kind !== "executive_briefing") || claude))
                        .map((t) => <option key={t.id} value={t.id}>{t.name} ({t.triggerText})</option>)}
                    </select>
                  </div>
                )}
            </div>
          )}
        </>
      )}
      {asking && <Confirm title={`Remove ${asking.name}?`} action="Remove" danger message="The automation and its run history are removed. Sessions it started stay."
        onAnswer={(yes) => { const a = asking; setAsking(null); if (yes) remove(a); }} />}
    </section>
  );
}
