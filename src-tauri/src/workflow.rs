//! Workflows: a goal split into tasks, each run by an agent session in a role, with dependencies between them. A task
//! starts when everything it depends on has succeeded; up to MAX_RUNNING sessions run at once. When an editing task
//! succeeds, its edits become a checkpoint commit on the task's own `hivemind/<id8>` branch (never merged, never pushed),
//! and a task that builds on it gets a new worktree branched from that commit. Parallel tasks never share a working tree.
//!
//! Runs are kept in `app_data_dir/workflows/<id>.json`. The executor is driven by session reports (no polling).
use crate::agent::roles::{Profile, Role, Verdict};
use crate::agent::scope::AgentTask;
use crate::agent::{now_ms, Engine, Interface, Lifecycle, SessionInfo, StartOptions};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Mutex;

/// The most characters of an upstream task's summary a dependent task gets.
const UPSTREAM_SUMMARY: usize = 2000;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Waiting,
    Running,
    Succeeded,
    Failed,
    /// Something it depends on failed or was cancelled.
    Blocked,
    Skipped,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Created, not started: the user can still edit the tasks.
    Planned,
    Running,
    Succeeded,
    /// Finished with a failed or blocked task.
    Failed,
    Cancelled,
}

/// One task as the user (or a template) writes it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpec {
    pub id: String,
    pub role: Role,
    #[serde(default)]
    pub engine: Engine,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    /// The task whose checkpoint this task's worktree starts from; None starts from the run's base branch. Must be one of
    /// `depends_on`.
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(flatten)]
    pub spec: TaskSpec,
    pub state: TaskState,
    #[serde(default)]
    pub session: Option<String>,
    /// The session's `hivemind/<id8>` branch.
    #[serde(default)]
    pub branch: Option<String>,
    /// The checkpoint commit an editing task left (its branch's commit when it made no edits); dependents start from it.
    #[serde(default)]
    pub checkpoint: Option<String>,
    #[serde(default)]
    pub files: u64,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub verdict: Option<Verdict>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub goal: String,
    pub project: String,
    pub repo: String,
    /// The branch editing tasks without `from` start from; None is the repository's current branch.
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Sessions never ask: each runs with its role's pre-approved profile.
    #[serde(default)]
    pub unattended: bool,
    /// Each session's Claude budget when lower than the settings' one.
    #[serde(default)]
    pub budget_usd: Option<f64>,
    /// What started the run: "user" or `automation:<id>`.
    #[serde(default)]
    pub origin: Option<String>,
    pub state: RunState,
    pub tasks: Vec<Task>,
    pub created_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    /// Why the last save failed, when it did: the file is older than the run, and a restart would lose the difference.
    /// Never on disk, since it is cleared before each save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub save_error: Option<String>,
}

/// What a new run is made from.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NewRun {
    pub goal: String,
    pub project: String,
    pub repo: String,
    #[serde(default)]
    pub base_branch: Option<String>,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub unattended: bool,
    #[serde(default)]
    pub budget_usd: Option<f64>,
    pub tasks: Vec<TaskSpec>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub tasks: Vec<TaskSpec>,
}

fn spec(id: &str, role: Role, title: &str, prompt: &str, depends_on: &[&str], from: Option<&str>) -> TaskSpec {
    TaskSpec {
        id: id.into(), role, engine: Engine::Claude, title: title.into(), prompt: prompt.into(),
        depends_on: depends_on.iter().map(|d| d.to_string()).collect(), from: from.map(str::to_string),
    }
}

/// The built-in templates. `{goal}` in a prompt is replaced by the run's goal.
pub fn templates() -> Vec<Template> {
    vec![
        Template {
            id: "feature", name: "Feature", description: "The architect plans, a developer builds, then a reviewer and a tester check the change in parallel.",
            tasks: vec![
                spec("plan", Role::Architect, "Plan the change", "Plan how to do this: {goal}\nName the files to change, the order of the work and the risks. Do not edit files.", &[], None),
                spec("build", Role::Developer, "Build it", "Do this: {goal}\nFollow the plan in your briefing. Keep the change small and say what you did not do.", &["plan"], None),
                spec("review", Role::Reviewer, "Review the change", "Review the developer's change for this goal: {goal}\nYour worktree holds their checkpoint. Compare it with the plan.", &["build"], Some("build")),
                spec("test", Role::Tester, "Test the change", "Test the developer's change for this goal: {goal}\nYour worktree holds their checkpoint. Run the project's allowed test commands and report what passed and failed.", &["build"], Some("build")),
            ],
        },
        Template {
            id: "review", name: "Review", description: "A reviewer and an architect read the code in parallel and report; nothing is edited.",
            tasks: vec![
                spec("code", Role::Reviewer, "Review the code", "Review this: {goal}\nLook for bugs, missing tests and unclear code.", &[], None),
                spec("design", Role::Architect, "Review the design", "Review the design behind this: {goal}\nLook at structure, boundaries and risks.", &[], None),
            ],
        },
        Template {
            id: "investigate", name: "Investigate a failure", description: "A researcher finds the cause, then a developer fixes it.",
            tasks: vec![
                spec("find", Role::Researcher, "Find the cause", "Find the cause of this problem: {goal}\nRead the code and any logs; do not edit. Say how sure you are.", &[], None),
                spec("fix", Role::Developer, "Fix it", "Fix this problem: {goal}\nThe researcher's findings are in your briefing. Add or update a test when the project has them.", &["find"], None),
            ],
        },
    ]
}

