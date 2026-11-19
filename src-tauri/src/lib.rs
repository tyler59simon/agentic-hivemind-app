mod agent;
mod automations;
mod architecture;
mod archsuite;
mod bridge;
mod capture;
mod conductor;
mod drafts;
mod executive;
mod folders;
mod git;
mod learning;
mod oneshot;
mod notify;
mod resources;
mod review;
mod settings;
mod skills;
mod term;
mod watcher;
mod wiki_build;
mod workflow;
mod worktree;

use bridge::{Bridge, Reply};
use serde::Serialize;
use serde_json::Value;
use settings::Settings;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    bridge: Arc<Bridge>,
    settings_path: PathBuf,
    drafts_dir: PathBuf,
    worktrees_dir: PathBuf,
    terminals_dir: PathBuf,
    snapshots_dir: PathBuf,
    agents: agent::Manager,
    terminals: term::Manager,
    learning: learning::Learning,
    skills: skills::Skills,
    workflows: Arc<workflow::Workflows>,
    automations: Arc<automations::Automations>,
    executive: executive::Store,
    /// Executive conversations being captured now.
    capturing: executive::Claims,
    watcher: Mutex<Option<notify_debouncer_mini::Debouncer<notify_debouncer_mini::notify::RecommendedWatcher>>>,
    /// Why the quick-capture hotkey could not be registered, for the settings screen.
    shortcut_error: Mutex<Option<String>>,
}

#[derive(Serialize)]
struct CaptureStatus {
    shortcut: Option<String>,
    error: Option<String>,
    close_to_tray: bool,
}

#[derive(Serialize)]
struct ConnectInfo {
    version: Value,
    root: String,
    program: String,
    script: String,
    /// The signed-in OS user, for the sidebar footer.
    user: Option<String>,
}

/// The `term-attention` event; `kind` is null when the attention was cleared.
#[derive(Serialize, Clone)]
struct TermAttention {
    id: String,
    kind: Option<term::signal::Kind>,
}

#[derive(Serialize, Clone)]
struct NotesChanged {
    domains: Vec<String>,
}

#[derive(Serialize, Clone)]
struct StoreChanged {
    files: Vec<String>,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

/// Run one Living Memory command (argv starts with the command) and return its reply.
#[tauri::command]
async fn lm(state: State<'_, AppState>, argv: Vec<String>, stdin: Option<String>) -> Result<Reply, String> {
    let bridge = state.bridge.clone();
    blocking(move || bridge.call(&argv, stdin.as_deref())).await
}

/// Start (or restart) the bridge, report what it connected to, and watch the store for changes.
#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>) -> Result<ConnectInfo, String> {
    let bridge = state.bridge.clone();
    let (version, doctor) = blocking(move || {
        let version = bridge.call(&["version".into()], None)?;
        let doctor = bridge.call(&["doctor".into(), "--actor".into(), "viewer".into()], None)?;
        Ok((version, doctor))
    })
    .await?;
    let root = doctor.result.get("root").and_then(Value::as_str).ok_or("Living Memory did not report its store root")?.to_string();
    let (notes, store) = (app.clone(), app.clone());
    let debouncer = watcher::watch_all(
        &PathBuf::from(&root),
        move |domains| {
            let _ = notes.emit("notes-changed", NotesChanged { domains });
        },
        move |files| {
            let _ = store.emit("store-changed", StoreChanged { files });
        },
    )?;
    *state.watcher.lock().unwrap() = Some(debouncer);
    let launch = state.bridge.launch();
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).ok().filter(|name| !name.is_empty());
    Ok(ConnectInfo { version: version.result, root, program: launch.program, script: launch.script.display().to_string(), user })
}

/// Recent commits and pull requests for a project's repos (paths are looked up in Living Memory).
#[tauri::command]
async fn git_activity(state: State<'_, AppState>, slug: String) -> Result<Vec<git::RepoActivity>, String> {
    let bridge = state.bridge.clone();
    blocking(move || git::git_activity(&bridge, &slug)).await
}

/// What a system's Architecture Suite output folder holds (the folder is looked up in Living Memory).
#[tauri::command]
async fn system_architecture(state: State<'_, AppState>, slug: String) -> Result<architecture::Architecture, String> {
    let bridge = state.bridge.clone();
    blocking(move || architecture::for_system(&bridge, &slug)).await
}

/// One diagram from that folder as a data URL; only files the suite's manifest lists are served.
#[tauri::command]
async fn system_diagram(state: State<'_, AppState>, slug: String, path: String) -> Result<String, String> {
    let bridge = state.bridge.clone();
    blocking(move || architecture::diagram_for_system(&bridge, &slug, &path)).await
}

/// The Mermaid source of a diagram in that folder, as text; only `.mmd` files the manifest lists are served.
#[tauri::command]
async fn system_diagram_source(state: State<'_, AppState>, slug: String, path: String) -> Result<String, String> {
    let bridge = state.bridge.clone();
    blocking(move || architecture::source_for_system(&bridge, &slug, &path)).await
}

/// How many commits a system's repository is ahead of its architecture output.
#[tauri::command]
async fn system_staleness(state: State<'_, AppState>, slug: String) -> Result<architecture::Staleness, String> {
    let (bridge, agents) = (state.bridge.clone(), state.agents.clone());
    blocking(move || architecture::staleness(&bridge, &agents.sessions(), &slug)).await
}

/// The stored copies of a system's architecture model, newest first.
#[tauri::command]
async fn system_snapshots(state: State<'_, AppState>, slug: String) -> Result<Vec<architecture::SnapshotInfo>, String> {
    let root = state.snapshots_dir.clone();
    blocking(move || architecture::list_snapshots(&root, &slug)).await
}

/// One stored copy of a system's architecture model; the id must be one the listing gave.
#[tauri::command]
async fn system_snapshot(state: State<'_, AppState>, slug: String, id: String) -> Result<architecture::Snapshot, String> {
    let root = state.snapshots_dir.clone();
    blocking(move || architecture::read_snapshot(&root, &slug, &id)).await
}

/// The coding-agent CLI a session would launch, or why there is none.
#[tauri::command]
async fn agent_available(state: State<'_, AppState>) -> Result<String, String> {
    let path = state.settings_path.clone();
    blocking(move || agent::claude::available(&settings::load(&path))).await
}

/// What the Start screen needs to know about one engine.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    engine: agent::Engine,
    label: String,
    path: Option<String>,
    error: Option<String>,
    chat: bool,
    chat_reason: Option<String>,
}

/// Turn the result of looking for an engine's program into what the webview shows.
fn engine_info(engine: agent::Engine, found: Result<term::launch::Cli, String>) -> EngineInfo {
    let (path, error) = match found {
        Ok(cli) => (Some(cli.args.into_iter().next().unwrap_or(cli.program)), None),
        Err(e) => (None, Some(e)),
    };
    EngineInfo {
        engine,
        label: engine.label().to_string(),
        path,
        error,
        chat: true,
        chat_reason: None,
    }
}

/// Which engines can be started, and with which interface: Claude Code first, then Codex.
#[tauri::command]
async fn agent_engines(state: State<'_, AppState>) -> Result<Vec<EngineInfo>, String> {
    let path = state.settings_path.clone();
    blocking(move || {
        let saved = settings::load(&path);
        Ok([agent::Engine::Claude, agent::Engine::Codex].into_iter().map(|e| engine_info(e, term::launch::program(e, &saved))).collect())
    })
    .await
}

