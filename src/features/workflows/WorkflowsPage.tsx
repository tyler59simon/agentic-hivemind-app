// Workflows: a goal split into tasks that agent sessions run in roles, with dependencies; and automations, the work
// Hivemind starts on its own on a schedule or after an event. Rust runs both; this page plans, starts and inspects them.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Clock, GitFork, Plus, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { ENGINE_LABELS, repoBranches, rolesQuery, type Engine, type Role } from "../../lib/agent";
import { BRIEFING_KINDS, BRIEFING_LABEL, type BriefingKind } from "../../lib/executive";
import { useProjectsEnabled, useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import {
  automationAct, automationDelete, automationPut, automationsQuery, workflowAct, workflowCreate, workflowDelete, workflowEdit,
  workflowReport, workflowsQuery, workflowTemplatesQuery,
  type Automation, type AutomationRun, type NewRun, type Task, type TaskSpec, type WorkflowRun,
} from "../../lib/workflows";
import { openSession, openSystem, openWorkflows, useApp } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { Confirm } from "../../ui/Modal";
import { ArrowLink, PageHeader, Row, Section, Tabs } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useShownEngines } from "../agents/engines";
import { repoName } from "../agents/session";
import { projectsQuery } from "../projects/useProject";
import { systemsForProject } from "../projects/scope";
import { MiniDiagram } from "../systems/MiniDiagram";
import { systemsQuery, useSystem } from "../systems/useSystem";
import {
  ACTION_HELP, ACTION_LABELS, actionOf, AUTOMATION_ROLES, AUTOMATION_RUN_WORDS, blankAutomation, CAUSE_WORDS, clock, columns, minutesOf, needsProject, scoped,
  nextText, progressText, RUN_WORDS, TASK_WORDS, taskActions, taskId, toggleDependency, tone, TRIGGER_LABELS, triggerOf, WEEKDAYS, withoutTask,
} from "./workflows";

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