/// Ids are unique and plain, dependencies exist, `from` is a dependency, and there is no cycle.
/// An unattended run refuses, before any task starts, a Codex task that edits files: Codex would stop at its first edit.
pub fn check_unattended(tasks: &[TaskSpec], unattended: bool) -> Result<(), String> {
    match tasks.iter().find(|t| unattended && t.engine == Engine::Codex && t.role.profile() == Profile::EditWorktree) {
        Some(t) => Err(format!("Task {} runs Codex, which cannot edit files without asking in an unattended run. Run the workflow attended or give the task Claude Code.", t.id)),
        None => Ok(()),
    }
}

/// The tasks with each one on an engine the user shows: a task on a hidden engine moves to the other one.
pub fn on_shown(tasks: Vec<TaskSpec>, saved: &crate::settings::Settings) -> Vec<TaskSpec> {
    tasks.into_iter().map(|mut t| {
        if !saved.shows(t.engine) {
            t.engine = if t.engine == Engine::Claude { Engine::Codex } else { Engine::Claude };
        }
        t
    }).collect()
}

pub fn check(tasks: &[TaskSpec]) -> Result<(), String> {
    if tasks.is_empty() {
        return Err("A workflow needs at least one task".into());
    }
    let mut ids = BTreeSet::new();
    for t in tasks {
        if t.id.is_empty() || t.id.len() > 40 || !t.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(format!("\"{}\" is not a task id: use letters, digits, - and _", t.id));
        }
        if !ids.insert(t.id.as_str()) {
            return Err(format!("Two tasks are called {}", t.id));
        }
        if t.title.trim().is_empty() || t.prompt.trim().is_empty() {
            return Err(format!("Task {} needs a title and instructions", t.id));
        }
    }
    for t in tasks {
        if let Some(d) = t.depends_on.iter().find(|d| !ids.contains(d.as_str()) || *d == &t.id) {
            return Err(format!("Task {} depends on {d}, which is not another task here", t.id));
        }
        if let Some(from) = &t.from
            && !t.depends_on.contains(from)
        {
            return Err(format!("Task {} starts from {from}, so it must depend on it", t.id));
        }
    }
    // Kahn: a graph whose tasks cannot all be ordered has a cycle.
    let mut done: BTreeSet<&str> = BTreeSet::new();
    while done.len() < tasks.len() {
        let next: Vec<&str> = tasks.iter().filter(|t| !done.contains(t.id.as_str()) && t.depends_on.iter().all(|d| done.contains(d.as_str()))).map(|t| t.id.as_str()).collect();
        if next.is_empty() {
            return Err("The tasks depend on each other in a circle".into());
        }
        done.extend(next);
    }
    Ok(())
}

impl Run {
    pub fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.spec.id == id)
    }
    fn task_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.spec.id == id)
    }

    /// Waiting tasks whose dependencies all succeeded or were skipped.
    pub fn ready(&self) -> Vec<String> {
        let done = |id: &String| self.task(id).is_some_and(|t| matches!(t.state, TaskState::Succeeded | TaskState::Skipped));
        self.tasks.iter().filter(|t| t.state == TaskState::Waiting && t.spec.depends_on.iter().all(done)).map(|t| t.spec.id.clone()).collect()
    }

    /// Mark every task that depends (directly or not) on `id` as blocked, unless it already ended.
    fn block_after(&mut self, id: &str) {
        let mut stack = vec![id.to_string()];
        while let Some(current) = stack.pop() {
            let dependents: Vec<String> = self.tasks.iter().filter(|t| t.spec.depends_on.contains(&current)).map(|t| t.spec.id.clone()).collect();
            for d in dependents {
                if let Some(t) = self.task_mut(&d)
                    && t.state == TaskState::Waiting
                {
                    t.state = TaskState::Blocked;
                    stack.push(d);
                }
            }
        }
    }

    /// Blocked tasks downstream of `id` wait again (after a retry or skip).
    fn unblock_after(&mut self, id: &str) {
        let mut stack = vec![id.to_string()];
        while let Some(current) = stack.pop() {
            let dependents: Vec<String> = self.tasks.iter().filter(|t| t.spec.depends_on.contains(&current)).map(|t| t.spec.id.clone()).collect();
            for d in dependents {
                if let Some(t) = self.task_mut(&d)
                    && t.state == TaskState::Blocked
                {
                    t.state = TaskState::Waiting;
                    stack.push(d);
                }
            }
        }
    }

    /// A waiting task with a prerequisite that failed, was cancelled or is blocked is blocked again. After a retry or skip
    /// unblocks what lay downstream, a task that also needs another failed task must keep waiting for that one.
    fn reblock(&mut self) {
        loop {
            let stuck: Vec<String> = self.tasks.iter()
                .filter(|t| t.state == TaskState::Waiting)
                .filter(|t| t.spec.depends_on.iter().any(|d| self.task(d).is_some_and(|u| matches!(u.state, TaskState::Failed | TaskState::Cancelled | TaskState::Blocked))))
                .map(|t| t.spec.id.clone())
                .collect();
            if stuck.is_empty() {
                return;
            }
            for id in stuck {
                if let Some(t) = self.task_mut(&id) {
                    t.state = TaskState::Blocked;
                }
            }
        }
    }

    /// The run's state from its tasks' states.
    fn settle(&mut self) {
        if matches!(self.state, RunState::Planned | RunState::Cancelled) {
            return;
        }
        let open = self.tasks.iter().any(|t| matches!(t.state, TaskState::Waiting | TaskState::Running));
        self.state = if open {
            RunState::Running
        } else if self.tasks.iter().any(|t| matches!(t.state, TaskState::Failed | TaskState::Blocked | TaskState::Cancelled)) {
            RunState::Failed
        } else {
            RunState::Succeeded
        };
        if self.state != RunState::Running && self.ended_at.is_none() {
            self.ended_at = Some(now_ms());
        } else if self.state == RunState::Running {
            self.ended_at = None;
        }
    }

    /// What a task's session reads before its instructions: the goal, and what the tasks it depends on found and changed.
    pub fn briefing(&self, task: &Task) -> String {
        let mut out = vec![
            "## Workflow".to_string(),
            format!("You are one task in a Hivemind workflow. Goal: {}", self.goal.trim()),
            format!("Your task ({}): {}", task.spec.role.label(), task.spec.title.trim()),
        ];
        for up in task.spec.depends_on.iter().filter_map(|d| self.task(d)) {
            out.push(format!("\n### Earlier task: {} ({})", up.spec.title, up.spec.role.label()));
            if up.state == TaskState::Skipped {
                out.push("Skipped by the user.".into());
                continue;
            }
            if let Some(branch) = &up.branch {
                let start = if task.spec.from.as_deref() == Some(up.spec.id.as_str()) { " Your worktree starts from its checkpoint." } else { "" };
                out.push(format!("Branch: {branch}. Files changed: {}.{start}", up.files));
            }
            if let Some(v) = up.verdict {
                out.push(format!("Verdict: {}", if v == Verdict::Pass { "pass" } else { "changes needed" }));
            }
            if let Some(summary) = &up.summary {
                out.push(crate::agent::events::clip(summary.trim(), UPSTREAM_SUMMARY));
            }
        }
        out.join("\n")
    }

    /// A Markdown report of the run: each task's result, branch, changes and verdict.
    pub fn report(&self) -> String {
        let run_word = match self.state {
            RunState::Planned => "not started",
            RunState::Running => "running",
            RunState::Succeeded => "succeeded",
            RunState::Failed => "failed",
            RunState::Cancelled => "cancelled",
        };
        let mut out = vec![format!("# {}", self.goal.lines().next().unwrap_or("Workflow").trim()), format!("The workflow {run_word}.")];
        for t in &self.tasks {
            out.push(format!("\n## {} ({}): {}", t.spec.title, t.spec.role.label(), state_word(t.state)));
            if let Some(b) = &t.branch {
                out.push(format!("Branch `{b}`, {} file{} changed{}", t.files, if t.files == 1 { "" } else { "s" },
                    t.checkpoint.as_ref().map(|c| format!(", checkpoint `{}`", &c[..7.min(c.len())])).unwrap_or_default()));
            }
            if let Some(v) = t.verdict {
                out.push(format!("Verdict: {}", if v == Verdict::Pass { "pass" } else { "changes needed" }));
            }
            if let Some(e) = &t.error {
                out.push(format!("Error: {e}"));
            }
            if let Some(s) = &t.summary {
                out.push(s.trim().to_string());
            }
        }
        out.push("\nEditing tasks' changes stay on their branches; approve each in Review. Nothing is merged or pushed.".into());
        out.join("\n")
    }
}