/// The models and reasoning efforts an engine offers, and the defaults its own configuration names.
#[tauri::command]
async fn agent_models(state: State<'_, AppState>, engine: agent::Engine) -> Result<agent::models::AgentModels, String> {
    let path = state.settings_path.clone();
    blocking(move || Ok(agent::models::list(engine, &settings::load(&path)))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LearningStatus {
    enabled: bool,
    daily_usd: f64,
    spent_today: f64,
    review_usd: f64,
    auto_patch: bool,
    runs: Vec<learning::Run>,
}

/// The post-session reviewer's settings, today's spending and its latest runs.
#[tauri::command]
fn learning_status(state: State<'_, AppState>) -> LearningStatus {
    let saved = settings::load(&state.settings_path);
    let mut runs = state.learning.runs();
    runs.truncate(50);
    LearningStatus {
        enabled: saved.learning_reviewer() && saved.shows(agent::Engine::Claude),
        daily_usd: saved.learning_daily_usd(),
        spent_today: state.learning.spent_today(),
        review_usd: learning::REVIEW_USD,
        auto_patch: saved.skills_auto_patch(),
        runs,
    }
}

/// Review a session for knowledge and skills now, in the background; `learning-changed` fires when it is done.
#[tauri::command]
fn learning_review(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let log = state.agents.session(&id, 0)?;
    if learning::wanted(&log.info, learning::Trigger::Manual, 0).is_none() {
        return Err("Only chat sessions on a project can be reviewed: a terminal keeps no log Hivemind can read.".into());
    }
    std::thread::spawn(move || run_review(&app, &id, learning::Trigger::Manual));
    Ok(())
}

/// One review on this thread. Reads the session's log, then calls the reviewer within the daily cap.
fn run_review(app: &AppHandle, id: &str, trigger: learning::Trigger) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let saved = settings::load(&state.settings_path);
    // The reviewer runs on Claude Code; a user who hid Claude Code has no way to see or turn it off.
    if trigger != learning::Trigger::Manual && (!saved.learning_reviewer() || !saved.shows(agent::Engine::Claude)) {
        return;
    }
    let Ok(log) = state.agents.session(id, 0) else { return };
    let claude = match agent::claude::available(&saved) {
        Ok(path) => path,
        Err(e) => {
            if trigger == learning::Trigger::Manual {
                notify::session(app, id, "Session review", &e);
            }
            return;
        }
    };
    let deps = learning::Deps { bridge: &state.bridge, skills: &state.skills, claude, daily_usd: saved.learning_daily_usd(), auto_patch: saved.skills_auto_patch() };
    if let Some(run) = state.learning.review(&deps, &log.info, &log.events, trigger) {
        let _ = app.emit("learning-changed", &run);
        let staged = run.memory.len() + usize::from(run.skill.is_some());
        if staged > 0 {
            notify::session(app, id, &run.title, &format!("Hivemind learned {staged} thing{} from this session; see Review", if staged == 1 { "" } else { "s" }));
        } else if run.state == "failed" && trigger == learning::Trigger::Manual {
            notify::session(app, id, &run.title, run.error.as_deref().unwrap_or("The review failed"));
        }
    }
}

/// Reviews and skill bookkeeping driven by session reports: which skills a turn used, how the work was judged, and a review
/// when the user decides or a long session ends. Reviews run on their own thread so the conductor never waits.
fn learning_reports(app: AppHandle) -> conductor::Handler {
    Box::new(move |report| {
        let Some(state) = app.try_state::<AppState>() else { return };
        let id = report.id().to_string();
        let (trigger, outcome) = match report {
            agent::Lifecycle::TurnEnded { .. } => {
                if let Ok(log) = state.agents.session(&id, 0) {
                    let used = skills::used_in(&log.events, &state.skills.names());
                    if !used.is_empty() {
                        let _ = state.skills.record_uses(&id, &log.info.adapter, &used);
                    }
                }
                (None, None)
            }
            agent::Lifecycle::Reviewed { state: review, .. } => learning::on_review_state(*review),
            agent::Lifecycle::Finished { status, .. } => learning::on_finished(*status),
            agent::Lifecycle::Waiting { .. } => (None, None),
        };
        if let Some(outcome) = outcome {
            let _ = state.skills.record_outcome(&id, outcome);
        }
        if let Some(trigger) = trigger {
            let app = app.clone();
            std::thread::spawn(move || run_review(&app, &id, trigger));
        }
    })
}

#[tauri::command]
fn skills_list(state: State<'_, AppState>) -> Vec<skills::SkillView> {
    state.skills.list(agent::now_ms())
}

#[tauri::command]
fn skill_proposals(state: State<'_, AppState>, all: Option<bool>) -> Vec<skills::Proposal> {
    state.skills.proposals(if all == Some(true) { None } else { Some(skills::ProposalState::Pending) })
}

/// Approve (with the user's edits, when given) or reject a skill proposal.
#[tauri::command]
fn skill_decide(
    state: State<'_, AppState>, id: String, approve: bool, description: Option<String>, body: Option<String>, reason: Option<String>,
) -> Result<skills::Proposal, String> {
    let edit = match (description, body) {
        (Some(d), Some(b)) => Some((d, b)),
        (None, None) => None,
        _ => return Err("An edit needs both the description and the text".into()),
    };
    state.skills.decide(&id, approve, edit, "user", reason.filter(|r| !r.trim().is_empty()))
}

/// What the user can do to an approved skill: archive, restore a version, take an edited copy, publish again.
#[tauri::command]
fn skill_action(state: State<'_, AppState>, name: String, action: String, version: Option<u32>) -> Result<(), String> {
    skills::check_name(&name)?;
    match action.as_str() {
        "archive" => state.skills.archive(&name, "user", None),
        "restore" => state.skills.restore(&name, version.ok_or("Which version?")?, "user").map(|_| ()),
        "import" => state.skills.import(&name, "user").map(|_| ()),
        "publish" => state.skills.publish(&name, "user").map(|_| ()),
        _ => Err(format!("Unknown skill action: {action}")),
    }
}

#[tauri::command]
fn skill_version(state: State<'_, AppState>, name: String, version: u32) -> Result<String, String> {
    state.skills.version_text(&name, version)
}

#[tauri::command]
fn skill_history(state: State<'_, AppState>, name: Option<String>) -> Vec<skills::LedgerEntry> {
    let mut rows = state.skills.history(name.as_deref());
    rows.truncate(200);
    rows
}

/// Propose archiving skills that are stale or whose sessions are mostly rejected.
#[tauri::command]
fn skills_upkeep(state: State<'_, AppState>) -> Vec<skills::Proposal> {
    state.skills.upkeep(agent::now_ms())
}

/// A skill proposal from a runbook note: the note's text becomes the skill's, for the user to edit and approve.
#[tauri::command]
async fn skill_from_note(state: State<'_, AppState>, note: String) -> Result<skills::Proposal, String> {
    let reply = state.bridge.call(&["read".into(), note.clone(), "--actor".into(), "viewer".into()], None)?;
    if reply.exit_code != 0 {
        return Err(format!("Living Memory could not read {note}: {}", reply.error));
    }
    let title = reply.result.get("title").and_then(Value::as_str).unwrap_or_default();
    let body = reply.result.get("body").and_then(Value::as_str).unwrap_or_default();
    let (description, text) = skills::from_note(body);
    state.skills.propose(
        skills::NewProposal {
            kind: Some(skills::Kind::Create), name: skills::slug(title), description, body: text,
            reason: format!("Made from the runbook note \"{title}\""), note: Some(note), ..Default::default()
        },
        "user",
    )
}

/// Workflows start real sessions through the same path as the Start screen.
struct AppHost(AppHandle);

impl workflow::Host for AppHost {
    fn start(&self, task: agent::scope::AgentTask, prompt: &str, options: agent::StartOptions) -> Result<agent::SessionInfo, String> {
        let state = self.0.state::<AppState>();
        agent::start_task(&state.agents, &state.bridge, &settings::load(&state.settings_path), &state.worktrees_dir, &state.terminals_dir, task, prompt, options)
    }
    fn info(&self, session: &str) -> Option<agent::SessionInfo> {
        self.0.state::<AppState>().agents.info(session).ok()
    }
    fn checkpoint(&self, session: &str, message: &str) -> Result<Option<String>, String> {
        let state = self.0.state::<AppState>();
        review::checkpoint(&state.agents, &state.worktrees_dir, session, message)
    }
    fn stop(&self, session: &str) {
        let _ = self.0.state::<AppState>().agents.end(session);
    }
    fn branch_tip(&self, repo: &str, branch: &str) -> Option<String> {
        worktree::branch_tip(std::path::Path::new(repo), branch)
    }
}

/// What automations do, with the app's state.
struct AppDoer(AppHandle);

impl automations::Doer for AppDoer {
    fn run(&self, a: &automations::Automation, vars: &automations::Vars, cancel: &oneshot::Cancel) -> Result<automations::Started, String> {
        use automations::{Action, Started};
        let state = self.0.state::<AppState>();
        let saved = settings::load(&state.settings_path);
        let (project, repo) = (a.project.clone().unwrap_or_default(), a.repo.clone().unwrap_or_default());
        // The repository must still be one of the project's: it may have left Living Memory since the automation was saved.
        let repo = if project.is_empty() || repo.is_empty() {
            repo
        } else {
            agent::scope::project_repo(&git::project_entry(&state.bridge, &project)?, &repo)?.display().to_string()
        };
        let origin = format!("automation:{}", a.id);
        match &a.action {
            Action::Role { role, engine, prompt } => {
                let options = agent::StartOptions {
                    briefing: Some(format!("## Automation\nThe automation \"{}\" started this session; nobody is watching it. Finish in one turn.", a.name)),
                    engine: *engine, interface: agent::Interface::Chat, role: Some(*role), unattended: true, origin: Some(origin), budget_usd: a.budget_usd, ..Default::default()
                };
                let task = agent::scope::AgentTask::Work { project, repo, branch: None, change: None };
                let info = agent::start_task(&state.agents, &state.bridge, &saved, &state.worktrees_dir, &state.terminals_dir, task, &automations::fill(prompt, vars), options)?;
                Ok(Started::Session(info.id))
            }
            Action::Workflow { template, goal } => {
                let tasks = workflow::templates().into_iter().find(|t| t.id == template).ok_or_else(|| format!("Unknown workflow template: {template}"))?.tasks;
                let tasks = workflow::on_shown(tasks, &saved);
                let new = workflow::NewRun { goal: automations::fill(goal, vars), project, repo, template: Some(template.clone()), unattended: true, budget_usd: a.budget_usd, tasks, ..Default::default() };
                let run = state.workflows.create(new, Some(origin))?;
                let run = state.workflows.start(&run.id, &AppHost(self.0.clone()))?;
                // No session report follows a workflow whose every task failed to start, so it ends here.
                match run.state {
                    workflow::RunState::Running => Ok(Started::Workflow(run.id)),
                    workflow::RunState::Succeeded => Ok(Started::Done { detail: "The workflow succeeded".into(), cost: None }),
                    _ => Err(run.tasks.iter().find_map(|t| t.error.clone()).unwrap_or_else(|| "The workflow could not start".into())),
                }
            }
            Action::MemoryMaintenance => {
                let reply = state.bridge.call(&["maintenance".into(), "run".into()], None)?;
                if reply.exit_code != 0 {
                    return Err(format!("Living Memory maintenance failed: {}", reply.error));
                }
                let r = &reply.result;
                let word = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
                match word("status").as_str() {
                    "failed" => Err(format!("Living Memory maintenance failed ({})", word("reason_code"))),
                    "skipped" => Ok(Started::Done { detail: format!("Living Memory skipped maintenance ({})", word("skip_reason").replace('_', " ")), cost: None }),
                    other => Ok(Started::Done { detail: format!("Living Memory maintenance {other}"), cost: None }),
                }
            }
            Action::ArchitectureCheck { system } => {
                let d = drift_now(&self.0, system)?;
                let _ = self.0.emit("architecture-drift", &d.system);
                let detail = if d.problems.is_empty() { d.text() } else { format!("{}. Could not check: {}", d.text(), d.problems.join("; ")) };
                if d.needs_attention() {
                    // Drift is what the user asked to hear about, whatever the notification level says about failures.
                    notify::notice(&self.0, &a.name, &detail);
                }
                Ok(Started::Done { detail, cost: None })
            }
            Action::ExecutiveBriefing { briefing, days } => {
                if let Some(why) = automations::Doer::paused(self, a) {
                    return Err(why);
                }
                let deps = executive::Deps { cancel: Some(cancel), ..exec_deps(&state, &saved)? };
                let scope = Some(project.as_str()).filter(|p| !p.is_empty());
                let record = executive::brief(&executive::viewer(&state.bridge), &state.executive, &deps, briefing, scope, *days, &origin, today())?;
                let _ = self.0.emit("executive-changed", "briefing");
                let title = record.get("title").and_then(Value::as_str).unwrap_or("Your briefing").to_string();
                Ok(Started::Done { detail: format!("{title} is ready on the Executive page"), cost: record.get("costUsd").and_then(Value::as_f64) })
            }
            Action::SkillUpkeep => {
                let made = state.skills.upkeep(agent::now_ms());
                Ok(Started::Done { detail: format!("{} archive proposal{} added to Review", made.len(), if made.len() == 1 { "" } else { "s" }), cost: None })
            }
            Action::CommitCapture => {
                // Only Run now gets here while paused; a failed run keeps the last reviewed commit.
                if let Some(why) = automations::Doer::paused(self, a) {
                    return Err(why);
                }
                let mut command = std::process::Command::new("git");
                command.args(["--no-optional-locks", "-C", &repo, "log", "--stat", "-p", "--no-color", "--no-ext-diff", "--no-textconv"]);
                // The exact commits of this batch (automations::COMMIT_BATCH at most, parents first, in that order), or the last
                // few commits the first time.
                match (&vars.batch, a.last_seen.as_deref()) {
                    (Some(batch), _) if batch.is_empty() => return Ok(Started::Done { detail: "No new commits".into(), cost: None }),
                    (Some(batch), _) => command.arg("--no-walk=unsorted").args(batch.iter().filter(|sha| git::is_sha(sha))),
                    (None, Some(_)) => return Err("Could not list the commits after the last review; the reviewed commits are kept".into()),
                    (None, None) => command.arg("-5"),
                };
                let log = git::run_with_timeout(command, std::time::Duration::from_secs(30))?;
                if log.trim().is_empty() {
                    return Ok(Started::Done { detail: "No new commits".into(), cost: None });
                }
                let claude = agent::claude::available(&saved)?;
                let deps = learning::Deps { bridge: &state.bridge, skills: &state.skills, claude, daily_usd: saved.learning_daily_usd(), auto_patch: false };
                // One key per batch: two batches of one backlog share HEAD, not their last commit.
                let last = vars.batch.as_ref().and_then(|b| b.last()).or(vars.head.as_ref()).cloned().unwrap_or_default();
                let key = format!("{}-{}", &a.id[..8.min(a.id.len())], &last[..8.min(last.len())]);
                let run = state.learning.review_commits(&deps, &key, &format!("{} commits", a.name), &project, &repo, &log);
                let _ = self.0.emit("learning-changed", &run);
                match run.state.as_str() {
                    "failed" => Err(run.error.unwrap_or_else(|| "The review failed".into())),
                    "nothing" => Ok(Started::Done { detail: "Nothing worth keeping in the new commits".into(), cost: run.cost_usd }),
                    _ => Ok(Started::Done { detail: format!("{} note draft{} in Review", run.memory.len(), if run.memory.len() == 1 { "" } else { "s" }), cost: run.cost_usd }),
                }
            }
        }
    }
    fn head(&self, repo: &str) -> Option<String> {
        git::head_sha(std::path::Path::new(repo)).ok()
    }
    fn next_batch(&self, repo: &str, reviewed: &str, limit: usize) -> Option<(Vec<String>, String)> {
        let tips: Vec<&str> = reviewed.split_whitespace().collect();
        git::next_batch(std::path::Path::new(repo), &tips, limit).ok().map(|(batch, tips)| (batch, tips.join(" ")))
    }
    fn log(&self, repo: &str, since: Option<&str>) -> Result<String, String> {
        let mut command = std::process::Command::new("git");
        command.args(["--no-optional-locks", "-C", repo, "log", "--oneline", "--no-color"]);
        match since {
            // `since` holds the reviewed tips, space-separated; only live commit ids reach git.
            Some(s) => {
                let tips = git::live_tips(std::path::Path::new(repo), &s.split_whitespace().collect::<Vec<_>>())?;
                command.args(["--max-count=50", "HEAD", "--not"]).args(tips)
            }
            None => command.arg("--max-count=10"),
        };
        git::run_with_timeout(command, std::time::Duration::from_secs(15))
    }
    fn paused(&self, a: &automations::Automation) -> Option<String> {
        let saved = settings::load(&self.0.state::<AppState>().settings_path);
        match a.action {
            automations::Action::CommitCapture => (!saved.shows(agent::Engine::Claude))
                .then(|| "Paused: Claude Code is hidden in Settings. Show it again to review these commits.".into()),
            automations::Action::ExecutiveBriefing { .. } => (!saved.shows(agent::Engine::Claude))
                .then(|| "Paused: Claude Code is hidden in Settings. Show it again to write briefings.".into()),
            _ => None,
        }
    }
    fn budget_left(&self) -> bool {
        let state = self.0.state::<AppState>();
        state.learning.has_budget(settings::load(&state.settings_path).learning_daily_usd())
    }
    fn notify(&self, title: &str, text: &str) {
        notify::notice(&self.0, title, text);
    }
    fn changed(&self) {
        let _ = self.0.emit("automations-changed", ());
    }
}

/// Workflows advance and automations finish on session reports; failed and approved sessions the user started fire
/// event automations. Work that starts sessions runs on its own thread so the conductor never waits on a worktree.
fn orchestration_reports(app: AppHandle) -> conductor::Handler {
    Box::new(move |report| {
        let Some(state) = app.try_state::<AppState>() else { return };
        let report = report.clone();
        let app = app.clone();
        let info = state.agents.info(report.id()).ok();
        std::thread::spawn(move || {
            let state = app.state::<AppState>();
            let host = AppHost(app.clone());
            let doer = AppDoer(app.clone());
            state.workflows.on_report(&report, &host);
            let _ = app.emit("workflows-changed", ());
            let Some(info) = info else { return };
            let origin = info.origin.clone().unwrap_or_default();
            let ended = match &report {
                agent::Lifecycle::TurnEnded { ok, .. } => Some(*ok),
                agent::Lifecycle::Finished { status, .. } => Some(*status == agent::events::Status::Succeeded),
                _ => None,
            };
            if let (Some(ok), true) = (ended, origin.starts_with("automation:")) {
                let detail = info.summary.clone().or(info.error.clone()).map(|t| agent::events::clip(&t, 300)).unwrap_or_else(|| "Session finished".into());
                if state.automations.finished(Some(&info.id), None, ok, detail, info.cost_usd, &doer).is_some() {
                    state.learning.charge(info.cost_usd.unwrap_or(0.0));
                }
            }
            // A workflow an automation started has ended.
            for run in state.workflows.list().into_iter().filter(|r| r.origin.as_deref().is_some_and(|o| o.starts_with("automation:"))) {
                if matches!(run.state, workflow::RunState::Succeeded | workflow::RunState::Failed | workflow::RunState::Cancelled) {
                    let cost: f64 = run.tasks.iter().filter_map(|t| t.session.as_deref()).filter_map(|s| state.agents.info(s).ok()).filter_map(|i| i.cost_usd).sum();
                    let detail = format!("The workflow {}", match run.state { workflow::RunState::Succeeded => "succeeded", workflow::RunState::Failed => "failed", _ => "was cancelled" });
                    if state.automations.finished(None, Some(&run.id), run.state == workflow::RunState::Succeeded, detail, Some(cost), &doer).is_some() {
                        state.learning.charge(cost);
                    }
                }
            }
            // Work an automation started never fires event automations (no loops); a workflow the user started does.
            let by_automation = origin.starts_with("automation:")
                || origin.strip_prefix("workflow:").and_then(|rest| rest.split(':').next()).and_then(|run| state.workflows.get(run).ok())
                    .is_some_and(|run| run.origin.as_deref().is_some_and(|o| o.starts_with("automation:")));
            if by_automation {
                return;
            }
            let (project, repo) = match &info.task {
                agent::scope::AgentTask::Work { project, repo, .. } => (project.clone(), repo.clone()),
                _ => (String::new(), String::new()),
            };
            match &report {
                // A chat session's crash or error ends a turn, not the session; a turn the user stopped is no failure.
                agent::Lifecycle::Finished { status: agent::events::Status::Failed, .. } | agent::Lifecycle::TurnEnded { ok: false, stopped: false, .. } => {
                    let error = info.error.clone().unwrap_or_else(|| "the turn ended with an error".into());
                    let event = format!("A session failed: \"{}\" in {}. Error: {}. Session {}.", info.title, repo, error, &info.id[..8]);
                    state.automations.on_event(&automations::Trigger::SessionFailed, &project, &repo, event, &doer);
                }
                agent::Lifecycle::Reviewed { state: agent::ReviewState::Approved, .. } => {
                    let branch = info.worktree.as_ref().map(|w| w.branch.clone()).unwrap_or_default();
                    let commit = info.review.as_ref().and_then(|r| r.commit.clone()).unwrap_or_default();
                    let event = format!("You approved the session \"{}\" on branch {branch} (commit {}) in {repo}.", info.title, &commit[..7.min(commit.len())]);
                    state.automations.on_event(&automations::Trigger::ReviewApproved, &project, &repo, event, &doer);
                }
                _ => {}
            }
        });
    })
}

/// Work out a system's drift now and keep it as its last drift.
fn drift_now(app: &AppHandle, slug: &str) -> Result<archsuite::Drift, String> {
    let state = app.state::<AppState>();
    let saved = settings::load(&state.settings_path);
    let entry = architecture::system_entry(&state.bridge, slug)?;
    let behind = architecture::staleness(&state.bridge, &state.agents.sessions(), slug).ok().and_then(|s| s.behind);
    let snapshots = architecture::list_snapshots(&state.snapshots_dir, slug).unwrap_or_default().into_iter().take(archsuite::SNAPSHOTS_READ)
        .filter_map(|s| architecture::read_snapshot(&state.snapshots_dir, slug, &s.id).ok().map(|x| (x.taken_at, x.model)))
        .collect();
    let home = dirs::home_dir().ok_or("Could not find your home folder")?;
    let cli = archsuite::locate(saved.architecture_suite_plugin.as_deref(), &home);
    let inputs = archsuite::Inputs { slug, folder: architecture::folder_of(&entry), behind, snapshots, rules: saved.architecture_rules(slug) };
    archsuite::drift(&app.path().app_data_dir().map_err(|e| e.to_string())?, cli, inputs)
}

/// A system's last drift, or a new one when `refresh` (runs the Architecture Suite; seconds).
#[tauri::command]
async fn architecture_drift(app: AppHandle, slug: String, refresh: bool) -> Result<Option<archsuite::Drift>, String> {
    blocking(move || {
        if refresh {
            drift_now(&app, &slug).map(Some)
        } else {
            Ok(archsuite::last_drift(&app.path().app_data_dir().map_err(|e| e.to_string())?, &slug))
        }
    })
    .await
}

/// Set or clear a system's rules file; the file must be an architecture-rules/v1 document.
#[tauri::command]
fn architecture_rules_set(state: State<'_, AppState>, slug: String, path: Option<String>) -> Result<(), String> {
    let path = path.map(|p| p.trim().trim_matches('"').to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        archsuite::check_rules(std::path::Path::new(p))?;
    }
    let mut saved = settings::load(&state.settings_path);
    let mut rules = saved.architecture_rules.take().unwrap_or_default();
    match path {
        Some(p) => rules.insert(slug, p),
        None => rules.remove(&slug),
    };
    saved.architecture_rules = Some(rules);
    settings::save(&state.settings_path, &saved)
}

#[tauri::command]
fn workflow_templates() -> Vec<workflow::Template> {
    workflow::templates()
}

#[tauri::command]
fn workflow_list(state: State<'_, AppState>) -> Vec<workflow::Run> {
    state.workflows.list()
}

#[tauri::command]
fn workflow_create(state: State<'_, AppState>, run: workflow::NewRun) -> Result<workflow::Run, String> {
    state.workflows.create(run, Some("user".into()))
}

#[tauri::command]
fn workflow_edit(state: State<'_, AppState>, id: String, tasks: Vec<workflow::TaskSpec>) -> Result<workflow::Run, String> {
    state.workflows.edit(&id, tasks)
}

/// Start, cancel, retry or skip; each may start sessions, so it runs off the UI thread.
#[tauri::command]
async fn workflow_act(app: AppHandle, id: String, action: String, task: Option<String>) -> Result<workflow::Run, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let host = AppHost(app.clone());
        let run = match action.as_str() {
            "start" => state.workflows.start(&id, &host),
            "cancel" => state.workflows.cancel(&id, &host),
            "retry" | "skip" => state.workflows.retry_or_skip(&id, task.as_deref().ok_or("Which task?")?, action == "skip", &host),
            _ => Err(format!("Unknown workflow action: {action}")),
        };
        let _ = app.emit("workflows-changed", ());
        run
    })
    .await
}