/** The editable task list of a planned workflow. */
function TaskEditor({ tasks, onChange }: { tasks: TaskSpec[]; onChange: (tasks: TaskSpec[]) => void }) {
  const roles = useQuery({ ...rolesQuery(), retry: false });
  const { shown, first } = useShownEngines();
  const put = (i: number, t: TaskSpec) => onChange(tasks.map((x, j) => (j === i ? t : x)));
  const add = () => onChange([...tasks, { id: taskId("Task", tasks.map((t) => t.id)), role: "developer", engine: first, title: "", prompt: "", dependsOn: [], from: null }]);
  return (
    <div className="flow-editor">
      {tasks.map((t, i) => {
        const others = tasks.filter((o) => o.id !== t.id);
        return (
          <fieldset key={t.id} className="flow-task-edit">
            <legend>{t.id}</legend>
            <div className="flow-row">
              <label className="field grow"><span>Title</span><input value={t.title} onChange={(e) => put(i, { ...t, title: e.target.value })} /></label>
              <label className="field">
                <span>Role</span>
                <select value={t.role} onChange={(e) => put(i, { ...t, role: e.target.value as Role })}>
                  {(roles.data ?? []).map((r) => <option key={r.role} value={r.role}>{r.label}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Engine</span>
                <select value={t.engine} onChange={(e) => put(i, { ...t, engine: e.target.value as Engine })}>
                  {/* A saved task keeps its hidden engine in the list so the select shows what it will run. */}
                  {(shown.includes(t.engine) ? shown : [...shown, t.engine]).map((e) => <option key={e} value={e}>{ENGINE_LABELS[e]}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span>Instructions</span><textarea rows={3} value={t.prompt} onChange={(e) => put(i, { ...t, prompt: e.target.value })} /></label>
            {!!others.length && (
              <div className="flow-row">
                <div className="field grow">
                  <span>Starts after</span>
                  <div className="flow-checks">
                    {others.map((o) => (
                      <label key={o.id} className="check"><input type="checkbox" checked={t.dependsOn.includes(o.id)} onChange={() => put(i, toggleDependency(t, o.id))} /> {o.title || o.id}</label>
                    ))}
                  </div>
                </div>
                <label className="field">
                  <span>Worktree starts from</span>
                  <select value={t.from ?? ""} onChange={(e) => put(i, { ...t, from: e.target.value || null })}>
                    <option value="">The base branch</option>
                    {t.dependsOn.map((d) => <option key={d} value={d}>{tasks.find((x) => x.id === d)?.title || d}'s checkpoint</option>)}
                  </select>
                </label>
              </div>
            )}
            <div className="work-actions"><button className="ghost" onClick={() => onChange(withoutTask(tasks, t.id))}>Remove task</button></div>
          </fieldset>
        );
      })}
      <div className="work-actions"><button onClick={add}><Plus size="1em" aria-hidden /> Add a task</button></div>
    </div>
  );
}

function NewWorkflow({ onDone }: { onDone: (run?: WorkflowRun) => void }) {
  const templates = useQuery(workflowTemplatesQuery());
  const current = useApp((s) => (typeof s.project === "string" ? s.project : ""));
  const projects = useProjects();
  const first = projects.find((p) => p.slug === current) ?? projects[0];
  const [form, setForm] = useState<NewRun>({
    goal: "", project: first?.slug ?? "", repo: first?.repos[0] ?? "", baseBranch: null, template: null, model: null, unattended: false, budgetUsd: null, tasks: [],
  });
  const [busy, setBusy] = useState(false);
  const engines = useShownEngines();
  const branches = useQuery({ queryKey: ["repo", "branches", form.project, form.repo], queryFn: () => repoBranches(form.project, form.repo), retry: false, enabled: !!form.project && !!form.repo });
  const pick = (id: string) => {
    const t = templates.data?.find((x) => x.id === id);
    setForm({ ...form, template: t?.id ?? null, tasks: t ? t.tasks.map((x) => ({ ...x, engine: engines.shows(x.engine) ? x.engine : engines.first })) : [] });
  };
  const create = () => {
    setBusy(true);
    workflowCreate(form).then((run) => { toast("Workflow planned: check the tasks, then start it"); onDone(run); }, fail).finally(() => setBusy(false));
  };
  return (
    <div className="review-pane">
      <h2>New workflow</h2>
      <p className="muted">Each task runs as its own agent session in a role. A task starts when the tasks it depends on are done. Editing tasks work in their own worktree, and their edits wait for your approval in the Inbox; nothing is merged or pushed.</p>
      <label className="field">
        <span>Template</span>
        <select value={form.template ?? ""} onChange={(e) => pick(e.target.value)}>
          <option value="">Start from no tasks</option>
          {templates.data?.map((t) => <option key={t.id} value={t.id}>{t.name}: {t.description}</option>)}
        </select>
      </label>
      <label className="field"><span>Goal</span><textarea rows={3} value={form.goal} placeholder="What should the workflow achieve?" onChange={(e) => setForm({ ...form, goal: e.target.value })} /></label>
      <ProjectRepo project={form.project} repo={form.repo} onChange={(project, repo) => setForm({ ...form, project, repo, baseBranch: null })} />
      <div className="flow-row">
        <label className="field grow">
          <span>Base branch</span>
          <select value={form.baseBranch ?? ""} onChange={(e) => setForm({ ...form, baseBranch: e.target.value || null })}>
            <option value="">The current branch{branches.data?.current ? ` (${branches.data.current})` : ""}</option>
            {branches.data?.branches.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="field"><span>Claude model</span><input value={form.model ?? ""} placeholder="Default" onChange={(e) => setForm({ ...form, model: e.target.value || null })} /></label>
        <label className="field"><span>Budget per session (USD)</span>
          <input type="number" min="0.1" step="0.1" value={form.budgetUsd ?? ""} placeholder="Settings" onChange={(e) => setForm({ ...form, budgetUsd: e.target.value ? Number(e.target.value) : null })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.unattended} onChange={(e) => setForm({ ...form, unattended: e.target.checked })} />
        Run unattended: sessions use their role's permissions and never ask. Shell commands outside the project's allowed list are refused.
      </label>
      <Section title="Tasks"><TaskEditor tasks={form.tasks} onChange={(tasks) => setForm({ ...form, tasks })} /></Section>
      <div className="work-actions">
        <button className="primary" disabled={busy || !form.goal.trim() || !form.repo || !form.tasks.length} onClick={create}>Plan the workflow</button>
        <button onClick={() => onDone()}>Cancel</button>
      </div>
    </div>
  );
}

function TaskCard({ run, task, label, onAct }: { run: WorkflowRun; task: Task; label: (r: Role) => string; onAct: (action: "retry" | "skip", task: string) => void }) {
  const after = task.dependsOn.map((d) => run.tasks.find((t) => t.id === d)?.title ?? d);
  return (
    <div className={`flow-task ${task.state}`}>
      <div className="flow-task-head">
        <span className="muted small">{label(task.role)}{task.engine === "codex" ? " · Codex" : ""}</span>
        <span className={`status-chip ${tone(task.state)}`}>{TASK_WORDS[task.state]}</span>
      </div>
      <strong>{task.title}</strong>
      {!!after.length && <span className="muted small">After {after.join(", ")}{task.from && (task.dependsOn.length > 1
        ? `, in a worktree from ${run.tasks.find((t) => t.id === task.from)?.title ?? task.from}'s checkpoint`
        : ", in a worktree from its checkpoint")}</span>}
      {task.verdict && <span className={`status-chip ${task.verdict === "pass" ? "ok" : "warn"}`}>{task.verdict === "pass" ? "Verdict: pass" : "Verdict: changes needed"}</span>}
      {task.branch && <span className="muted small mono">{task.branch} · {task.files} file{task.files === 1 ? "" : "s"}{task.checkpoint ? ` · ${task.checkpoint.slice(0, 7)}` : ""}</span>}
      {task.error && <span className="error small">{task.error}</span>}
      {task.summary && <details><summary className="small">Summary</summary><div className="markdown small"><Markdown>{task.summary}</Markdown></div></details>}
      <div className="work-actions">
        {task.session && <ArrowLink onClick={() => openSession(task.session!)}>Session</ArrowLink>}
        {taskActions(run, task).map((a) => <button key={a} onClick={() => onAct(a, task.id)}>{a === "retry" ? "Retry" : "Skip"}</button>)}
      </div>
    </div>
  );
}

/** The system the run's repository belongs to, drawn small, with a link to its architecture. */
function RunSystem({ repo }: { repo: string }) {
  const systems = useQuery({ ...systemsQuery(), enabled: useSystemsEnabled() });
  const system = systemsForProject({ repos: [repo] }, (systems.data?.systems ?? []).filter((s) => s.status !== "retired"))[0];
  const { architecture } = useSystem(system?.slug);
  const model = architecture.data?.model ?? null;
  if (!system || !model) return null;
  return (
    <div className="flow-system">
      <ArrowLink onClick={() => openSystem(system.slug)}>{system.name}</ArrowLink>
      <MiniDiagram model={model} />
    </div>
  );
}

function RunDetail({ run }: { run: WorkflowRun }) {
  const client = useQueryClient();
  const label = useRoleLabels();
  const [editing, setEditing] = useState<TaskSpec[] | null>(null);
  const [asking, setAsking] = useState<null | "cancel" | "delete">(null);
  const report = useQuery({ queryKey: ["workflows", "report", run.id, run.state, run.tasks.map((t) => t.state).join()], queryFn: () => workflowReport(run.id), enabled: run.state !== "planned" });
  const refresh = () => client.invalidateQueries({ queryKey: ["workflows"] });
  const act = (action: "start" | "cancel" | "retry" | "skip", task?: string) => workflowAct(run.id, action, task).then(refresh, fail);
  const remove = () => workflowDelete(run.id).then(() => { refresh(); openWorkflows(); }, fail);
  const save = () => editing && workflowEdit(run.id, editing).then(() => { setEditing(null); refresh(); }, fail);
  const origin = run.origin?.startsWith("automation:") ? "Started by an automation" : null;
  return (
    <div className="review-pane">
      <h2>{run.goal.split("\n")[0]} <span className={`status-chip ${tone(run.state)}`}>{RUN_WORDS[run.state]}</span></h2>
      <p className="muted small">
        {repoName(run.repo)}{run.baseBranch ? ` from ${run.baseBranch}` : ""} · {progressText(run)} · {run.unattended ? "Unattended" : "Sessions ask before acting"}
        {run.budgetUsd ? ` · $${run.budgetUsd.toFixed(2)} per session` : ""} · Created {when(run.createdAt)}{origin ? ` · ${origin}` : ""}
      </p>
      {run.saveError && <p className="error small" role="alert">{run.saveError}</p>}
      {run.goal.includes("\n") && <div className="markdown"><Markdown>{run.goal}</Markdown></div>}
      <RunSystem repo={run.repo} />
      <div className="work-actions">
        {run.state === "planned" && !editing && <button className="primary" onClick={() => act("start")}>Start</button>}
        {run.state === "planned" && !editing && <button onClick={() => setEditing(run.tasks.map(({ id, role, engine, title, prompt, dependsOn, from }) => ({ id, role, engine, title, prompt, dependsOn, from })))}>Edit tasks</button>}
        {(run.state === "running" || run.state === "planned") && !editing && <button onClick={() => setAsking("cancel")}>Cancel</button>}
        {run.state !== "running" && !editing && <button className="ghost" onClick={() => setAsking("delete")}>Remove</button>}
        {report.data && <button className="ghost" onClick={() => navigator.clipboard.writeText(report.data!).then(() => toast("Report copied"), fail)}>Copy report</button>}
      </div>
      {editing ? (
        <Section title="Tasks">
          <TaskEditor tasks={editing} onChange={setEditing} />
          <div className="work-actions"><button className="primary" onClick={save}>Save tasks</button><button onClick={() => setEditing(null)}>Discard</button></div>
        </Section>
      ) : (
        <div className="flow-graph" role="list" aria-label="Tasks by order">
          {columns(run.tasks).map((col, i) => (
            <div key={i} className="flow-step">
              {i > 0 && <ChevronRight className="flow-arrow" size="1.3em" aria-hidden />}
              <div className="flow-col">{col.map((t) => <TaskCard key={t.id} run={run} task={t} label={label} onAct={(a, id) => act(a, id)} />)}</div>
            </div>
          ))}
        </div>
      )}
      {report.data && run.state !== "running" && <Section title="Report"><div className="markdown"><Markdown>{report.data.replace(/^# .*\n/, "")}</Markdown></div></Section>}
      {asking === "cancel" && <Confirm title="Cancel this workflow?" action="Cancel the workflow" danger message="Running sessions are stopped and tasks that have not started are cancelled. Edits already made stay on their branches."
        onAnswer={(yes) => { setAsking(null); if (yes) act("cancel"); }} />}
      {asking === "delete" && <Confirm title="Remove this workflow?" action="Remove" danger message="The workflow's record is removed. Its sessions and their branches stay."
        onAnswer={(yes) => { setAsking(null); if (yes) remove(); }} />}
    </div>
  );
}

function RunsTab({ picked }: { picked?: string }) {
  const runs = useQuery(workflowsQuery());
  const [creating, setCreating] = useState(false);
  const list = runs.data ?? [];
  const selected = list.find((r) => r.id === picked) ?? (creating ? undefined : list[0]);
  return (
    <div className="review">
      <nav className="review-list" aria-label="Workflows">
        <button className="review-item" onClick={() => setCreating(true)}><Plus size="1.3em" aria-hidden /><span className="grow">New workflow</span></button>
        {runs.isLoading && <p className="muted pad">Loading…</p>}
        {runs.error && <p className="error pad">{classify(runs.error).message}</p>}
        {!runs.isLoading && !list.length && <p className="muted pad small">No workflows yet.</p>}
        {list.map((r) => (
          <button key={r.id} className={`review-item ${!creating && selected?.id === r.id ? "on" : ""}`} aria-current={!creating && selected?.id === r.id}
            onClick={() => { setCreating(false); openWorkflows({ run: r.id }); }}>
            <GitFork size="1.3em" aria-hidden />
            <span className="grow">{r.goal.split("\n")[0]}<br /><span className={`small ${r.state === "failed" ? "error" : "muted"}`}>{RUN_WORDS[r.state]} · {progressText(r)}</span></span>
          </button>
        ))}
      </nav>
      {creating || !selected
        ? (creating ? <NewWorkflow onDone={(run) => { setCreating(false); if (run) openWorkflows({ run: run.id }); }} />
          : <div className="review-pane"><p className="muted">A workflow splits a goal into tasks for agents in roles: an architect plans, a developer builds, a reviewer and a tester check the result. Start one with New workflow.</p></div>)
        : <RunDetail key={selected.id} run={selected} />}
    </div>
  );
}

function AutomationForm({ initial, onDone }: { initial: Automation; onDone: (saved?: Automation) => void }) {
  const client = useQueryClient();
  const templates = useQuery(workflowTemplatesQuery());
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
    <div className="review-pane">
      <h2>{initial.id ? `Edit ${initial.name}` : "New automation"}</h2>
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
          {/* Knowledge from new commits and briefings run on Claude Code. */}
          {Object.entries(ACTION_LABELS).filter(([k]) => (k !== "commit_capture" && k !== "executive_briefing") || engines.shows("claude") || initial.action.kind === k)
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
      {a.action.kind === "workflow" && (() => {
        const act = a.action;
        return (
          <>
            <label className="field">
              <span>Template</span>
              <select value={act.template} onChange={(e) => setA({ ...a, action: { ...act, template: e.target.value } })}>
                {templates.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Goal</span><textarea rows={3} value={act.goal} onChange={(e) => setA({ ...a, action: { ...act, goal: e.target.value } })} /></label>
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
                {[7, 14, 30].map((d) => <option key={d} value={d}>Last {d} days</option>)}
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
        {(a.action.kind === "role" || a.action.kind === "workflow") && (
          <label className="field"><span>Budget per session (USD)</span>
            <input type="number" min="0.1" step="0.1" value={a.budgetUsd ?? ""} placeholder="Settings" onChange={(e) => setA({ ...a, budgetUsd: e.target.value ? Number(e.target.value) : null })} />
          </label>
        )}
      </div>
      <label className="check"><input type="checkbox" checked={a.askFirst} onChange={(e) => setA({ ...a, askFirst: e.target.checked })} /> Ask before each run (it waits here until you start it)</label>
      <label className="check"><input type="checkbox" checked={a.enabled} onChange={(e) => setA({ ...a, enabled: e.target.checked })} /> On</label>
      <p className="muted small">Automations run while Hivemind is open or in the tray. A scheduled run missed while it was closed runs once at the next start. Sessions and workflows count against the daily automation budget in Settings, Budgets, and start only when their budget per session fits in what is left (Codex sessions use your ChatGPT plan and are not counted); commit reviews and briefings count against the learning and executive budget.</p>
      <div className="work-actions">
        <button className="primary" disabled={busy || !a.name.trim() || !timeOk} onClick={save}>Save</button>
        <button onClick={() => onDone()}>Cancel</button>
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
        {run.workflow && <ArrowLink onClick={() => openWorkflows({ run: run.workflow! })}>Workflow</ArrowLink>}
        {run.state === "waiting" && <button className="primary" onClick={() => act("approve")}>Start it</button>}
        {(run.state === "waiting" || run.state === "running") && <button onClick={() => act("cancel")}>Cancel</button>}
      </span>
    </Row>
  );
}

function AutomationsTab({ picked }: { picked?: string }) {
  const client = useQueryClient();
  const data = useQuery(automationsQuery());
  const current = useApp((s) => (typeof s.project === "string" ? s.project : null));
  const projects = useProjects();
  const [editing, setEditing] = useState<Automation | null>(null);
  const [asking, setAsking] = useState<Automation | null>(null);
  const list = data.data?.automations ?? [];
  const selected = list.find((a) => a.id === picked) ?? list[0];
  const runs = data.data?.runs ?? [];
  const waiting = runs.filter((r) => r.state === "waiting");
  const nameOf = (id: string) => list.find((a) => a.id === id)?.name ?? "Removed automation";
  const refresh = () => client.invalidateQueries({ queryKey: ["automations"] });
  const home = projects.find((p) => p.slug === current) ?? projects[0];
  const engines = useShownEngines();
  const fromTemplate = (t: Automation) => setEditing({ ...t, action: t.action.kind === "role" && !engines.shows(t.action.engine) ? { ...t.action, engine: engines.first } : t.action, id: "", enabled: true, project: t.project === null ? null : home?.slug ?? "", repo: t.project === null ? null : home?.repos[0] ?? "" });
  const runNow = (a: Automation) => automationAct("run", a.id).then((row) => {
    toast(row ? (row.state === "failed" ? row.detail ?? "The run failed" : `${a.name} started`) : `${a.name} is already running`, row?.state === "failed" ? "error" : undefined);
    refresh();
  }, fail);
  const toggle = (a: Automation) => automationPut({ ...a, enabled: !a.enabled }).then(refresh, fail);
  const remove = (a: Automation) => automationDelete(a.id).then(() => { refresh(); openWorkflows({ tab: "automations" }); }, fail);
  return (
    <div className="review">
      <nav className="review-list" aria-label="Automations">
        <button className="review-item" onClick={() => setEditing(blankAutomation(home?.slug ?? null, home?.repos[0] ?? null, engines.first))}><Plus size="1.3em" aria-hidden /><span className="grow">New automation</span></button>
        {data.isLoading && <p className="muted pad">Loading…</p>}
        {data.error && <p className="error pad">{classify(data.error).message}</p>}
        {list.map((a) => (
          <button key={a.id} className={`review-item ${!editing && selected?.id === a.id ? "on" : ""}`} aria-current={!editing && selected?.id === a.id}
            onClick={() => { setEditing(null); openWorkflows({ tab: "automations", automation: a.id }); }}>
            <Workflow size="1.3em" aria-hidden />
            <span className="grow">{a.name}<br /><span className="small muted">{a.triggerText} · {nextText(a)}</span></span>
          </button>
        ))}
        <h2 className="review-group">Built in</h2>
        <p className="muted small pad">Add one to change and turn it on. All start off.</p>
        {data.data?.templates.filter((t) => (t.action.kind !== "commit_capture" && t.action.kind !== "executive_briefing") || engines.shows("claude")).map((t) => (
          <button key={t.id} className="review-item" title={ACTION_HELP[t.action.kind]} onClick={() => fromTemplate(t)}>
            <Plus size="1.3em" aria-hidden /><span className="grow">{t.name}<br /><span className="small muted">{t.triggerText}</span></span>
          </button>
        ))}
      </nav>
      {editing ? (
        <AutomationForm key={editing.id || editing.name || "new"} initial={editing} onDone={(saved) => { setEditing(null); if (saved) openWorkflows({ tab: "automations", automation: saved.id }); }} />
      ) : (
        <div className="review-pane">
          {!!waiting.length && (
            <Section title="Waiting for you" count={waiting.length}>
              {waiting.map((r) => <RunRow key={r.id} run={r} name={nameOf(r.automation)} />)}
            </Section>
          )}
          {selected ? (
            <>
              <h2>{selected.name} <span className={`status-chip ${selected.enabled ? "ok" : ""}`}>{selected.enabled ? "On" : "Off"}</span></h2>
              <p className="muted small">
                {selected.triggerText} · {ACTION_LABELS[selected.action.kind]}{selected.repo ? ` in ${repoName(selected.repo)}` : ""} · {nextText(selected)}
                {selected.askFirst ? " · Asks first" : ""}{selected.lastRun ? ` · Last run ${when(selected.lastRun)}` : ""}
              </p>
              <div className="work-actions">
                <button className="primary" onClick={() => runNow(selected)}>Run now</button>
                <button onClick={() => toggle(selected)}>{selected.enabled ? "Turn off" : "Turn on"}</button>
                <button onClick={() => setEditing(selected)}>Edit</button>
                <button className="ghost" onClick={() => setAsking(selected)}>Remove</button>
              </div>
              <Section title="Runs" empty={runs.some((r) => r.automation === selected.id) ? undefined : "It has not run yet."}>
                {runs.filter((r) => r.automation === selected.id).map((r) => <RunRow key={r.id} run={r} />)}
              </Section>
            </>
          ) : (
            <p className="muted">Automations start work on their own: a weekly review of new commits, nightly memory maintenance, an investigation when a session fails. Add one from the built-in list or start from New automation.</p>
          )}
        </div>
      )}
      {asking && <Confirm title={`Remove ${asking.name}?`} action="Remove" danger message="The automation and its run history are removed. Sessions and workflows it started stay."
        onAnswer={(yes) => { const a = asking; setAsking(null); if (yes) remove(a); }} />}
    </div>
  );
}

export function WorkflowsPage() {
  const route = useApp((s) => (s.route.page === "workflows" ? s.route : undefined));
  const tab = route?.tab ?? "runs";
  const automations = useQuery(automationsQuery());
  const waiting = automations.data?.runs.filter((r) => r.state === "waiting").length ?? 0;
  return (
    <div className="page fill-page">
      <PageHeader title="Workflows" subtitle="Plan work for several agents, and let Hivemind start recurring work on its own." />
      <Tabs label="Workflows" value={tab} onChange={(id) => openWorkflows({ tab: id })}
        items={[{ id: "runs", label: "Runs" }, { id: "automations", label: "Automations", count: waiting || undefined }]} />
      {tab === "runs" ? <RunsTab picked={route?.run} /> : <AutomationsTab picked={route?.automation} />}
    </div>
  );
}