fn state_word(state: TaskState) -> &'static str {
    match state {
        TaskState::Waiting => "waiting",
        TaskState::Running => "running",
        TaskState::Succeeded => "succeeded",
        TaskState::Failed => "failed",
        TaskState::Blocked => "blocked",
        TaskState::Skipped => "skipped",
        TaskState::Cancelled => "cancelled",
    }
}

/// What the executor needs from the rest of the app; tests use a fake.
pub trait Host {
    fn start(&self, task: AgentTask, prompt: &str, options: StartOptions) -> Result<SessionInfo, String>;
    fn info(&self, session: &str) -> Option<SessionInfo>;
    /// Commit the session's edits on its branch; None when there was nothing to commit.
    fn checkpoint(&self, session: &str, message: &str) -> Result<Option<String>, String>;
    fn stop(&self, session: &str);
    /// The commit a branch of the repository points at now.
    fn branch_tip(&self, repo: &str, branch: &str) -> Option<String>;
}

pub struct Workflows {
    dir: PathBuf,
    runs: Mutex<BTreeMap<String, Run>>,
    /// Held while tasks are started or finished, so two reports arriving together never start the same task twice.
    step: Mutex<()>,
}

impl Workflows {
    /// Load saved runs. A run that was running when the app stopped lost its sessions: running tasks fail and the run
    /// settles, so the user can retry them.
    pub fn new(dir: PathBuf) -> Workflows {
        let mut runs = BTreeMap::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            // Only `<id>.json`: a temporary file left by a crash mid-save holds an older copy of a run (Codex review D4-2).
            for entry in entries.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")) {
                let Some(mut run) = std::fs::read_to_string(entry.path()).ok().and_then(|t| serde_json::from_str::<Run>(&t).ok()) else { continue };
                if run.state == RunState::Running {
                    for t in run.tasks.iter_mut().filter(|t| t.state == TaskState::Running) {
                        t.state = TaskState::Failed;
                        t.error = Some("Hivemind stopped while this task was running".into());
                    }
                    let failed: Vec<String> = run.tasks.iter().filter(|t| t.state == TaskState::Failed).map(|t| t.spec.id.clone()).collect();
                    for id in failed {
                        run.block_after(&id);
                    }
                    run.settle();
                }
                runs.insert(run.id.clone(), run);
            }
        }
        Workflows { dir, runs: Mutex::new(runs), step: Mutex::new(()) }
    }

    /// Write the run, whole or not at all. A save that works clears an earlier failure.
    fn save(&self, run: &mut Run) -> Result<(), String> {
        let text = serde_json::to_string_pretty(&Run { save_error: None, ..run.clone() }).map_err(|e| e.to_string())?;
        crate::skills::write_atomic(&self.dir.join(format!("{}.json", run.id)), &text)?;
        run.save_error = None;
        Ok(())
    }

    /// Save a run whose change is already made in memory (a task started or ended), which a failed save cannot undo. The
    /// failure stays on the run for the user to see, and the next save tries again.
    fn keep(&self, run: &mut Run) {
        if let Err(e) = self.save(run) {
            run.save_error = Some(format!("Hivemind could not save this workflow ({e}); a restart would lose its latest progress"));
        }
    }

    /// Newest first.
    pub fn list(&self) -> Vec<Run> {
        let mut out: Vec<Run> = self.runs.lock().unwrap().values().cloned().collect();
        out.sort_by_key(|r| std::cmp::Reverse(r.created_at));
        out
    }

    pub fn get(&self, id: &str) -> Result<Run, String> {
        self.runs.lock().unwrap().get(id).cloned().ok_or_else(|| "Unknown workflow".to_string())
    }

    pub fn create(&self, new: NewRun, origin: Option<String>) -> Result<Run, String> {
        if new.goal.trim().is_empty() {
            return Err("Write the workflow's goal first".into());
        }
        check(&new.tasks)?;
        check_unattended(&new.tasks, new.unattended)?;
        let goal = new.goal.trim().to_string();
        let mut run = Run {
            id: uuid::Uuid::new_v4().simple().to_string(),
            tasks: new.tasks.into_iter().map(|mut spec| {
                spec.prompt = spec.prompt.replace("{goal}", &goal);
                Task { spec, state: TaskState::Waiting, session: None, branch: None, checkpoint: None, files: 0, summary: None, verdict: None, error: None }
            }).collect(),
            goal, project: new.project, repo: new.repo, base_branch: new.base_branch.filter(|b| !b.trim().is_empty()), template: new.template,
            model: new.model.filter(|m| !m.trim().is_empty()), unattended: new.unattended, budget_usd: new.budget_usd, origin, state: RunState::Planned, created_at: now_ms(), ended_at: None,
            save_error: None,
        };
        self.save(&mut run)?;
        self.runs.lock().unwrap().insert(run.id.clone(), run.clone());
        Ok(run)
    }

    /// Replace a planned run's tasks.
    pub fn edit(&self, id: &str, tasks: Vec<TaskSpec>) -> Result<Run, String> {
        check(&tasks)?;
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get_mut(id).ok_or("Unknown workflow")?;
        if run.state != RunState::Planned {
            return Err("Only a workflow that has not started can be edited".into());
        }
        check_unattended(&tasks, run.unattended)?;
        run.tasks = tasks.into_iter().map(|spec| Task { spec, state: TaskState::Waiting, session: None, branch: None, checkpoint: None, files: 0, summary: None, verdict: None, error: None }).collect();
        self.save(run)?;
        Ok(run.clone())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get(id).ok_or("Unknown workflow")?;
        if run.state == RunState::Running {
            return Err("Cancel the workflow before removing it".into());
        }
        runs.remove(id);
        std::fs::remove_file(self.dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
    }

    pub fn start(&self, id: &str, host: &dyn Host) -> Result<Run, String> {
        let _step = self.step.lock().unwrap();
        {
            let mut runs = self.runs.lock().unwrap();
            let run = runs.get_mut(id).ok_or("Unknown workflow")?;
            if run.state != RunState::Planned {
                return Err("This workflow has already started".into());
            }
            run.state = RunState::Running;
            self.save(run)?;
        }
        self.advance(id, host);
        self.get(id)
    }

    /// Start every ready task there is room for. A full session limit leaves tasks waiting for the next report; any
    /// other refusal fails the task and blocks what depends on it.
    fn advance(&self, id: &str, host: &dyn Host) {
        loop {
            let (run, next) = {
                let runs = self.runs.lock().unwrap();
                let Some(run) = runs.get(id) else { return };
                if run.state != RunState::Running {
                    return;
                }
                let Some(next) = run.ready().into_iter().next() else { return };
                (run.clone(), next)
            };
            let task = run.task(&next).unwrap().clone();
            // A task that starts from another starts from that task's checkpoint, and only when its branch still points
            // there: a discard or a later commit would hand it a different revision than the one the run recorded. The
            // worktree starts at the checkpoint itself, so a move after this check does not change it. A skipped task left
            // nothing to start from, so the base branch is used.
            let branch = match task.spec.from.as_deref().and_then(|from| run.task(from)) {
                Some(up) if up.state == TaskState::Succeeded && up.branch.is_some() => {
                    let name = up.branch.clone().unwrap();
                    match &up.checkpoint {
                        Some(checkpoint) if host.branch_tip(&run.repo, &name).as_deref() != Some(checkpoint.as_str()) => Err(format!(
                            "{name} no longer points at the checkpoint {} of \"{}\"; retry that task or skip this one",
                            &checkpoint[..7.min(checkpoint.len())], up.spec.title
                        )),
                        checkpoint => Ok((Some(name), checkpoint.clone())),
                    }
                }
                _ => Ok((run.base_branch.clone(), None)),
            };
            let options = StartOptions {
                briefing: Some(run.briefing(&task)),
                model: run.model.clone().filter(|_| task.spec.engine == Engine::Claude),
                engine: task.spec.engine,
                interface: Interface::Chat,
                role: Some(task.spec.role),
                unattended: run.unattended,
                origin: Some(format!("workflow:{}:{}", run.id, task.spec.id)),
                budget_usd: run.budget_usd,
                ..Default::default()
            };
            let started = branch.and_then(|(branch, start)| {
                let work = AgentTask::Work { project: run.project.clone(), repo: run.repo.clone(), branch, change: None };
                host.start(work, &task.spec.prompt, StartOptions { start, ..options })
            });
            let mut runs = self.runs.lock().unwrap();
            let Some(run) = runs.get_mut(id) else { return };
            match started {
                Ok(info) => {
                    let t = run.task_mut(&next).unwrap();
                    t.state = TaskState::Running;
                    t.branch = info.worktree.as_ref().map(|w| w.branch.clone());
                    t.session = Some(info.id);
                    t.error = None;
                }
                Err(e) if e == crate::agent::LIMIT => {
                    self.keep(run);
                    return;
                }
                Err(e) => {
                    let t = run.task_mut(&next).unwrap();
                    t.state = TaskState::Failed;
                    t.error = Some(e);
                    run.block_after(&next);
                }
            }
            run.settle();
            self.keep(run);
        }
    }

    /// The run and task a session belongs to.
    fn owner(&self, session: &str) -> Option<(String, String)> {
        self.runs.lock().unwrap().values().find_map(|r| {
            r.tasks.iter().find(|t| t.session.as_deref() == Some(session)).map(|t| (r.id.clone(), t.spec.id.clone()))
        })
    }

    /// A session report: a task's first finished turn ends the task. Any report may free a slot, so every running
    /// workflow tries to advance.
    pub fn on_report(&self, report: &Lifecycle, host: &dyn Host) {
        let _step = self.step.lock().unwrap();
        if let Some((run_id, task_id)) = self.owner(report.id()) {
            let ended = match report {
                Lifecycle::TurnEnded { ok, .. } => Some(*ok),
                Lifecycle::Finished { .. } => Some(false),
                _ => None,
            };
            if let Some(ok) = ended {
                self.finish(&run_id, &task_id, ok, host);
            }
        }
        if matches!(report, Lifecycle::TurnEnded { .. } | Lifecycle::Finished { .. }) {
            let running: Vec<String> = self.runs.lock().unwrap().values().filter(|r| r.state == RunState::Running).map(|r| r.id.clone()).collect();
            for id in running {
                self.advance(&id, host);
            }
        }
    }

    fn finish(&self, run_id: &str, task_id: &str, ok: bool, host: &dyn Host) {
        let (session, role, title, repo, branch) = {
            let runs = self.runs.lock().unwrap();
            let Some(run) = runs.get(run_id) else { return };
            let Some(t) = run.task(task_id) else { return };
            if t.state != TaskState::Running {
                return;
            }
            (t.session.clone().unwrap_or_default(), t.spec.role, t.spec.title.clone(), run.repo.clone(), t.branch.clone())
        };
        let info = host.info(&session);
        // An editing task's edits become a commit its dependents can branch from. A task with no edits leaves its branch
        // where it started, and that commit is its checkpoint, so its dependents start there too (Codex review F7-1).
        let checkpoint = if ok && role.profile() == Profile::EditWorktree {
            match host.checkpoint(&session, &format!("Workflow checkpoint: {title}")) {
                Ok(None) => {
                    let tip = branch.as_deref().and_then(|b| host.branch_tip(&repo, b));
                    tip.map(Some).ok_or_else(|| format!("Could not read the branch {}", branch.as_deref().unwrap_or("of the session")))
                }
                made => made,
            }
        } else {
            Ok(None)
        };
        let mut runs = self.runs.lock().unwrap();
        let Some(run) = runs.get_mut(run_id) else { return };
        let t = run.task_mut(task_id).unwrap();
        if let Some(info) = &info {
            t.summary = info.summary.clone();
            t.verdict = info.verdict;
            t.files = info.files_changed.map(|f| f.files).unwrap_or(0);
        }
        match (ok, checkpoint) {
            (true, Ok(commit)) => {
                t.state = TaskState::Succeeded;
                t.checkpoint = commit;
            }
            (true, Err(e)) => {
                t.state = TaskState::Failed;
                t.error = Some(format!("The checkpoint commit failed: {e}"));
            }
            (false, _) => {
                t.state = TaskState::Failed;
                t.error = Some(info.and_then(|i| i.error).unwrap_or_else(|| "The session stopped before it finished its turn".into()));
            }
        }
        if t.state == TaskState::Failed {
            run.block_after(task_id);
        }
        run.settle();
        self.keep(run);
    }

    /// Stop the run: running sessions are stopped, open tasks are cancelled.
    pub fn cancel(&self, id: &str, host: &dyn Host) -> Result<Run, String> {
        let _step = self.step.lock().unwrap();
        let sessions: Vec<String> = {
            let mut runs = self.runs.lock().unwrap();
            let run = runs.get_mut(id).ok_or("Unknown workflow")?;
            if !matches!(run.state, RunState::Running | RunState::Planned) {
                return Err("This workflow has ended".into());
            }
            let sessions = run.tasks.iter().filter(|t| t.state == TaskState::Running).filter_map(|t| t.session.clone()).collect();
            for t in run.tasks.iter_mut().filter(|t| matches!(t.state, TaskState::Waiting | TaskState::Running | TaskState::Blocked)) {
                t.state = TaskState::Cancelled;
            }
            run.state = RunState::Cancelled;
            run.ended_at = Some(now_ms());
            self.save(run)?;
            sessions
        };
        for s in sessions {
            host.stop(&s);
        }
        self.get(id)
    }

    /// Run a failed task again (in a new session), or skip it; either lets the tasks it blocked wait again.
    pub fn retry_or_skip(&self, id: &str, task: &str, skip: bool, host: &dyn Host) -> Result<Run, String> {
        let _step = self.step.lock().unwrap();
        {
            let mut runs = self.runs.lock().unwrap();
            let run = runs.get_mut(id).ok_or("Unknown workflow")?;
            if matches!(run.state, RunState::Planned | RunState::Cancelled) {
                return Err("Start the workflow first".into());
            }
            let t = run.task_mut(task).ok_or("Unknown task")?;
            if !matches!(t.state, TaskState::Failed | TaskState::Blocked) && !(skip && t.state == TaskState::Waiting) {
                return Err("Only a failed or blocked task can be retried or skipped".into());
            }
            t.state = if skip { TaskState::Skipped } else { TaskState::Waiting };
            t.error = None;
            run.unblock_after(task);
            run.reblock();
            run.state = RunState::Running;
            run.settle();
            self.save(run)?;
        }
        self.advance(id, host);
        self.get(id)
    }
}