#[tauri::command]
fn workflow_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.workflows.delete(&id)
}

#[tauri::command]
fn workflow_report(state: State<'_, AppState>, id: String) -> Result<String, String> {
    state.workflows.get(&id).map(|r| r.report())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationView {
    #[serde(flatten)]
    automation: automations::Automation,
    trigger_text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationList {
    automations: Vec<AutomationView>,
    templates: Vec<AutomationView>,
    runs: Vec<automations::RunRow>,
}

#[tauri::command]
fn automation_list(state: State<'_, AppState>) -> AutomationList {
    let view = |automation: automations::Automation| AutomationView { trigger_text: automations::trigger_text(&automation.trigger), automation };
    let mut runs = state.automations.all_runs();
    runs.truncate(100);
    AutomationList {
        automations: state.automations.list().into_iter().map(view).collect(),
        templates: automations::templates().into_iter().map(view).collect(),
        runs,
    }
}

#[tauri::command]
async fn automation_put(app: AppHandle, automation: automations::Automation) -> Result<automations::Automation, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let mut automation = automation;
        // Commit capture and role sessions read this repository, so it must be registered for the project (its spelling).
        // Turning one off is always allowed, even when its repository has left Living Memory.
        if let (true, Some(project), Some(repo)) = (automation.enabled, automation.project.as_deref(), automation.repo.as_deref()) {
            let entry = git::project_entry(&state.bridge, project)?;
            automation.repo = Some(agent::scope::project_repo(&entry, repo)?.display().to_string());
        }
        // A workflow automation runs its template on the engines shown now; refuse one that could never run unattended.
        if let (true, automations::Action::Workflow { template, .. }) = (automation.enabled, &automation.action)
            && let Some(t) = workflow::templates().into_iter().find(|t| &t.id == template)
        {
            workflow::check_unattended(&workflow::on_shown(t.tasks, &settings::load(&state.settings_path)), true)?;
        }
        let saved = state.automations.put(automation, agent::now_ms());
        let _ = app.emit("automations-changed", ());
        saved
    })
    .await
}

#[tauri::command]
fn automation_delete(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let done = state.automations.delete(&id);
    let _ = app.emit("automations-changed", ());
    done
}

/// Run now, start a waiting run, or cancel a run (stopping its session or workflow).
#[tauri::command]
async fn automation_act(app: AppHandle, action: String, id: String) -> Result<Option<automations::RunRow>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let doer = AppDoer(app.clone());
        let row = match action.as_str() {
            "run" => Ok(state.automations.fire(&id, "manual", None, &doer)),
            "approve" => state.automations.approve(&id, &doer).map(Some),
            "cancel" => {
                let row = state.automations.cancel(&id)?;
                if let Some(s) = &row.session {
                    let _ = state.agents.end(s);
                }
                if let Some(w) = &row.workflow {
                    let _ = state.workflows.cancel(w, &AppHost(app.clone()));
                }
                Ok(Some(row))
            }
            _ => Err(format!("Unknown automation action: {action}")),
        };
        let _ = app.emit("automations-changed", ());
        row
    })
    .await
}

/// The roles a chat session can be started in, with their default permission profiles.
#[tauri::command]
fn agent_roles() -> Vec<agent::roles::RoleInfo> {
    agent::roles::list()
}

/// Start an agent session for a task; what it may touch is worked out here, not by the webview.
#[tauri::command]
async fn agent_start(
    state: State<'_, AppState>,
    task: agent::scope::AgentTask,
    prompt: String,
    options: Option<agent::StartOptions>,
) -> Result<agent::SessionInfo, String> {
    let (agents, bridge, path) = (state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    let (worktrees, terminals) = (state.worktrees_dir.clone(), state.terminals_dir.clone());
    blocking(move || agent::start_task(&agents, &bridge, &settings::load(&path), &worktrees, &terminals, task, &prompt, options.unwrap_or_default())).await
}

/// Send a message to an idle interactive session.
#[tauri::command]
async fn agent_send(state: State<'_, AppState>, session_id: String, text: String, options: Option<agent::SendOptions>) -> Result<(), String> {
    let (agents, bridge, path) = (state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || agent::send_task(&agents, &bridge, &settings::load(&path), &session_id, &text, options.unwrap_or_default(), None)).await
}

/// Answer a permission request a session is waiting on.
#[tauri::command]
async fn agent_answer(state: State<'_, AppState>, session_id: String, request_id: String, decision: agent::events::Decision) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.answer(&session_id, &request_id, decision)).await
}

/// Stop the turn a session is working on.
#[tauri::command]
async fn agent_interrupt(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.interrupt(&session_id)).await
}

/// End an interactive session.
#[tauri::command]
async fn agent_end(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.end(&session_id)).await
}