#[cfg(test)]
mod hidden_engine_tests {
    use super::*;
    use crate::settings::Settings;

    #[test]
    fn tasks_move_off_a_hidden_engine() {
        let feature = templates().into_iter().find(|t| t.id == "feature").unwrap().tasks;
        let codex_only = Settings { hidden_engines: Some(vec!["claude".into()]), ..Default::default() };
        assert!(on_shown(feature.clone(), &codex_only).iter().all(|t| t.engine == Engine::Codex));
        assert_eq!(on_shown(feature.clone(), &Settings::default()), feature);
    }

    #[test]
    fn unattended_runs_refuse_codex_editing_tasks_up_front() {
        let mut tasks = vec![spec("plan", Role::Architect, "Plan", "p", &[], None), spec("build", Role::Developer, "Build", "b", &["plan"], None)];
        assert!(check_unattended(&tasks, true).is_ok());
        tasks[1].engine = Engine::Codex;
        assert!(check_unattended(&tasks, true).unwrap_err().contains("build"));
        assert!(check_unattended(&tasks, false).is_ok());
        tasks[1].engine = Engine::Claude;
        tasks[0].engine = Engine::Codex;
        assert!(check_unattended(&tasks, true).is_ok());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worktree::{Totals, Worktree};
    use std::cell::RefCell;

    struct Fake {
        started: RefCell<Vec<(String, Option<String>, StartOptions)>>,
        limit: usize,
        fail: Option<&'static str>,
        infos: RefCell<BTreeMap<String, SessionInfo>>,
        stopped: RefCell<Vec<String>>,
        /// Branches moved since their checkpoint.
        moved: RefCell<Vec<String>>,
        /// Editing sessions made no edits, so there is nothing to commit.
        no_edits: bool,
    }
    fn fake(limit: usize) -> Fake {
        Fake { started: RefCell::new(vec![]), limit, fail: None, infos: RefCell::new(BTreeMap::new()), stopped: RefCell::new(vec![]), moved: RefCell::new(vec![]), no_edits: false }
    }

    fn info(id: &str) -> SessionInfo {
        serde_json::from_value(serde_json::json!({
            "id": id, "adapter": "claude-code", "cliVersion": null, "task": {"kind": "work", "project": "p", "repo": "r"}, "title": "t", "workspace": [],
            "status": "running", "startedAt": 0, "endedAt": null, "costUsd": null, "error": null, "structured": null, "mode": "interactive", "policy": "ask",
            "project": "p", "worktree": null, "turns": 0, "filesChanged": null, "context": [], "model": null
        })).unwrap()
    }

    impl Host for Fake {
        fn start(&self, task: AgentTask, prompt: &str, options: StartOptions) -> Result<SessionInfo, String> {
            let running = self.started.borrow().len() - self.stopped.borrow().len()
                - self.infos.borrow().values().filter(|i| i.summary.is_some()).count();
            if running >= self.limit {
                return Err(crate::agent::LIMIT.into());
            }
            if let Some(e) = self.fail.filter(|_| prompt.contains("FAIL")) {
                return Err(e.into());
            }
            let AgentTask::Work { branch, .. } = task else { panic!() };
            let id = format!("s{}", self.started.borrow().len());
            let mut i = info(&id);
            i.worktree = Some(Worktree { repo: "r".into(), path: "w".into(), branch: format!("hivemind/{id}"), base_branch: "main".into(), base_sha: "0".into(), reviewed_sha: None });
            self.infos.borrow_mut().insert(id.clone(), i.clone());
            self.started.borrow_mut().push((prompt.to_string(), branch, options));
            Ok(i)
        }
        fn info(&self, session: &str) -> Option<SessionInfo> {
            self.infos.borrow().get(session).cloned()
        }
        fn checkpoint(&self, session: &str, _message: &str) -> Result<Option<String>, String> {
            Ok((!self.no_edits).then(|| format!("{session}-commit")))
        }
        fn stop(&self, session: &str) {
            self.stopped.borrow_mut().push(session.to_string());
        }
        fn branch_tip(&self, _repo: &str, branch: &str) -> Option<String> {
            let session = branch.strip_prefix("hivemind/")?;
            Some(if self.moved.borrow().iter().any(|b| b == branch) { "elsewhere".into() } else { format!("{session}-commit") })
        }
    }

    #[test]
    fn skipping_one_failed_prerequisite_keeps_a_task_that_needs_another_blocked() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let host = Fake { fail: Some("no"), ..fake(3) };
        let tasks = vec![
            spec("a", Role::Researcher, "A", "FAIL a", &[], None),
            spec("b", Role::Researcher, "B", "FAIL b", &[], None),
            spec("c", Role::Developer, "C", "do c", &["a", "b"], None),
        ];
        let run = flows.create(NewRun { goal: "g".into(), project: "p".into(), repo: "r".into(), tasks, ..Default::default() }, None).unwrap();
        let run = flows.start(&run.id, &host).unwrap();
        assert_eq!((states(&run), run.state), (vec![TaskState::Failed, TaskState::Failed, TaskState::Blocked], RunState::Failed));
        let run = flows.retry_or_skip(&run.id, "a", true, &host).unwrap();
        assert_eq!(states(&run)[2], TaskState::Blocked, "b still failed");
        assert_eq!(run.state, RunState::Failed, "not running with nothing able to start");
        let run = flows.retry_or_skip(&run.id, "b", true, &host).unwrap();
        assert_eq!((states(&run)[2], run.state), (TaskState::Running, RunState::Running));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_task_never_starts_from_a_branch_that_moved_since_its_checkpoint() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let host = fake(3);
        let run = flows.start(&feature(&flows).id, &host).unwrap();
        turn(&flows, &host, "s0", true, None);
        host.moved.borrow_mut().push("hivemind/s1".into());
        turn(&flows, &host, "s1", true, None);
        let run = flows.get(&run.id).unwrap();
        assert_eq!(states(&run)[2..], [TaskState::Failed, TaskState::Failed]);
        assert!(run.tasks[2].error.as_deref().unwrap().contains("no longer points at the checkpoint s1-comm"), "{:?}", run.tasks[2].error);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failed_save_is_shown_on_the_run_and_cleared_by_the_next() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let host = fake(3);
        let run = flows.start(&feature(&flows).id, &host).unwrap();
        // A folder where the run's file goes: the rename over it fails.
        let file = dir.join(format!("{}.json", run.id));
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        turn(&flows, &host, "s0", true, None);
        let failed = flows.get(&run.id).unwrap();
        assert_eq!(states(&failed)[..2], [TaskState::Succeeded, TaskState::Running], "the run goes on in memory");
        assert!(failed.save_error.as_deref().unwrap().starts_with("Hivemind could not save this workflow"), "{:?}", failed.save_error);
        assert!(serde_json::to_value(&failed).unwrap()["saveError"].is_string(), "the webview sees it");
        // No temporary file is left behind.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);

        std::fs::remove_dir(&file).unwrap();
        turn(&flows, &host, "s1", true, None);
        let saved = flows.get(&run.id).unwrap();
        assert_eq!(saved.save_error, None);
        let on_disk: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert!(on_disk.get("saveError").is_none());
        // The progress missed by the failed save is on disk now: a restart keeps both finished tasks.
        assert_eq!(states(&Workflows::new(dir.clone()).get(&run.id).unwrap())[..2], [TaskState::Succeeded, TaskState::Succeeded]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_temporary_file_left_by_a_crash_is_not_loaded() {   // Codex review D4-2
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let run = feature(&flows);
        // What write_atomic leaves when the app stops between writing and renaming: an older copy of the run.
        let older = Run { goal: "An older goal".into(), ..run.clone() };
        std::fs::write(dir.join(format!("{}.tmp-0123", run.id)), serde_json::to_string(&older).unwrap()).unwrap();
        let loaded = Workflows::new(dir.clone());
        assert_eq!(loaded.get(&run.id).unwrap().goal, "Add retries");
        assert_eq!(loaded.list().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The session ends its turn with a summary (and the given verdict).
    fn turn(flows: &Workflows, host: &Fake, session: &str, ok: bool, verdict: Option<Verdict>) {
        if let Some(i) = host.infos.borrow_mut().get_mut(session) {
            i.summary = Some(format!("summary of {session}"));
            i.verdict = verdict;
            i.files_changed = Some(Totals { files: 2, added: 3, removed: 1 });
        }
        flows.on_report(&Lifecycle::TurnEnded { id: session.into(), ok, stopped: false }, host);
    }

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("hivemind-workflows-{}", uuid::Uuid::new_v4().simple()))
    }

    fn feature(flows: &Workflows) -> Run {
        let t = templates().into_iter().find(|t| t.id == "feature").unwrap();
        flows.create(NewRun { goal: "Add retries".into(), project: "p".into(), repo: "r".into(), base_branch: Some("main".into()), tasks: t.tasks, unattended: true, ..Default::default() }, None).unwrap()
    }

    fn states(run: &Run) -> Vec<TaskState> {
        run.tasks.iter().map(|t| t.state).collect()
    }

    #[test]
    fn graphs_are_checked() {
        for t in templates() {
            assert!(check(&t.tasks).is_ok(), "{}", t.id);
        }
        let a = spec("a", Role::Developer, "A", "do", &["b"], None);
        let b = spec("b", Role::Developer, "B", "do", &["a"], None);
        assert!(check(&[a.clone(), b]).unwrap_err().contains("circle"));
        assert!(check(&[spec("a", Role::Developer, "A", "do", &["zz"], None)]).unwrap_err().contains("zz"));
        assert!(check(&[spec("a", Role::Developer, "A", "do", &[], None), spec("a", Role::Developer, "A", "do", &[], None)]).unwrap_err().contains("Two"));
        assert!(check(&[spec("a", Role::Developer, "A", "do", &[], None), spec("b", Role::Tester, "B", "do", &[], Some("a"))]).unwrap_err().contains("must depend"));
        assert!(check(&[spec("a b", Role::Developer, "A", "do", &[], None)]).is_err());
        assert!(check(&[]).is_err());
    }

    #[test]
    fn a_task_without_edits_pins_its_dependents_to_its_branch_commit() {   // Codex review F7-1
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let host = Fake { no_edits: true, ..fake(3) };
        let run = flows.start(&feature(&flows).id, &host).unwrap();
        turn(&flows, &host, "s0", true, None);
        turn(&flows, &host, "s1", true, None);
        let run = flows.get(&run.id).unwrap();
        assert_eq!(run.tasks[1].checkpoint.as_deref(), Some("s1-commit"), "the branch's commit, read when the task ended");
        for (_, branch, options) in &host.started.borrow()[2..] {
            assert_eq!((branch.as_deref(), options.start.as_deref()), (Some("hivemind/s1"), Some("s1-commit")));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_feature_runs_in_order_with_checkpoints_and_parallel_checks() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let host = fake(3);
        let run = feature(&flows);
        assert!(run.tasks[1].spec.prompt.starts_with("Do this: Add retries"), "the goal fills the prompt");
        let run = flows.start(&run.id, &host).unwrap();
        assert_eq!(states(&run), [TaskState::Running, TaskState::Waiting, TaskState::Waiting, TaskState::Waiting]);
        let (_, branch, options) = host.started.borrow()[0].clone();
        assert_eq!((branch.as_deref(), options.role, options.unattended), (Some("main"), Some(Role::Architect), true));
        assert_eq!(options.origin.as_deref(), Some(format!("workflow:{}:plan", run.id).as_str()));

        turn(&flows, &host, "s0", true, None);
        let run = flows.get(&run.id).unwrap();
        assert_eq!(run.tasks[0].checkpoint, None, "a read-only task makes no checkpoint");
        assert_eq!(states(&run)[1], TaskState::Running);
        let (_, branch, options) = host.started.borrow()[1].clone();
        assert_eq!((branch.as_deref(), options.start.as_deref()), (Some("main"), None), "build starts from the base");
        assert!(options.briefing.unwrap().contains("summary of s0"), "the plan is in the developer's briefing");

        turn(&flows, &host, "s1", true, None);
        let run = flows.get(&run.id).unwrap();
        assert_eq!(run.tasks[1].checkpoint.as_deref(), Some("s1-commit"));
        assert_eq!(states(&run)[2..], [TaskState::Running, TaskState::Running], "review and test run in parallel");
        let started = host.started.borrow();
        for (_, branch, options) in &started[2..] {
            assert_eq!(branch.as_deref(), Some("hivemind/s1"), "both start from the developer's checkpoint");
            assert_eq!(options.start.as_deref(), Some("s1-commit"), "at the verified commit, not wherever the branch is by then");
            assert!(options.briefing.as_ref().unwrap().contains("Your worktree starts from its checkpoint."));
        }
        drop(started);

        turn(&flows, &host, "s2", true, Some(Verdict::ChangesNeeded));
        turn(&flows, &host, "s3", true, Some(Verdict::Pass));
        let run = flows.get(&run.id).unwrap();
        assert_eq!(run.state, RunState::Succeeded);
        assert!(run.ended_at.is_some());
        let report = run.report();
        assert!(report.contains("## Review the change (Reviewer): succeeded") && report.contains("Verdict: changes needed") && report.contains("checkpoint `s1-comm`"), "{report}");
        // Runs survive a restart.
        assert_eq!(Workflows::new(dir.clone()).get(&run.id).unwrap(), run);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failure_blocks_dependents_until_retried_or_skipped() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let host = fake(3);
        let run = flows.start(&feature(&flows).id, &host).unwrap();
        turn(&flows, &host, "s0", false, None);
        let run = flows.get(&run.id).unwrap();
        assert_eq!(states(&run), [TaskState::Failed, TaskState::Blocked, TaskState::Blocked, TaskState::Blocked]);
        assert_eq!(run.state, RunState::Failed);
        let run = flows.retry_or_skip(&run.id, "plan", false, &host).unwrap();
        assert_eq!((states(&run)[0], states(&run)[1], run.state), (TaskState::Running, TaskState::Waiting, RunState::Running));
        assert_eq!(run.tasks[0].session.as_deref(), Some("s1"), "a retry is a new session");
        turn(&flows, &host, "s1", false, None);
        let run = flows.retry_or_skip(&run.id, "plan", true, &host).unwrap();
        assert_eq!(states(&run)[..2], [TaskState::Skipped, TaskState::Running]);
        assert!(flows.retry_or_skip(&run.id, "build", true, &host).is_err(), "a running task cannot be skipped");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_session_limit_holds_tasks_until_a_slot_frees() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let host = fake(1);
        let review = templates().into_iter().find(|t| t.id == "review").unwrap();
        let run = flows.create(NewRun { goal: "g".into(), project: "p".into(), repo: "r".into(), tasks: review.tasks, ..Default::default() }, None).unwrap();
        let run = flows.start(&run.id, &host).unwrap();
        assert_eq!(states(&run), [TaskState::Running, TaskState::Waiting]);
        turn(&flows, &host, "s0", true, Some(Verdict::Pass));
        let run = flows.get(&run.id).unwrap();
        assert_eq!(states(&run), [TaskState::Succeeded, TaskState::Running]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_refused_start_fails_the_task_and_cancel_stops_sessions() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let mut host = fake(3);
        host.fail = Some("Codex cannot edit files without asking");
        let tasks = vec![spec("a", Role::Developer, "A", "FAIL", &[], None), spec("b", Role::Reviewer, "B", "look", &[], None), spec("c", Role::Tester, "C", "t", &["a"], Some("a"))];
        let run = flows.create(NewRun { goal: "g".into(), project: "p".into(), repo: "r".into(), tasks, ..Default::default() }, None).unwrap();
        let run = flows.start(&run.id, &host).unwrap();
        assert_eq!(states(&run), [TaskState::Failed, TaskState::Running, TaskState::Blocked]);
        assert!(run.tasks[0].error.as_deref().unwrap().contains("Codex"));
        let run = flows.cancel(&run.id, &host).unwrap();
        assert_eq!((run.state, states(&run)[1]), (RunState::Cancelled, TaskState::Cancelled));
        assert_eq!(*host.stopped.borrow(), ["s0"]);
        assert!(flows.delete(&run.id).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_interrupted_by_a_restart_fails_its_running_tasks() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let host = fake(3);
        let run = flows.start(&feature(&flows).id, &host).unwrap();
        let reloaded = Workflows::new(dir.clone()).get(&run.id).unwrap();
        assert_eq!((reloaded.state, states(&reloaded)[0], states(&reloaded)[1]), (RunState::Failed, TaskState::Failed, TaskState::Blocked));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_planned_runs_are_edited() {
        let dir = scratch();
        let flows = Workflows::new(dir.clone());
        let run = feature(&flows);
        let edited = flows.edit(&run.id, vec![spec("only", Role::Researcher, "Look", "look", &[], None)]).unwrap();
        assert_eq!(edited.tasks.len(), 1);
        flows.start(&run.id, &fake(3)).unwrap();
        assert!(flows.edit(&run.id, vec![spec("x", Role::Researcher, "X", "x", &[], None)]).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