/// The files changed in a session's worktree, with their patches.
#[tauri::command]
async fn agent_files(state: State<'_, AppState>, session_id: String) -> Result<worktree::ChangedFiles, String> {
    let agents = state.agents.clone();
    blocking(move || agents.files(&session_id)).await
}

/// Change the permission mode of an interactive session.
#[tauri::command]
async fn agent_set_policy(state: State<'_, AppState>, session_id: String, policy: agent::scope::PolicyMode) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.set_policy(&session_id, policy)).await
}

/// Give a session a name (trimmed, at most 80 characters; empty clears it).
#[tauri::command]
async fn agent_rename(state: State<'_, AppState>, session_id: String, name: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.amend(&session_id, |info| info.name = agent::clean_name(&name)).map(|_| ())).await
}

/// Remove the worktree of a session that has ended.
#[tauri::command]
async fn agent_remove_worktree(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.remove_worktree(&session_id)).await
}

/// The files a work session changed in its worktree since its review base.
#[tauri::command]
async fn review_files(state: State<'_, AppState>, session_id: String) -> Result<Vec<worktree::FileChange>, String> {
    let (agents, root, bridge, path) = (state.agents.clone(), state.worktrees_dir.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || {
        let (saved, registry) = (settings::load(&path), |slug: &str| git::project_entry(&bridge, slug));
        review::files(&agents, &root, &review::DirectEnv { saved: &saved, registry: &registry }, &session_id)
    })
    .await
}

/// The two versions of one file a work session changed.
#[tauri::command]
async fn review_file(state: State<'_, AppState>, session_id: String, path: String) -> Result<review::FileContents, String> {
    let (agents, root, bridge, settings_path) = (state.agents.clone(), state.worktrees_dir.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || {
        let (saved, registry) = (settings::load(&settings_path), |slug: &str| git::project_entry(&bridge, slug));
        review::file(&agents, &root, &review::DirectEnv { saved: &saved, registry: &registry }, &session_id, &path)
    })
    .await
}

/// Commit the session's edits on its own branch. Never merges, never pushes.
#[tauri::command]
async fn review_approve(state: State<'_, AppState>, session_id: String, message: String) -> Result<String, String> {
    let (agents, root) = (state.agents.clone(), state.worktrees_dir.clone());
    blocking(move || review::approve(&agents, &root, &session_id, &message)).await
}

/// Close a terminal session's program, then commit its edits as `review_approve` does.
#[tauri::command]
async fn review_stop_and_approve(state: State<'_, AppState>, session_id: String, message: String) -> Result<String, String> {
    let (agents, terminals, root) = (state.agents.clone(), state.terminals.clone(), state.worktrees_dir.clone());
    blocking(move || review::stop_and_approve(&agents, &terminals, &root, &session_id, &message)).await
}

/// Write a terminal session's review comments to a file and resume its program with a pointer to it.
#[tauri::command]
async fn review_request_terminal_changes(state: State<'_, AppState>, session_id: String, text: String) -> Result<(), String> {
    let (agents, terminals) = (state.agents.clone(), state.terminals.clone());
    blocking(move || review::request_terminal_changes(&agents, &terminals, &session_id, &text).map(|_| ())).await
}

/// Send the session a message asking for changes.
#[tauri::command]
async fn review_request_changes(state: State<'_, AppState>, session_id: String, text: String) -> Result<(), String> {
    let (agents, bridge, path) = (state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || review::request_changes(&agents, &bridge, &settings::load(&path), &session_id, &text)).await
}

/// Take a session's edits out of the review queue and leave them where they are.
#[tauri::command]
async fn review_dismiss(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || review::dismiss(&agents, &session_id)).await
}

/// Throw the session's edits away: reset its worktree to its review base and remove untracked files.
#[tauri::command]
async fn review_discard(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let (agents, root) = (state.agents.clone(), state.worktrees_dir.clone());
    blocking(move || review::discard(&agents, &root, &session_id)).await
}

/// The full text of one tool result of a session, read back from its raw log.
#[tauri::command]
async fn review_tool_output(state: State<'_, AppState>, session_id: String, tool_use_id: String) -> Result<agent::ToolOutput, String> {
    let agents = state.agents.clone();
    blocking(move || agents.tool_output(&session_id, &tool_use_id)).await
}

/// Look at every session's worktree again, so edits made outside a turn are noticed.
#[tauri::command]
async fn review_refresh(state: State<'_, AppState>) -> Result<usize, String> {
    let (agents, root) = (state.agents.clone(), state.worktrees_dir.clone());
    blocking(move || Ok(review::refresh(&agents, &root))).await
}

/// The local branches of one of a project's repositories (the repository must be registered for the project).
#[tauri::command]
async fn repo_branches(state: State<'_, AppState>, project: String, repo: String) -> Result<git::Branches, String> {
    let bridge = state.bridge.clone();
    blocking(move || {
        let entry = git::project_entry(&bridge, &project)?;
        git::branches(&agent::scope::project_repo(&entry, &repo)?)
    })
    .await
}

#[tauri::command]
async fn agent_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let agents = state.agents.clone();
    blocking(move || agents.cancel(&session_id)).await
}

/// Every agent session, newest first.
#[tauri::command]
fn agent_sessions(state: State<'_, AppState>) -> Result<Vec<agent::SessionInfo>, String> {
    Ok(state.agents.sessions())
}

/// One session and its events from `from_seq` on, rebuilt from its stored log.
#[tauri::command]
async fn agent_session(state: State<'_, AppState>, session_id: String, from_seq: u64) -> Result<agent::SessionLog, String> {
    let agents = state.agents.clone();
    blocking(move || agents.session(&session_id, from_seq)).await
}

/// A terminal session's conversation from its CLI's own file; empty until the file exists.
#[tauri::command]
async fn agent_transcript(state: State<'_, AppState>, session_id: String) -> Result<Vec<agent::events::SeqEvent>, String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.transcript(&session_id)).await
}

/// A terminal session's tokens, cost and plan limits from its CLI's own file.
#[tauri::command]
async fn agent_usage(state: State<'_, AppState>, session_id: String) -> Result<term::usage::Usage, String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.usage(&session_id)).await
}

/// The conversations a CLI saved for a project checkout or a picked folder, newest 50, including ones started outside
/// Hivemind. The folder comes from the registry or the picker's list, never from a path the webview wrote.
#[tauri::command]
async fn cli_history(state: State<'_, AppState>, engine: agent::Engine, target: term::ShellTarget) -> Result<Vec<term::history::Conversation>, String> {
    let (terminals, agents, bridge, path) = (state.terminals.clone(), state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || {
        let cwd = history_folder(&target, &agents, &bridge, &settings::load(&path))?;
        Ok(terminals.history(engine, &cwd))
    })
    .await
}

fn history_folder(target: &term::ShellTarget, agents: &agent::Manager, bridge: &bridge::Bridge, saved: &settings::Settings) -> Result<PathBuf, String> {
    term::shell_cwd(target, agents, saved, |project, repo| agent::scope::project_repo(&git::project_entry(bridge, project)?, repo))
}

/// Make a Hivemind terminal session of a conversation a CLI saved, in the same folder. It opens in Resume mode.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one webview argument per setting of the Start screen
async fn agent_import(
    state: State<'_, AppState>,
    engine: agent::Engine,
    cli_id: String,
    target: term::ShellTarget,
    access: Option<agent::access::Access>,
    model: Option<String>,
    effort: Option<String>,
    confirmed_risky: Option<bool>,
) -> Result<agent::SessionInfo, String> {
    let (terminals, agents, bridge, path) = (state.terminals.clone(), state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    let (worktrees, terminal_dir) = (state.worktrees_dir.clone(), state.terminals_dir.clone());
    blocking(move || {
        agent::import_task(&cli_id, &target)?;
        let saved = settings::load(&path);
        let cwd = history_folder(&target, &agents, &bridge, &saved)?;
        let title = terminals
            .history(engine, &cwd)
            .into_iter()
            .find(|conversation| conversation.id == cli_id)
            .map(|conversation| conversation.title)
            .ok_or("That conversation is not saved for this folder")?;
        let options = agent::StartOptions { engine, access, model, effort, confirmed_risky: confirmed_risky.unwrap_or(false), ..Default::default() };
        agent::import_session(&agents, &bridge, &saved, &worktrees, &terminal_dir, &cli_id, &title, &target, options)
    })
    .await
}

/// Whether a CLI is signed in, from its own status command. Never reads or returns credentials.
#[tauri::command]
async fn agent_auth_status(state: State<'_, AppState>, engine: agent::Engine) -> Result<term::auth::AuthStatus, String> {
    let path = state.settings_path.clone();
    blocking(move || Ok(term::auth::status(engine, &settings::load(&path)))).await
}

fn raw(output: Channel<InvokeResponseBody>) -> term::Output {
    Arc::new(move |bytes| output.send(InvokeResponseBody::Raw(bytes)).is_ok())
}

/// Attach to a session's terminal, show its saved history, and start its program when asked.
#[tauri::command]
async fn term_open(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    start: Option<term::StartMode>,
    replay: bool,
    output: Channel<InvokeResponseBody>,
) -> Result<term::TermInfo, String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.open(&session_id, cols, rows, start, replay, raw(output))).await
}

/// Open the CLI's own sign-in in a terminal of its own.
#[tauri::command]
async fn term_login(state: State<'_, AppState>, engine: agent::Engine, cols: u16, rows: u16, output: Channel<InvokeResponseBody>) -> Result<term::TermInfo, String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.login(engine, cols, rows, raw(output))).await
}

/// Open a PowerShell tab in a session's folder, a project's checkout or a picked folder.
#[tauri::command]
async fn term_shell(state: State<'_, AppState>, target: term::ShellTarget, cols: u16, rows: u16, output: Channel<InvokeResponseBody>) -> Result<term::TermInfo, String> {
    let (terminals, agents, bridge, path) = (state.terminals.clone(), state.agents.clone(), state.bridge.clone(), state.settings_path.clone());
    blocking(move || {
        let cwd = term::shell_cwd(&target, &agents, &settings::load(&path), |project, repo| {
            agent::scope::project_repo(&git::project_entry(&bridge, project)?, repo)
        })?;
        terminals.shell(cwd, cols, rows, raw(output))
    })
    .await
}

#[tauri::command]
async fn term_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.write(&id, data.as_bytes())).await
}

#[tauri::command]
async fn term_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.resize(&id, cols, rows)).await
}

/// Close a terminal; this can wait up to 3 seconds for the program to leave.
#[tauri::command]
async fn term_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let terminals = state.terminals.clone();
    blocking(move || {
        terminals.close(&id);
        Ok(())
    })
    .await
}

/// The terminals with a running program.
#[tauri::command]
fn term_list(state: State<'_, AppState>) -> Vec<term::TermInfo> {
    state.terminals.list()
}

/// The user looked at a terminal: clear its attention.
#[tauri::command]
fn term_seen(state: State<'_, AppState>, id: String) {
    notify::forget(&id);
    state.terminals.seen(&id);
}

/// The window was just hidden to the tray: tell the user once (the page keeps the flag).
#[tauri::command]
fn notify_tray(app: AppHandle) {
    notify::tray(&app);
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    settings::load(&state.settings_path)
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<'_, AppState>, value: Settings) -> Result<(), String> {
    let previous = settings::load(&state.settings_path);
    // The folder list changes only through the native picker, and the rules files only through architecture_rules_set.
    let mut value = folders::keep(&previous, value);
    value.architecture_rules = previous.architecture_rules.clone();
    if !value.shows(agent::Engine::Claude) && !value.shows(agent::Engine::Codex) {
        return Err("Keep at least one engine shown.".into());
    }
    for (project, commands) in value.allowed_commands.iter().flatten() {
        for command in commands {
            agent::scope::check_command(command).map_err(|e| format!("{project}: {e}"))?;
        }
    }
    settings::save(&state.settings_path, &value)?;
    *state.shortcut_error.lock().unwrap() = capture::apply_shortcut(&app, value.capture_shortcut().as_deref()).err();
    // Only a change of interpreter, script or store needs a new Living Memory process.
    if (&previous.python, &previous.script, &previous.root) != (&value.python, &value.script, &value.root) {
        *state.watcher.lock().unwrap() = None;
        state.bridge.reconfigure(settings::resolve(&value, |k| std::env::var(k).ok()));
    }
    Ok(())
}

/// Ask the user for a folder with the native dialog and remember it. None when the dialog was cancelled.
#[tauri::command]
async fn folder_pick(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = state.settings_path.clone();
    // A blocking dialog must not run on the main thread.
    blocking(move || match app.dialog().file().blocking_pick_folder() {
        None => Ok(None),
        Some(picked) => folders::add(&path, &picked.into_path().map_err(|e| e.to_string())?).map(Some),
    })
    .await
}

/// The themes the exported page can start in (the app's own: `src/lib/theme.ts`).
const WIKI_THEMES: [&str; 3] = ["purple", "emerald", "emerald-light"];

/// The `wiki` argv that writes the page to `path`, starting in `theme` when one is given (the page sends it only when the connected
/// Living Memory has `--theme`; an older one rejects the flag). It runs as the main actor: a viewer may not write files.
/// `agent` exports the agent-written edition (of one project when `project` is set); `archived` only applies to the structured one.
fn wiki_export_argv(domain: &str, path: &str, archived: bool, agent: bool, project: Option<&str>, theme: Option<&str>) -> Result<Vec<String>, String> {
    if let Some(theme) = theme.filter(|t| !WIKI_THEMES.contains(t)) {
        return Err(format!("Unknown theme {theme:?}"));
    }
    let mut argv: Vec<String> = ["wiki", "--domain", domain, "--out", path].map(String::from).into();
    if agent {
        argv.push("--agent".into());
        if let Some(project) = project {
            argv.extend(["--project".into(), project.into()]);
        }
    } else if archived {
        argv.push("--archived".into());
    }
    if let Some(theme) = theme {
        argv.extend(["--theme".into(), theme.into()]);
    }
    Ok(argv)
}

/// The save dialog's suggested name: the domain (and project) with anything but letters, digits, `-`, `_` and `.` replaced.
fn wiki_file_name(domain: &str, agent: bool, project: Option<&str>) -> String {
    let safe = |s: &str| -> String { s.chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect() };
    let project = project.filter(|_| agent).map(|p| format!("-{}", safe(p))).unwrap_or_default();
    format!("{}{project}-{}wiki.html", safe(domain), if agent { "agent-" } else { "" })
}

/// Export a domain's wiki as one HTML file. A native save dialog picks the path (so the webview never supplies one), Living Memory
/// writes the file, and it opens in the default browser. None when the dialog was cancelled.
#[tauri::command]
async fn wiki_export(app: AppHandle, state: State<'_, AppState>, domain: String, archived: bool, agent: bool, project: Option<String>, theme: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_opener::OpenerExt;
    let bridge = state.bridge.clone();
    blocking(move || {
        // Refuse an unknown theme before asking where to save.
        wiki_export_argv(&domain, "", archived, agent, project.as_deref(), theme.as_deref())?;
        let Some(picked) = app.dialog().file().add_filter("HTML page", &["html"]).set_file_name(wiki_file_name(&domain, agent, project.as_deref())).blocking_save_file() else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
        let reply = bridge.call(&wiki_export_argv(&domain, &path, archived, agent, project.as_deref(), theme.as_deref())?, None)?;
        if reply.exit_code != 0 {
            let message = reply.error.get("message").and_then(Value::as_str).map(String::from);
            return Err(message.unwrap_or_else(|| format!("Living Memory exited with code {}", reply.exit_code)));
        }
        app.opener().open_path(&path, None::<&str>).map_err(|e| format!("Saved {path}, but could not open it: {e}"))?;
        Ok(Some(path))
    })
    .await
}

/// Build the agent-written wiki (or dry-run it: the calls and budget it would use, spending nothing). It runs as its own Living
/// Memory process, not through the bridge, so a build of minutes blocks nothing. A real build reports `wiki-build-progress` events
/// and `wiki-build-done`; one real build runs at a time (a dry run does not count). It is refused while Claude Code is hidden in
/// Settings, a dry run too. `LIVING_MEMORY_CLAUDE` is set to the Claude Code program Hivemind uses for its own sessions, when that
/// is an absolute path to an executable. Returns Living Memory's result object.
#[tauri::command]
async fn wiki_agent_build(app: AppHandle, state: State<'_, AppState>, domain: String, project: Option<String>, restructure: bool, dry_run: bool) -> Result<Value, String> {
    let launch = state.bridge.launch();
    let settings_path = state.settings_path.clone();
    blocking(move || {
        let saved = settings::load(&settings_path);
        wiki_build::check_shown(&saved)?;
        let emit = |name: &str, payload: Value| {
            let _ = app.emit(name, payload);
        };
        // Looked up inside `run`, once the build holds its slot (`claude --version` can take seconds), and not at all for a dry run.
        let claude = || wiki_build::claude_override(&agent::claude::available(&saved)).map(String::from);
        wiki_build::run(&emit, &launch, &domain, project.as_deref(), restructure, dry_run, &claude)
    })
    .await
}

/// Stop the running wiki build. The pages it already wrote are kept.
#[tauri::command]
fn wiki_agent_cancel() {
    wiki_build::cancel();
}

/// Take a folder out of the remembered list.
#[tauri::command]
async fn folder_forget(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let settings_path = state.settings_path.clone();
    blocking(move || folders::forget(&settings_path, &path)).await
}

#[tauri::command]
fn capture_status(state: State<'_, AppState>) -> CaptureStatus {
    let saved = settings::load(&state.settings_path);
    CaptureStatus {
        shortcut: saved.capture_shortcut(),
        error: state.shortcut_error.lock().unwrap().clone(),
        close_to_tray: saved.close_to_tray.unwrap_or(true),
    }
}

#[tauri::command]
fn show_main(app: AppHandle) {
    capture::show_main(&app);
}

/// Exit the app; `RunEvent::Exit` stops the programs it started.
#[tauri::command]
fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// The page answered a tray Quit and asks the user itself, so a second tray Quit does not exit without asking.
#[tauri::command]
fn quit_ack() {
    capture::quit_ack();
}

#[tauri::command]
fn draft_put(state: State<'_, AppState>, key: String, value: Value) -> Result<(), String> {
    drafts::put(&state.drafts_dir, &key, &value)
}

#[tauri::command]
fn draft_get(state: State<'_, AppState>, key: String) -> Result<Option<Value>, String> {
    drafts::get(&state.drafts_dir, &key)
}

#[tauri::command]
fn draft_delete(state: State<'_, AppState>, key: String) -> Result<(), String> {
    drafts::delete(&state.drafts_dir, &key)
}

#[tauri::command]
fn draft_list(state: State<'_, AppState>) -> Vec<Value> {
    drafts::list(&state.drafts_dir)
}

// ---- Executive workspace: operational records, grounded drafting, briefings, capture and the executive chat. ----

fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

/// What an executive call needs: Claude Code (the calls run on it) and the daily cap the reviewer shares.
fn exec_deps<'a>(state: &'a AppState, saved: &Settings) -> Result<executive::Deps<'a>, String> {
    if !saved.shows(agent::Engine::Claude) {
        return Err("Drafting, briefings and capture run on Claude Code, which is hidden in Settings. Show it again to use them.".into());
    }
    Ok(executive::Deps { claude: agent::claude::available(saved)?, ledger: state.learning.ledger(), cap: saved.learning_daily_usd(), cancel: None })
}

#[tauri::command]
fn exec_list(state: State<'_, AppState>, kind: String) -> Result<Vec<Value>, String> {
    state.executive.list(&kind)
}

#[tauri::command]
fn exec_put(app: AppHandle, state: State<'_, AppState>, kind: String, record: Value) -> Result<Value, String> {
    let saved = state.executive.put(&kind, record, agent::now_ms())?;
    let _ = app.emit("executive-changed", &kind);
    Ok(saved)
}

#[tauri::command]
fn exec_delete(app: AppHandle, state: State<'_, AppState>, kind: String, id: String) -> Result<(), String> {
    state.executive.delete(&kind, &id)?;
    let _ = app.emit("executive-changed", &kind);
    Ok(())
}

/// The evidence a generated text about `project` (or all active projects) would rest on.
#[tauri::command]
async fn exec_pack(app: AppHandle, project: Option<String>, days: Option<u32>) -> Result<executive::Pack, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        executive::pack(&executive::viewer(&state.bridge), &state.executive, project.as_deref(), days.unwrap_or(14), today())
    })
    .await
}

#[tauri::command]
async fn exec_brief(app: AppHandle, kind: String, project: Option<String>, days: Option<u32>) -> Result<Value, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let saved = settings::load(&state.settings_path);
        let deps = exec_deps(&state, &saved)?;
        let record = executive::brief(&executive::viewer(&state.bridge), &state.executive, &deps, &kind, project.as_deref(), days.unwrap_or(7), "manual", today())?;
        let _ = app.emit("executive-changed", "briefing");
        Ok(record)
    })
    .await
}

#[tauri::command]
async fn exec_draft(app: AppHandle, request: executive::DraftRequest) -> Result<Value, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let saved = settings::load(&state.settings_path);
        executive::draft(&executive::viewer(&state.bridge), &state.executive, &exec_deps(&state, &saved)?, &request, today())
    })
    .await
}

#[tauri::command]
async fn exec_refine(app: AppHandle, subject: String, body: String, evidence: Vec<executive::Evidence>, instruction: String) -> Result<Value, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let saved = settings::load(&state.settings_path);
        executive::refine(&state.executive, &exec_deps(&state, &saved)?, &subject, &body, &evidence, &instruction)
    })
    .await
}

/// Extract decisions, commitments, risks and the rest from pasted text into a capture batch. None: nothing worth keeping.
#[tauri::command]
async fn exec_extract(app: AppHandle, text: String, project: Option<String>, label: Option<String>) -> Result<Option<Value>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let saved = settings::load(&state.settings_path);
        let label = label.filter(|l| !l.trim().is_empty()).unwrap_or_else(|| format!("Quick capture, {}", today()));
        let source = executive::Source { kind: "paste".into(), label, session: None, upto: None };
        let staged = executive::extract(&executive::viewer(&state.bridge), &state.executive, &exec_deps(&state, &saved)?, &text, project.as_deref(), source, today())?;
        let _ = app.emit("executive-changed", "capture");
        Ok(staged)
    })
    .await
}

/// Learn writing preferences from the user's edits to a generated draft; the suggestions wait in the capture inbox. True
/// when some were staged. The webview records the draft as learned from only when this succeeds, so a failure is retried.
#[tauri::command]
async fn exec_learn_style(app: AppHandle, draft: String, generated: String, kept: String, label: String) -> Result<bool, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let saved = settings::load(&state.settings_path);
        let deps = exec_deps(&state, &saved)?;
        let staged = executive::learn_style(&executive::viewer(&state.bridge), &state.executive, &deps, &generated, &kept, &label)?.is_some();
        if staged {
            let _ = app.emit("executive-changed", "capture");
        }
        // Only `learnedFrom` changes, and only on the same draft text, so a deleted or refined draft is left alone.
        if executive::mark_learned(&state.executive, &draft, &generated)? {
            let _ = app.emit("executive-changed", "draft");
        }
        Ok(staged)
    })
    .await
}

/// Start the executive chat about `project` (or all projects).
#[tauri::command]
async fn exec_agent_start(app: AppHandle, project: Option<String>, prompt: String, options: agent::StartOptions) -> Result<agent::SessionInfo, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let saved = settings::load(&state.settings_path);
        let lm = executive::viewer(&state.bridge);
        let briefing = executive::agent_briefing(&lm, &state.executive, project.as_deref(), today())?;
        let domains: Vec<String> = executive::bound_domains(&lm, project.as_deref())?.into_iter().collect();
        agent::start_executive(&state.agents, &state.bridge, &saved, &state.executive.agent_dir(), project, &domains, briefing, &prompt, options)
    })
    .await
}

/// Extract what an executive conversation decided, committed to or learned into capture batches. Each capture takes the
/// finished turns after the last batch from this conversation (when it ends, and whenever the user asks); asked for with
/// nothing new, it takes the whole conversation again. Returns the first batch staged. A failed extraction moves no
/// cursor past its turns, so the next capture retries them.
fn capture_session(app: &AppHandle, id: &str, manual: bool) -> Result<Option<Value>, String> {
    let state = app.state::<AppState>();
    // A manual capture while one runs is refused; the session-end capture waits its turn and then reads the log again.
    let _claim = if manual {
        state.capturing.claim(id).ok_or("This conversation is already being captured")?
    } else {
        state.capturing.wait(id)
    };
    let saved = settings::load(&state.settings_path);
    let mut covered = executive::captured_upto(&state.executive.list("capture")?, id).max(state.executive.capture_cursor(id));
    let (mut again, mut first) = (manual, None);
    // One transcript the extractor reads whole at a time, oldest first; the cursor moves only past what was sent.
    loop {
        let log = state.agents.session(id, 0)?;
        let agent::scope::AgentTask::Executive { project } = &log.info.task else { return Err("Only executive conversations are captured here".into()) };
        let busy = matches!(log.info.status, agent::events::Status::Running | agent::events::Status::Waiting);
        let Some((window, later)) = executive::session_window(covered, &log.events, again, busy) else { break };
        again = false;
        let title = if later { format!("{} (continued after an earlier capture)", log.info.title) } else { log.info.title.clone() };
        let part = &window[..executive::transcript_fits(&title, window)];
        let upto = part.last().map(|e| e.seq);
        let source = executive::Source { kind: "agent-session".into(), label: log.info.title.clone(), session: Some(id.to_string()), upto };
        let text = executive::transcript(&title, part);
        let staged = executive::extract(&executive::viewer(&state.bridge), &state.executive, &exec_deps(&state, &saved)?, &text, project.as_deref(), source, today())?;
        let _ = app.emit("executive-changed", "capture");
        first = first.or(staged);
        // Saved even when the part yielded nothing, so it is not paid for again; an error above leaves it unchanged.
        if let Some(upto) = upto {
            state.executive.set_capture_cursor(id, upto)?;
        }
        covered = upto;
    }
    Ok(first)
}

#[tauri::command]
async fn exec_session_capture(app: AppHandle, id: String) -> Result<Option<Value>, String> {
    blocking(move || capture_session(&app, &id, true)).await
}

/// When an executive conversation ends, what it decided and committed to goes to the capture inbox for review.
fn executive_reports(app: AppHandle) -> conductor::Handler {
    Box::new(move |report| {
        let agent::Lifecycle::Finished { id, .. } = report else { return };
        let Some(state) = app.try_state::<AppState>() else { return };
        if !state.agents.session(id, u64::MAX).is_ok_and(|log| matches!(log.info.task, agent::scope::AgentTask::Executive { .. })) {
            return;
        }
        let (app, id) = (app.clone(), id.clone());
        std::thread::spawn(move || {
            match capture_session(&app, &id, false) {
                Ok(Some(_)) => notify::session(&app, &id, "Executive assistant", "What this conversation decided is ready to review in Executive"),
                Ok(None) => {}
                Err(e) => notify::session(&app, &id, "Executive assistant", &format!("Could not capture what this conversation decided ({e}). Capture it again from the conversation.")),
            }
        });
    })
}

const EXPORT_KINDS: [(&str, &str); 3] = [("md", "Markdown"), ("txt", "Plain text"), ("eml", "Email message")];

/// Save a draft or a briefing where the user picks. `format` is md, txt or eml; the content is written as given.
#[tauri::command]
async fn exec_export(app: AppHandle, name: String, format: String, content: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (ext, label) = EXPORT_KINDS.into_iter().find(|(e, _)| *e == format).ok_or_else(|| format!("Unknown export format: {format}"))?;
    blocking(move || {
        let stem: String = name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '-' }).collect();
        let stem: String = stem.trim().chars().take(80).collect();
        let file = format!("{}.{ext}", if stem.is_empty() { "draft" } else { &stem });
        let Some(picked) = app.dialog().file().add_filter(label, &[ext]).set_file_name(file).blocking_save_file() else { return Ok(None) };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
        Ok(Some(path.display().to_string()))
    })
    .await
}

/// Toasts for chat sessions: waiting for an approval, a finished turn, a finished background session. A terminal session
/// has its own, from the terminal's signals.
fn session_notices(app: AppHandle) -> conductor::Handler {
    Box::new(move |report| {
        let Some(text) = notify::session_text(report) else { return };
        let Some(state) = app.try_state::<AppState>() else { return };
        let Ok(info) = state.agents.info(report.id()) else { return };
        if info.interface == agent::Interface::Chat {
            notify::session(&app, &info.id, info.name.as_deref().unwrap_or(&info.title), text);
        }
    })
}

/// Hook mode (`--hivemind-signal <event>`): Some(exit code) when this run is a hook, which opens no window.
pub fn hook_main(args: &[String]) -> Option<i32> {
    term::signal::hook_main(args)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = capture::show_capture(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            let drafts_dir = app.path().app_data_dir()?.join("drafts");
            let sessions_dir = app.path().app_data_dir()?.join("agent-sessions");
            let worktrees_dir = app.path().app_data_dir()?.join("worktrees");
            let terminals_dir = app.path().app_data_dir()?.join("terminals");
            let snapshots_dir = architecture::snapshots_root(&sessions_dir);
            let saved = settings::load(&settings_path);
            let launch = settings::resolve(&saved, |k| std::env::var(k).ok());
            // A taken or invalid hotkey must not stop the app; the settings screen shows why.
            let shortcut_error = capture::apply_shortcut(app.handle(), saved.capture_shortcut().as_deref()).err();
            if let Err(e) = capture::tray(app.handle()) {
                eprintln!("Hivemind: no tray icon ({e})");
            }
            let events = app.handle().clone();
            let exits = app.handle().clone();
            let (reports, report_queue) = conductor::queue();
            let agents = agent::Manager::new(
                sessions_dir,
                Arc::new(agent::claude::ClaudeCode),
                Arc::new(agent::codex::Codex),
                Arc::new(move |emit| {
                    let _ = match emit {
                        agent::Emit::Event(event) => events.emit("agent-event", event),
                        agent::Emit::SessionsChanged => events.emit("agent-sessions-changed", ()),
                        agent::Emit::Lifecycle(report) => {
                            let _ = reports.send(report);
                            Ok(())
                        }
                    };
                }),
            );
            let terminals = term::Manager::new(
                terminals_dir.clone(),
                agents.clone(),
                settings_path.clone(),
                Arc::new(move |emit| {
                    match emit {
                        term::Emit::Exit(exit) => {
                            let _ = exits.emit("term-exit", exit);
                        }
                        term::Emit::Attention { id, kind, title } => {
                            let _ = exits.emit("term-attention", TermAttention { id: id.clone(), kind });
                            if let Some(kind) = kind {
                                notify::terminal(&exits, &id, &title, kind);
                            }
                        }
                    }
                }),
            );
            app.manage(AppState {
                bridge: Arc::new(Bridge::new(launch)),
                settings_path,
                drafts_dir,
                worktrees_dir,
                terminals_dir,
                snapshots_dir,
                agents,
                terminals,
                learning: learning::Learning::new(app.path().app_data_dir()?.join("learning")),
                workflows: Arc::new(workflow::Workflows::new(app.path().app_data_dir()?.join("workflows"))),
                automations: Arc::new(automations::Automations::new(app.path().app_data_dir()?)),
                skills: skills::Skills::new(app.path().app_data_dir()?.join("skills"), skills::default_targets()),
                executive: executive::Store::new(app.path().app_data_dir()?.join("executive")),
                capturing: executive::Claims::default(),
                watcher: Mutex::new(None),
                shortcut_error: Mutex::new(shortcut_error),
            });
            conductor::run(report_queue, vec![session_notices(app.handle().clone()), learning_reports(app.handle().clone()), orchestration_reports(app.handle().clone()), executive_reports(app.handle().clone())]);
            {
                let state = app.state::<AppState>();
                state.automations.clone().run_scheduler(Arc::new(AppDoer(app.handle().clone())));
            }
            let (state, sampled) = (app.handle().clone(), app.handle().clone());
            resources::watch(
                move || state.try_state::<AppState>().map(|s| [s.agents.pids(), s.terminals.pids()].concat()).unwrap_or_default(),
                move |usage| {
                    let _ = sampled.emit("agent-resources", usage);
                },
            );
            Ok(())
        })
        // The hidden capture window must not keep the app alive once the main window is really closed.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(true)) {
                notify::on_focus(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            exec_list,
            exec_put,
            exec_delete,
            exec_pack,
            exec_brief,
            exec_draft,
            exec_refine,
            exec_extract,
            exec_learn_style,
            exec_agent_start,
            exec_session_capture,
            exec_export,
            lm, connect, git_activity, system_architecture, system_diagram, system_diagram_source, get_settings, save_settings, capture_status, show_main, app_quit, quit_ack, term_seen, notify_tray, draft_put, draft_get, draft_delete, draft_list,
            agent_available, agent_roles, learning_status, learning_review, skills_list, skill_proposals, skill_decide, skill_action, skill_version, skill_history,
            skills_upkeep, skill_from_note, workflow_templates, workflow_list, workflow_create, workflow_edit, workflow_act, workflow_delete, workflow_report,
            automation_list, automation_put, automation_delete, automation_act, architecture_drift, architecture_rules_set, agent_start, agent_send, agent_answer, agent_interrupt, agent_end, agent_files, agent_set_policy, agent_rename, agent_remove_worktree, repo_branches,
            agent_cancel, agent_sessions, agent_session, agent_transcript, agent_usage, review_files, review_file, review_approve, review_stop_and_approve, review_request_changes, review_request_terminal_changes, review_dismiss, review_discard, review_tool_output, review_refresh,
            system_staleness, system_snapshots, system_snapshot, term_open, term_login, term_shell, term_write, term_resize, term_close, term_list, agent_engines, agent_models, folder_pick, folder_forget, cli_history, agent_import, agent_auth_status, wiki_export, wiki_agent_build, wiki_agent_cancel
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // An agent session, a terminal or a wiki build must not outlive the app that started it.
            if let tauri::RunEvent::Exit = event
                && let Some(state) = app.try_state::<AppState>()
            {
                state.agents.stop_all();
                state.terminals.stop_all();
                wiki_build::stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use term::launch::{Cli, NO_CODEX};

    #[test]
    fn engines_report_what_was_found() {
        let claude = engine_info(agent::Engine::Claude, Ok(Cli { program: "C:/x/claude.exe".into(), args: vec![] }));
        assert_eq!(claude.path.as_deref(), Some("C:/x/claude.exe"));
        assert_eq!(claude.error, None);
        assert!(claude.chat);
        assert_eq!(claude.chat_reason, None);

        let codex = engine_info(agent::Engine::Codex, Ok(Cli { program: "node".into(), args: vec!["C:/n/codex.js".into()] }));
        assert_eq!(codex.path.as_deref(), Some("C:/n/codex.js"));
        assert!(codex.chat);
        assert_eq!(codex.chat_reason, None);

        let missing = engine_info(agent::Engine::Codex, Err(NO_CODEX.to_string()));
        assert_eq!(missing.path, None);
        assert_eq!(missing.error.as_deref(), Some(NO_CODEX));
    }

    #[test]
    fn wiki_export_runs_as_main_and_writes_to_the_chosen_path() {
        let argv = |archived, agent, project: Option<&str>, theme: Option<&str>| wiki_export_argv("demo", "C:/x/demo-wiki.html", archived, agent, project, theme);
        assert_eq!(argv(false, false, None, Some("purple")).unwrap(), ["wiki", "--domain", "demo", "--out", "C:/x/demo-wiki.html", "--theme", "purple"]);
        let archived = wiki_export_argv("demo", "p.html", true, false, None, Some("emerald")).unwrap();
        assert_eq!(archived, ["wiki", "--domain", "demo", "--out", "p.html", "--archived", "--theme", "emerald"]);
        assert!(!archived.iter().any(|a| a == "--actor"));
        // The agent edition passes --agent and the project, and has no retired notes to show.
        assert_eq!(
            argv(true, true, Some("core"), Some("emerald-light")).unwrap(),
            ["wiki", "--domain", "demo", "--out", "C:/x/demo-wiki.html", "--agent", "--project", "core", "--theme", "emerald-light"]
        );
        assert_eq!(argv(false, true, None, Some("purple")).unwrap().iter().filter(|a| *a == "--agent").count(), 1);
        // A project only narrows the agent edition.
        assert!(!argv(false, false, Some("core"), Some("purple")).unwrap().iter().any(|a| a == "--project"));
        for theme in ["", "sepia", "Purple", "--out"] {
            assert!(argv(false, false, None, Some(theme)).is_err(), "{theme}");
        }
        // An older Living Memory has no --theme: without one, the flag is not sent.
        assert_eq!(argv(false, false, None, None).unwrap(), ["wiki", "--domain", "demo", "--out", "C:/x/demo-wiki.html"]);
        assert!(!argv(false, true, Some("core"), None).unwrap().iter().any(|a| a == "--theme"));
        assert_eq!(wiki_file_name("sandbox", false, None), "sandbox-wiki.html");
        assert_eq!(wiki_file_name("a b/c", false, None), "a_b_c-wiki.html");
        assert_eq!(wiki_file_name("sandbox", true, None), "sandbox-agent-wiki.html");
        assert_eq!(wiki_file_name("sandbox", true, Some("core x")), "sandbox-core_x-agent-wiki.html");
    }
}
