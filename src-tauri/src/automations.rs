//! Automations: work Hivemind starts on its own, on a schedule or when something happens, while the app runs (the tray
//! keeps it running with the window closed). Each has a trigger, an action and a policy: ask before starting, and which
//! results to report. A scheduled automation whose time passed while the app was closed runs once at the next start.
//! One run per automation at a time; a trigger that fires while it runs is dropped (coalesced).
//!
//! Files under `app_data_dir`: `automations.json` (definitions) and `automation-runs/<id>.json` (the last RUNS_KEPT runs).
use crate::agent::roles::{Profile, Role};
use crate::agent::{now_ms, Engine};
use chrono::{DateTime, Datelike, Duration as Days, Local, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use crate::oneshot::Cancel;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

pub const RUNS_KEPT: usize = 100;
/// How often the scheduler looks for new commits, at most.
pub const POLL: Duration = Duration::from_secs(60);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Trigger {
    /// Every `hours` hours from the last run (or from when it was made).
    Every { hours: u32 },
    /// Each day at `at` minutes after local midnight.
    Daily { at: u32 },
    /// On the given weekdays (0 is Monday) at `at` minutes after local midnight.
    Weekly { days: Vec<u8>, at: u32 },
    /// A session the user started failed.
    SessionFailed,
    /// The user approved a session's edits.
    ReviewApproved,
    /// New commits on the project repository's current branch.
    Commit,
    /// Only when the user runs it.
    Manual,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Action {
    /// Start one unattended session in a role. `{event}` and `{commits}` in the prompt are filled in.
    Role { role: Role, #[serde(default)] engine: Engine, prompt: String },
    /// Start a workflow from a template, unattended.
    Workflow { template: String, goal: String },
    /// Living Memory's own maintenance run (it keeps its own budget and rules).
    MemoryMaintenance,
    /// Propose archiving stale or flagged skills.
    SkillUpkeep,
    /// Review the new commits for knowledge worth keeping; drafts go to Review.
    CommitCapture,
    /// Work out a system's architecture drift (commits since its output, hand edits, structural changes, rule findings).
    ArchitectureCheck { system: String },
    /// Write an executive briefing (`briefing` is weekly, project, priorities, commitments or risks) over the last `days`
    /// days, about the automation's project or all active projects, and keep it on the Executive page.
    ExecutiveBriefing { briefing: String, days: u32 },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Notify {
    All,
    #[default]
    Failures,
    None,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    pub trigger: Trigger,
    pub action: Action,
    /// The project and repository a session, workflow or commit check works on.
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    /// The run waits until the user starts it.
    #[serde(default)]
    pub ask_first: bool,
    #[serde(default)]
    pub notify: Notify,
    /// Each session's Claude budget for a role or workflow action (capped by the settings' session budget).
    #[serde(default)]
    pub budget_usd: Option<f64>,
    pub created_at: u64,
    #[serde(default)]
    pub last_run: Option<u64>,
    /// When a scheduled automation runs next; None for event and manual triggers, and while disabled.
    #[serde(default)]
    pub next_due: Option<u64>,
    /// The commit the last run looked at, for `{commits}` and the commit trigger.
    #[serde(default)]
    pub last_seen: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Waits for the user (ask first).
    Waiting,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub automation: String,
    pub at: u64,
    /// "schedule", "catch_up", "event", "commit" or "manual".
    pub cause: String,
    /// What happened, for `{event}`.
    #[serde(default)]
    pub event: Option<String>,
    pub state: RunState,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub workflow: Option<String>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub ended_at: Option<u64>,
    /// The project and repository an event came from; checked again when a waiting run is approved.
    #[serde(default)]
    pub source: Option<Source>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub project: String,
    pub repo: String,
}

/// Whether an automation set to a project (and repository) hears an event from `source`.
fn hears(a: &Automation, source: &Source) -> bool {
    a.project.as_deref().is_none_or(|p| p == source.project) && a.repo.as_deref().is_none_or(|r| crate::agent::scope::same_path(r, &source.repo))
}

/// What a finished action reports.
#[derive(Clone, Debug, PartialEq)]
pub enum Started {
    /// Done already (maintenance, upkeep, commit capture), with a line for the run list.
    Done { detail: String, cost: Option<f64> },
    /// A session runs; the run ends with the session's turn.
    Session(String),
    /// A workflow runs; the run ends with it.
    Workflow(String),
}

/// What automations need from the rest of the app; tests use a fake.
pub trait Doer: Send + Sync {
    /// Do the action. `cancel` is set when the user cancels the run; an action that takes a while (a briefing) stops on it.
    fn run(&self, automation: &Automation, prompt_vars: &Vars, cancel: &Cancel) -> Result<Started, String>;
    /// The commit the repository's current branch points at.
    fn head(&self, repo: &str) -> Option<String>;
    /// `git log --oneline` of what HEAD has beyond `since` (the reviewed tips), or the last few commits without `since`. An
    /// error is git failing, not an empty history.
    fn log(&self, repo: &str, since: Option<&str>) -> Result<String, String>;
    /// The next commit capture after `reviewed` (the reviewed tips, space-separated, as `last_seen` holds them): the commit
    /// ids to review, oldest first, and the tips to keep once they are (`git::next_batch`). None when git cannot tell.
    fn next_batch(&self, repo: &str, reviewed: &str, limit: usize) -> Option<(Vec<String>, String)>;
    /// Whether today's learning budget has room (commit reviews and briefings; their calls reserve their own share).
    fn budget_left(&self) -> bool;
    /// Whether a session with this budget (None: the settings' cap per agent run) fits in what is left of today's
    /// automation budget. A workflow is checked for one session's budget.
    fn budget_fits(&self, budget_usd: Option<f64>) -> bool;
    /// Count what a session or workflow a run started cost against today's automation budget, once, when it ends.
    fn charge(&self, usd: f64);
    /// Stop a session or workflow that started for a run the user cancelled meanwhile.
    fn stop(&self, started: &Started);
    /// Why the automation may not run on its own now (its engine is hidden), or None. A paused automation is not admitted
    /// and keeps its last seen commit; Run now still tries it and reports the reason.
    fn paused(&self, _automation: &Automation) -> Option<String> {
        None
    }
    fn notify(&self, title: &str, text: &str);
    /// Something changed that the UI shows.
    fn changed(&self);
}

/// The most commits one commit capture reviews. A longer backlog is reviewed oldest first over several runs.
pub const COMMIT_BATCH: usize = 30;

/// The values a role prompt can use.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct Vars {
    pub event: String,
    pub commits: String,
    pub head: Option<String>,
    /// For a commit capture: the exact commits this run reviews, oldest first. None when git could not tell, and the run
    /// reviews the range from `last_seen` instead.
    pub batch: Option<Vec<String>>,
}

pub fn fill(prompt: &str, vars: &Vars) -> String {
    prompt.replace("{event}", vars.event.trim()).replace("{commits}", if vars.commits.trim().is_empty() { "(no new commits)" } else { vars.commits.trim() })
}

/// The next time a scheduled trigger fires strictly after `after` (local time for daily and weekly). None for triggers
/// that are not schedules. `last` is the last run, for `Every`.
pub fn next_due<Tz: TimeZone>(trigger: &Trigger, after: &DateTime<Tz>, last: Option<&DateTime<Tz>>) -> Option<DateTime<Tz>> {
    let at_time = |minutes: u32| NaiveTime::from_hms_opt((minutes / 60).min(23), minutes % 60, 0);
    match trigger {
        Trigger::Every { hours } => {
            let step = Days::hours(i64::from((*hours).max(1)));
            let mut next = last.cloned().unwrap_or_else(|| after.clone()) + step;
            while next <= *after {
                next += step;
            }
            Some(next)
        }
        Trigger::Daily { at } | Trigger::Weekly { at, .. } => {
            let days: Vec<u8> = match trigger {
                Trigger::Weekly { days, .. } if !days.is_empty() => days.clone(),
                Trigger::Weekly { .. } => return None,
                _ => (0..7).collect(),
            };
            let time = at_time(*at)?;
            // Two weeks, so a weekly time that falls in a clock change on its only day still finds the week after.
            (0..=14).find_map(|offset| {
                let day = after.date_naive() + Days::days(offset);
                if !days.contains(&(day.weekday().num_days_from_monday() as u8)) {
                    return None;
                }
                // A local time that does not exist (a clock change) is skipped; an ambiguous one takes the first.
                let candidate = after.timezone().from_local_datetime(&day.and_time(time)).earliest()?;
                (candidate > *after).then_some(candidate)
            })
        }
        _ => None,
    }
}

fn ms_local(ms: u64) -> DateTime<Local> {
    Local.timestamp_millis_opt(ms as i64).single().unwrap_or_else(Local::now)
}

/// "Daily at 09:00", "Every 6 hours", "Mon, Thu at 18:30", "When a session fails".
pub fn trigger_text(trigger: &Trigger) -> String {
    let clock = |m: &u32| format!("{:02}:{:02}", m / 60, m % 60);
    const DAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    match trigger {
        Trigger::Every { hours } => format!("Every {hours} hour{}", if *hours == 1 { "" } else { "s" }),
        Trigger::Daily { at } => format!("Daily at {}", clock(at)),
        Trigger::Weekly { days, at } => format!("{} at {}", days.iter().filter_map(|d| DAYS.get(*d as usize)).copied().collect::<Vec<_>>().join(", "), clock(at)),
        Trigger::SessionFailed => "When a session fails".into(),
        Trigger::ReviewApproved => "When you approve a session's edits".into(),
        Trigger::Commit => "After new commits".into(),
        Trigger::Manual => "Only when run by hand".into(),
    }
}

/// Built-in automations, all off until the user turns one on.
pub fn templates() -> Vec<Automation> {
    let make = |id: &str, name: &str, trigger: Trigger, action: Action, needs_project: bool| Automation {
        id: id.into(), name: name.into(), enabled: false, trigger, action, project: needs_project.then(String::new), repo: None,
        ask_first: false, notify: Notify::Failures, budget_usd: Some(1.0), created_at: 0, last_run: None, next_due: None, last_seen: None,
    };
    vec![
        make("weekly-review", "Weekly code review", Trigger::Weekly { days: vec![0], at: 9 * 60 },
            Action::Role { role: Role::Reviewer, engine: Engine::Claude, prompt: "Review the commits made since the last review:\n{commits}\nReport bugs, risks and missing tests, most serious first.".into() }, true),
        make("nightly-maintenance", "Nightly memory maintenance", Trigger::Daily { at: 2 * 60 }, Action::MemoryMaintenance, false),
        make("weekly-skill-upkeep", "Weekly skill upkeep", Trigger::Weekly { days: vec![6], at: 18 * 60 }, Action::SkillUpkeep, false),
        make("architecture-check", "Weekly architecture drift check", Trigger::Weekly { days: vec![0], at: 8 * 60 }, Action::ArchitectureCheck { system: String::new() }, false),
        make("commit-capture", "Knowledge from new commits", Trigger::Commit, Action::CommitCapture, true),
        make("weekly-briefing", "Weekly leadership briefing", Trigger::Weekly { days: vec![0], at: 7 * 60 },
            Action::ExecutiveBriefing { briefing: "weekly".into(), days: 7 }, false),
        make("health-check", "Daily project health check", Trigger::Daily { at: 8 * 60 },
            Action::Role { role: Role::Tester, engine: Engine::Claude, prompt: "Run the project's allowed test and build commands and report what fails. Do not edit files.".into() }, true),
        make("failure-investigation", "Investigate failed sessions", Trigger::SessionFailed,
            Action::Role { role: Role::Researcher, engine: Engine::Claude, prompt: "{event}\nFind the most likely cause. Read the code and any logs; do not edit files.".into() }, true),
    ]
}

/// Checks a definition before it is saved.
pub fn check(a: &Automation) -> Result<(), String> {
    if a.name.trim().is_empty() {
        return Err("Give the automation a name".into());
    }
    match &a.trigger {
        Trigger::Every { hours } if *hours == 0 => return Err("Run it at least every hour".into()),
        Trigger::Daily { at } | Trigger::Weekly { at, .. } if *at >= 24 * 60 => return Err("Pick a time of day".into()),
        Trigger::Weekly { days, .. } if days.is_empty() || days.iter().any(|d| *d > 6) => return Err("Pick at least one weekday".into()),
        _ => {}
    }
    if a.budget_usd.is_some_and(|b| !b.is_finite() || b <= 0.0) {
        return Err("A run's budget must be more than $0".into());
    }
    let needs_project = matches!(a.action, Action::Role { .. } | Action::Workflow { .. } | Action::CommitCapture) || a.trigger == Trigger::Commit;
    if needs_project && (a.project.as_deref().is_none_or(str::is_empty) || a.repo.as_deref().is_none_or(str::is_empty)) {
        return Err("This automation works on a project: pick the project and repository".into());
    }
    match &a.action {
        Action::Role { prompt, .. } if prompt.trim().is_empty() => Err("Write the session's instructions".into()),
        Action::Workflow { goal, template } if goal.trim().is_empty() || template.trim().is_empty() => Err("Pick a workflow template and write its goal".into()),
        Action::ArchitectureCheck { system } if system.trim().is_empty() => Err("Pick the system to check".into()),
        Action::ExecutiveBriefing { briefing, .. } if !crate::executive::BRIEF_KINDS.contains(&briefing.as_str()) => Err("Pick the kind of briefing".into()),
        Action::ExecutiveBriefing { days, .. } if !(1..=90).contains(days) => Err("A briefing covers 1 to 90 days".into()),
        Action::Role { role: Role::Developer, .. } => Err("An automation may not start a developer: it would edit code with nobody watching. Use a workflow you start yourself.".into()),
        // Turning such an automation off is always allowed.
        Action::Role { role, engine: Engine::Codex, .. } if a.enabled && role.profile() == Profile::EditWorktree =>
            Err(format!("Codex cannot edit files without asking in an unattended session, so it cannot run the {} role here. Pick another role or show Claude Code in Settings.", role.label())),
        _ => Ok(()),
    }
}

pub struct Automations {
    path: PathBuf,
    runs_dir: PathBuf,
    state: Mutex<Vec<Automation>>,
    wake: Condvar,
    /// Set (under the `state` lock) when a definition changes, so the scheduler does not sleep through the change.
    dirty: AtomicBool,
    /// Held while a run is admitted and while a run's row is written, so two triggers at once start one run. A session or
    /// workflow starts without it (that takes seconds); `pending` covers the time before the run knows its child.
    admit: Mutex<()>,
    /// Starts under way and the reports that came for children no run knows yet. Used only while `admit` is held.
    pending: Mutex<Pending>,
    /// Automations the scheduler is firing on another thread.
    busy: Mutex<BTreeSet<String>>,
    /// The cancel switch of each run whose action is under way, by run id.
    cancels: Mutex<HashMap<String, Arc<Cancel>>>,
}

/// Sessions and workflows being started for runs, and the reports that came before their run saved the child's id.
#[derive(Default)]
struct Pending {
    starting: usize,
    early: Vec<Ended>,
}

/// A session or workflow's end, as `finished` is told it.
struct Ended {
    session: Option<String>,
    workflow: Option<String>,
    ok: bool,
    detail: String,
    cost: Option<f64>,
}

impl Ended {
    fn of(&self, row: &RunRow) -> bool {
        (self.session.is_some() && row.session == self.session) || (self.workflow.is_some() && row.workflow == self.workflow)
    }
}

/// An automation the scheduler found due, and why.
pub struct Due {
    pub id: String,
    pub cause: &'static str,
    pub event: Option<String>,
}

/// Ids are made here (a uuid) or by the templates (letters, digits and dashes). Anything else never names a file.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Why a run that spends money may not start now, or None. A session or workflow must fit, with its whole budget, in what
/// is left of today's automation budget; commit reviews and briefings draw on the learning budget.
fn unaffordable(a: &Automation, doer: &dyn Doer) -> Option<String> {
    match a.action {
        Action::Role { .. } | Action::Workflow { .. } if !doer.budget_fits(a.budget_usd) => {
            Some("Today's automation budget has no room left for this run's budget".into())
        }
        Action::CommitCapture | Action::ExecutiveBriefing { .. } if !doer.budget_left() => Some("Today's learning budget is used".into()),
        _ => None,
    }
}

impl Automations {
    pub fn new(app_data: PathBuf) -> Automations {
        let path = app_data.join("automations.json");
        let list: Vec<Automation> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let autos = Automations {
            path, runs_dir: app_data.join("automation-runs"), state: Mutex::new(list), wake: Condvar::new(), dirty: AtomicBool::new(false),
            admit: Mutex::new(()), pending: Mutex::default(), busy: Mutex::new(BTreeSet::new()), cancels: Mutex::new(HashMap::new()),
        };
        autos.recover();
        autos
    }

    /// Sessions do not outlive Hivemind, so a run still marked running at start ended with the app. Waiting runs keep waiting.
    fn recover(&self) {
        for a in self.list() {
            let mut rows = self.runs(&a.id);
            let mut changed = false;
            for row in rows.iter_mut().filter(|r| r.state == RunState::Running) {
                row.state = RunState::Failed;
                row.detail = Some("Hivemind stopped while this ran".into());
                row.ended_at = Some(now_ms());
                changed = true;
            }
            if changed {
                let _ = self.write_runs(&a.id, &rows);
            }
        }
    }

    fn save(&self, list: &[Automation]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = self.path.with_extension("tmp");
        std::fs::write(&temp, serde_json::to_string_pretty(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &self.path).map_err(|e| e.to_string())
    }

    pub fn list(&self) -> Vec<Automation> {
        self.state.lock().unwrap().clone()
    }

    /// Add or replace a definition. Turning on a schedule sets its next time; nothing runs at once.
    pub fn put(&self, mut a: Automation, now: u64) -> Result<Automation, String> {
        check(&a)?;
        let mut list = self.state.lock().unwrap();
        if a.id.is_empty() {
            a.id = uuid::Uuid::new_v4().simple().to_string();
            a.created_at = now;
            // The reviewed commits are the scheduler's to record, never the caller's.
            a.last_seen = None;
        } else if !list.iter().any(|x| x.id == a.id) {
            return Err("Unknown automation".into());
        }
        let old = list.iter().find(|x| x.id == a.id).cloned();
        if let Some(old) = &old {
            a.created_at = old.created_at;
            a.last_run = old.last_run;
            a.last_seen = old.last_seen.clone().filter(|_| old.repo == a.repo);
        }
        let unchanged = old.as_ref().is_some_and(|o| o.enabled && o.trigger == a.trigger);
        a.next_due = if !a.enabled {
            None
        } else if unchanged {
            old.and_then(|o| o.next_due)
        } else {
            next_due(&a.trigger, &ms_local(now), a.last_run.map(ms_local).as_ref()).map(|d| d.timestamp_millis() as u64)
        };
        list.retain(|x| x.id != a.id);
        list.push(a.clone());
        list.sort_by(|x, y| x.name.cmp(&y.name));
        self.save(&list)?;
        self.dirty.store(true, Ordering::SeqCst);
        self.wake.notify_all();
        Ok(a)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut list = self.state.lock().unwrap();
        if !valid_id(id) || !list.iter().any(|a| a.id == id) {
            return Err("Unknown automation".into());
        }
        list.retain(|a| a.id != id);
        self.save(&list)?;
        let _ = std::fs::remove_file(self.runs_dir.join(format!("{id}.json")));
        self.dirty.store(true, Ordering::SeqCst);
        self.wake.notify_all();
        Ok(())
    }

    pub fn runs(&self, id: &str) -> Vec<RunRow> {
        self.read_runs(id, false).unwrap_or_default()
    }

    /// An automation's runs; none when there is no file yet. A file that cannot be read as runs is an error for readers. A
    /// writer (`set_aside`, always under `admit`) renames it, never deletes it, so the next run starts a new history.
    fn read_runs(&self, id: &str, set_aside: bool) -> Result<Vec<RunRow>, String> {
        if !valid_id(id) {
            return Err("Unknown automation".into());
        }
        let path = self.runs_dir.join(format!("{id}.json"));
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(format!("Could not read {}: {e}", path.display())),
        };
        match serde_json::from_slice(&bytes) {
            Ok(rows) => Ok(rows),
            Err(e) if set_aside => {
                let aside = self.runs_dir.join(format!("{id}.json.unreadable-{}", now_ms()));
                std::fs::rename(&path, &aside).map_err(|_| format!("{} is unreadable ({e})", path.display()))?;
                Ok(vec![])
            }
            Err(e) => Err(format!("{} is unreadable ({e})", path.display())),
        }
    }

    fn write_runs(&self, id: &str, rows: &[RunRow]) -> Result<(), String> {
        if !valid_id(id) {
            return Err("Unknown automation".into());
        }
        std::fs::create_dir_all(&self.runs_dir).map_err(|e| e.to_string())?;
        let path = self.runs_dir.join(format!("{id}.json"));
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, serde_json::to_string_pretty(rows).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    }

    /// Every automation's runs, newest first.
    pub fn all_runs(&self) -> Vec<RunRow> {
        let mut all: Vec<RunRow> = self.list().iter().flat_map(|a| self.runs(&a.id)).collect();
        all.sort_by_key(|r| std::cmp::Reverse(r.at));
        all
    }

    fn put_run(&self, row: &RunRow) -> Result<(), String> {
        let mut rows = self.read_runs(&row.automation, true)?;
        rows.retain(|r| r.id != row.id);
        rows.insert(0, row.clone());
        rows.sort_by_key(|r| std::cmp::Reverse(r.at));
        rows.truncate(RUNS_KEPT);
        self.write_runs(&row.automation, &rows)
    }

    fn find_run(&self, run: &str) -> Option<RunRow> {
        self.all_runs().into_iter().find(|r| r.id == run)
    }

    /// Fire an automation. Returns the new run, or None when one is already waiting or running (coalesced), or when the
    /// automation is gone.
    pub fn fire(&self, id: &str, cause: &str, event: Option<String>, doer: &dyn Doer) -> Option<RunRow> {
        self.fire_from(id, cause, event, None, doer)
    }

    fn fire_from(&self, id: &str, cause: &str, event: Option<String>, source: Option<Source>, doer: &dyn Doer) -> Option<RunRow> {
        let admit = self.admit.lock().unwrap();
        let a = self.list().into_iter().find(|a| a.id == id)?;
        let now = now_ms();
        let scheduled = matches!(cause, "schedule" | "catch_up");
        // The definition may have changed while this occurrence waited: turned off, moved, or pointed at another project.
        if (cause != "manual" && !a.enabled)
            || (scheduled && a.next_due.is_none_or(|due| due > now))
            || source.as_ref().is_some_and(|s| !hears(&a, s))
        {
            return None;
        }
        if cause != "manual" && doer.paused(&a).is_some() {
            if scheduled {
                self.skip_due(id, now);
                doer.changed();
            }
            return None;
        }
        if self.runs(id).iter().any(|r| matches!(r.state, RunState::Waiting | RunState::Running)) {
            // The occurrence is used up, so the scheduler does not come back for it before the next one.
            if scheduled {
                self.skip_due(id, now);
            }
            return None;
        }
        let mut row = RunRow {
            id: uuid::Uuid::new_v4().simple().to_string(), automation: id.into(), at: now, cause: cause.into(), event,
            state: RunState::Running, detail: None, session: None, workflow: None, cost_usd: None, ended_at: None, source,
        };
        // The schedule moves on whether or not this run goes ahead, so a refused run is not retried every minute.
        self.mark_ran(id, now, None);
        if let Some(why) = unaffordable(&a, doer) {
            row.state = RunState::Failed;
            row.detail = Some(why);
            row.ended_at = Some(now);
        } else if a.ask_first && cause != "manual" {
            row.state = RunState::Waiting;
            doer.notify(&a.name, "Waiting for you to start it (Workflows, Automations)");
        }
        if let Err(e) = self.put_run(&row) {
            // Without its row nothing could cancel the run or see it end, so it does not start.
            doer.notify(&a.name, &format!("Could not record the run: {e}"));
            return None;
        }
        if row.state == RunState::Running {
            row = self.execute(&a, row, doer, admit);
        } else {
            drop(admit);
            if row.state == RunState::Failed {
                self.report(&a, &row, doer);
            }
        }
        doer.changed();
        Some(row)
    }

    /// Start a run that waited for the user.
    pub fn approve(&self, run: &str, doer: &dyn Doer) -> Result<RunRow, String> {
        let admit = self.admit.lock().unwrap();
        let row = self.find_run(run).ok_or("Unknown run")?;
        if row.state != RunState::Waiting {
            return Err("This run is not waiting".into());
        }
        let a = self.list().into_iter().find(|a| a.id == row.automation).ok_or("The automation was removed")?;
        if row.source.as_ref().is_some_and(|s| !hears(&a, s)) {
            let row = RunRow { state: RunState::Cancelled, detail: Some("The automation now points at another project".into()), ended_at: Some(now_ms()), ..row };
            self.put_run(&row)?;
            return Err("The automation now points at another project, so this run was cancelled".into());
        }
        if let Some(why) = unaffordable(&a, doer) {
            return Err(why);
        }
        let row = RunRow { state: RunState::Running, ..row };
        self.put_run(&row)?;
        let row = self.execute(&a, row, doer, admit);
        doer.changed();
        Ok(row)
    }

    /// Cancel a waiting run, or mark a running one cancelled (the caller stops its session or workflow).
    pub fn cancel(&self, run: &str) -> Result<RunRow, String> {
        let _admit = self.admit.lock().unwrap();
        let mut row = self.find_run(run).ok_or("Unknown run")?;
        if !matches!(row.state, RunState::Waiting | RunState::Running) {
            return Err("This run has ended".into());
        }
        row.state = RunState::Cancelled;
        row.ended_at = Some(now_ms());
        // An action under way is told to stop only once the cancel is saved, and one that has already kept its result (a
        // saved briefing) is not cancelled after the fact.
        let switch = self.cancels.lock().unwrap().get(run).cloned();
        match switch {
            Some(switch) if !switch.cancel(|| self.put_run(&row))? => Err("This run has ended".into()),
            Some(_) => Ok(row),
            None => self.put_run(&row).map(|()| row),
        }
    }

    /// Move an automation's next time on without counting a run.
    fn skip_due(&self, id: &str, now: u64) {
        let mut list = self.state.lock().unwrap();
        if let Some(a) = list.iter_mut().find(|a| a.id == id) {
            a.next_due = next_due(&a.trigger, &ms_local(now), Some(&ms_local(now))).map(|d| d.timestamp_millis() as u64);
        }
        let _ = self.save(&list);
    }

    fn mark_ran(&self, id: &str, now: u64, seen: Option<String>) {
        let mut list = self.state.lock().unwrap();
        if let Some(a) = list.iter_mut().find(|a| a.id == id) {
            a.last_run = Some(now);
            if seen.is_some() {
                a.last_seen = seen;
            }
            if a.enabled {
                a.next_due = next_due(&a.trigger, &ms_local(now), Some(&ms_local(now))).map(|d| d.timestamp_millis() as u64);
            }
        }
        let _ = self.save(&list);
    }

    /// Do a run's action, without the lock: the git reads for its prompt, and the action itself, which may start a session
    /// or workflow (seconds) or take minutes. A child that ends before the run has saved its id leaves its report in
    /// `pending`, and the run takes it up once the id is saved. A cancel that came meanwhile wins, and a child started for
    /// a cancelled run is stopped.
    fn execute(&self, a: &Automation, mut row: RunRow, doer: &dyn Doer, admit: MutexGuard<'_, ()>) -> RunRow {
        // Registered while `admit` is held, so a cancel (which takes it) always finds the flag.
        let cancel = Arc::new(Cancel::default());
        self.cancels.lock().unwrap().insert(row.id.clone(), cancel.clone());
        let starts = matches!(a.action, Action::Role { .. } | Action::Workflow { .. });
        if starts {
            self.pending.lock().unwrap().starting += 1;
        }
        drop(admit);
        let repo = a.repo.clone().unwrap_or_default();
        let head = (!repo.is_empty()).then(|| doer.head(&repo)).flatten();
        // A commit capture reviews at most COMMIT_BATCH commits, oldest first, and `last_seen` then covers exactly those (as
        // tips); the trigger sees HEAD not yet covered and the next run takes the rest. Without an answer from git the run
        // fails (doer.run sees no batch) and the tips stay as they are.
        let commit_capture = matches!(a.action, Action::CommitCapture) && a.last_seen.is_some() && head.is_some();
        let batch = if commit_capture { doer.next_batch(&repo, a.last_seen.as_deref().unwrap_or_default(), COMMIT_BATCH) } else { None };
        let seen = if commit_capture { batch.as_ref().map(|(_, tips)| tips.clone()) } else { head.clone() };
        let vars = Vars {
            event: row.event.clone().unwrap_or_default(),
            commits: if repo.is_empty() { String::new() } else { doer.log(&repo, a.last_seen.as_deref()).unwrap_or_default() },
            head: head.clone(),
            batch: batch.map(|(commits, _)| commits),
        };
        // A run cancelled during the reads starts nothing.
        if starts {
            let _admit = self.admit.lock().unwrap();
            if let Some(cancelled) = self.find_run(&row.id).filter(|r| r.state == RunState::Cancelled) {
                self.cancels.lock().unwrap().remove(&row.id);
                self.start_done();
                return cancelled;
            }
        }
        let outcome = doer.run(a, &vars, &cancel);
        let child = match &outcome {
            Ok(started @ (Started::Session(_) | Started::Workflow(_))) if starts => Some(started.clone()),
            _ => None,
        };
        match outcome {
            Ok(Started::Done { detail, cost }) => {
                row.state = RunState::Succeeded;
                row.detail = Some(detail);
                row.cost_usd = cost;
                row.ended_at = Some(now_ms());
            }
            Ok(Started::Session(id)) => {
                row.session = Some(id);
                row.detail = Some("Session running".into());
            }
            Ok(Started::Workflow(id)) => {
                row.workflow = Some(id);
                row.detail = Some("Workflow running".into());
            }
            Err(e) => {
                row.state = RunState::Failed;
                row.detail = Some(e);
                row.ended_at = Some(now_ms());
            }
        }
        let admit = self.admit.lock().unwrap();
        // Dropped only now, under `admit`: until the run's end is saved, a cancel still finds the switch and so learns whether
        // the action kept its result.
        self.cancels.lock().unwrap().remove(&row.id);
        if let Some(cancelled) = self.find_run(&row.id).filter(|r| r.state == RunState::Cancelled) {
            let Some(child) = child else {
                if starts {
                    self.start_done();
                }
                return cancelled;
            };
            // The cancel came while the child started, so nobody stopped it: the cancelled run keeps the child's id, so
            // its cost is still counted when it ends, and the child is stopped.
            let kept = RunRow { session: row.session, workflow: row.workflow, ..cancelled };
            let _ = self.put_run(&kept);
            let (kept, ended) = self.take_early(kept, doer);
            self.start_done();
            drop(admit);
            if !ended {
                doer.stop(&child);
            }
            return kept;
        }
        if seen.is_some() && row.state != RunState::Failed {
            self.mark_ran(&a.id, row.at, seen);
        }
        let _ = self.put_run(&row);
        if starts {
            row = self.take_early(row, doer).0;
            self.start_done();
        }
        drop(admit);
        if row.ended_at.is_some() {
            self.report(a, &row, doer);
        }
        row
    }

    /// A start is over. With none left under way, a report still waiting belongs to no run. Call with `admit` held.
    fn start_done(&self) {
        let mut pending = self.pending.lock().unwrap();
        pending.starting -= 1;
        if pending.starting == 0 {
            pending.early.clear();
        }
    }

    /// Apply the report of `row`'s child if it came before the row was saved with the child's id; also whether there was
    /// one. Call with `admit` held.
    fn take_early(&self, row: RunRow, doer: &dyn Doer) -> (RunRow, bool) {
        let ended = {
            let mut pending = self.pending.lock().unwrap();
            let at = pending.early.iter().position(|e| e.of(&row));
            at.map(|at| pending.early.remove(at))
        };
        match ended {
            Some(e) => (self.close(row, e, doer), true),
            None => (row, false),
        }
    }

    /// Write a run's end from its child's report and count the child's cost. A run the user cancelled stays cancelled but
    /// still records what its child cost. Call with `admit` held.
    fn close(&self, mut row: RunRow, ended: Ended, doer: &dyn Doer) -> RunRow {
        let cost = ended.cost.unwrap_or(0.0);
        if row.state == RunState::Cancelled {
            row.cost_usd = Some(cost);
        } else {
            row.state = if ended.ok { RunState::Succeeded } else { RunState::Failed };
            row.detail = Some(ended.detail);
            row.cost_usd = ended.cost;
            row.ended_at = Some(now_ms());
        }
        let _ = self.put_run(&row);
        doer.charge(cost);
        row
    }

    fn report(&self, a: &Automation, row: &RunRow, doer: &dyn Doer) {
        let failed = matches!(row.state, RunState::Failed);
        if a.notify == Notify::All || (a.notify == Notify::Failures && failed) {
            let text = row.detail.clone().unwrap_or_else(|| if failed { "Failed".into() } else { "Finished".into() });
            doer.notify(&a.name, &text);
        }
    }

    /// A session or workflow a run started has ended. Returns the run it ended, once, and counts its cost (`Doer::charge`)
    /// once; None when no run has it yet. A report that comes while a start is under way may be that child's, so it is kept
    /// for the run to take up once it has saved the child's id.
    pub fn finished(&self, session: Option<&str>, workflow: Option<&str>, ok: bool, detail: String, cost: Option<f64>, doer: &dyn Doer) -> Option<RunRow> {
        let admit = self.admit.lock().unwrap();
        let ended = Ended { session: session.map(String::from), workflow: workflow.map(String::from), ok, detail, cost };
        let found = self.all_runs().into_iter().find(|r| {
            let open = r.state == RunState::Running || (r.state == RunState::Cancelled && r.cost_usd.is_none());
            open && ended.of(r)
        });
        let Some(row) = found else {
            let mut pending = self.pending.lock().unwrap();
            if pending.starting > 0 && !pending.early.iter().any(|e| e.session == ended.session && e.workflow == ended.workflow) {
                pending.early.push(ended);
            }
            return None;
        };
        let cancelled = row.state == RunState::Cancelled;
        let row = self.close(row, ended, doer);
        drop(admit);
        if !cancelled && let Some(a) = self.list().into_iter().find(|a| a.id == row.automation) {
            self.report(&a, &row, doer);
        }
        doer.changed();
        Some(row)
    }

    /// Fire the automations an event trigger matches. An automation set to a project (and repository) hears only events from
    /// there, so one project's errors and titles never reach another project's session.
    pub fn on_event(&self, trigger: &Trigger, project: &str, repo: &str, event: String, doer: &dyn Doer) {
        let source = Source { project: project.into(), repo: repo.into() };
        let ids: Vec<String> = self.list().into_iter().filter(|a| a.enabled && &a.trigger == trigger && hears(a, &source)).map(|a| a.id).collect();
        for id in ids {
            self.fire_from(&id, "event", Some(event.clone()), Some(source.clone()), doer);
        }
    }

    /// One pass of the scheduler on this thread, for tests: run what is due and return how long to sleep. The app's scheduler
    /// uses `due` and fires on other threads instead.
    #[cfg(test)]
    pub fn tick(&self, now: u64, check_commits: bool, doer: &dyn Doer) -> Duration {
        for d in self.due(now, check_commits, doer) {
            self.fire(&d.id, d.cause, d.event, doer);
        }
        self.wait()
    }

    /// What is due now (once, however many times it was missed) and which commit triggers saw new commits. Skips automations
    /// the scheduler is still firing.
    pub fn due(&self, now: u64, check_commits: bool, doer: &dyn Doer) -> Vec<Due> {
        let busy = self.busy.lock().unwrap().clone();
        let mut out = vec![];
        for a in self.list().iter().filter(|a| a.enabled && !busy.contains(&a.id)) {
            if let Some(due) = a.next_due.filter(|due| *due <= now) {
                let cause = if now.saturating_sub(due) > POLL.as_millis() as u64 * 2 { "catch_up" } else { "schedule" };
                out.push(Due { id: a.id.clone(), cause, event: None });
                continue;
            }
            if check_commits && a.trigger == Trigger::Commit
                && let Some(repo) = a.repo.as_deref()
                && let Some(head) = doer.head(repo)
            {
                match a.last_seen.as_deref() {
                    // The first look only remembers where the branch is.
                    None => self.mark_seen(&a.id, head),
                    // `last_seen` holds the reviewed tips; HEAD among them, or nothing HEAD has beyond them, is caught up.
                    Some(seen) if !seen.split_whitespace().any(|tip| tip == head) => match doer.log(repo, Some(seen)) {
                        Ok(log) if log.trim().is_empty() => {}
                        Ok(log) => out.push(Due { id: a.id.clone(), cause: "commit", event: Some(format!("New commits:\n{log}")) }),
                        // Git failing is not "nothing new". A commit capture runs, fails visibly and keeps its reviewed
                        // commits; any other action (a paid role or workflow) waits for a check that works.
                        Err(e) if matches!(a.action, Action::CommitCapture) => {
                            out.push(Due { id: a.id.clone(), cause: "commit", event: Some(format!("New commits (git could not list them: {e})")) })
                        }
                        Err(_) => {}
                    },
                    _ => {}
                }
            }
        }
        out
    }

    /// How long the scheduler may sleep: until the next due time, at most POLL, at least a second.
    fn wait(&self) -> Duration {
        let busy = self.busy.lock().unwrap().clone();
        let next = self.list().iter().filter(|a| a.enabled && !busy.contains(&a.id)).filter_map(|a| a.next_due).min();
        let until = next.map(|due| Duration::from_millis(due.saturating_sub(now_ms()))).unwrap_or(POLL);
        until.min(POLL).max(Duration::from_secs(1))
    }

    fn mark_seen(&self, id: &str, head: String) {
        let mut list = self.state.lock().unwrap();
        if let Some(a) = list.iter_mut().find(|a| a.id == id) {
            a.last_seen = Some(head);
        }
        let _ = self.save(&list);
    }

    /// The scheduler loop: sleeps until the next due time or a definition change, at most POLL.
    pub fn run_scheduler(self: std::sync::Arc<Self>, doer: std::sync::Arc<dyn Doer>) {
        std::thread::spawn(move || {
            let mut last_commit_check = 0u64;
            loop {
                let now = now_ms();
                let check_commits = now.saturating_sub(last_commit_check) >= POLL.as_millis() as u64;
                if check_commits {
                    last_commit_check = now;
                }
                // Each due automation fires on its own thread, so a slow one (a commit review, a drift check) delays no other.
                for d in self.due(now, check_commits, doer.as_ref()) {
                    self.busy.lock().unwrap().insert(d.id.clone());
                    let (me, doer) = (self.clone(), doer.clone());
                    std::thread::spawn(move || {
                        me.fire(&d.id, d.cause, d.event, doer.as_ref());
                        me.busy.lock().unwrap().remove(&d.id);
                        let _guard = me.state.lock().unwrap();
                        me.dirty.store(true, Ordering::SeqCst);
                        me.wake.notify_all();
                    });
                }
                let wait = self.wait();
                let guard = self.state.lock().unwrap();
                // A change made since `due` read the definitions sets `dirty` under this lock, so it is never slept through.
                if !self.dirty.swap(false, Ordering::SeqCst) {
                    let _ = self.wake.wait_timeout(guard, wait).unwrap();
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }

    #[test]
    fn schedules_find_their_next_time() {
        // 2026-11-18 is a Wednesday.
        let now = at("2026-11-18T10:30:00+01:00");
        let next = |t: &Trigger| next_due(t, &now, None).map(|d| d.to_rfc3339());
        assert_eq!(next(&Trigger::Daily { at: 9 * 60 }).as_deref(), Some("2026-11-19T09:00:00+01:00"), "today's time has passed");
        assert_eq!(next(&Trigger::Daily { at: 11 * 60 }).as_deref(), Some("2026-11-18T11:00:00+01:00"));
        assert_eq!(next(&Trigger::Weekly { days: vec![0, 4], at: 8 * 60 }).as_deref(), Some("2026-11-20T08:00:00+01:00"), "Friday comes before Monday");
        assert_eq!(next(&Trigger::Weekly { days: vec![2], at: 10 * 60 }).as_deref(), Some("2026-11-25T10:00:00+01:00"), "this Wednesday's time has passed");
        assert_eq!(next(&Trigger::Weekly { days: vec![], at: 0 }), None);
        assert_eq!(next(&Trigger::Every { hours: 6 }).as_deref(), Some("2026-11-18T16:30:00+01:00"));
        let last = at("2026-11-18T01:00:00+01:00");
        assert_eq!(next_due(&Trigger::Every { hours: 4 }, &now, Some(&last)).unwrap().to_rfc3339(), "2026-11-18T13:00:00+01:00", "steps on from the last run");
        assert_eq!(next(&Trigger::Commit), None);
    }

    #[test]
    fn words_for_triggers() {
        assert_eq!(trigger_text(&Trigger::Weekly { days: vec![0, 3], at: 18 * 60 + 30 }), "Mon, Thu at 18:30");
        assert_eq!(trigger_text(&Trigger::Every { hours: 1 }), "Every 1 hour");
        assert_eq!(fill("A {event} B {commits}", &Vars { event: " x ".into(), commits: "".into(), head: None, batch: None }), "A x B (no new commits)");
    }

    #[test]
    fn definitions_are_checked() {
        for t in templates() {
            let mut a = t.clone();
            if a.project.is_some() {
                a.project = Some("p".into());
                a.repo = Some("r".into());
            }
            if matches!(a.action, Action::ArchitectureCheck { .. }) {
                assert!(check(&a).unwrap_err().contains("system"));
                a.action = Action::ArchitectureCheck { system: "pay".into() };
            }
            assert!(check(&a).is_ok(), "{}", a.id);
        }
        let mut a = templates().remove(0);
        assert!(check(&a).unwrap_err().contains("project"));
        a.project = Some("p".into());
        a.repo = Some("r".into());
        a.action = Action::Role { role: Role::Developer, engine: Engine::Claude, prompt: "x".into() };
        assert!(check(&a).unwrap_err().contains("developer"));
        // Codex stops at its first edit with nobody to ask, so an enabled editing role on Codex is refused when saved.
        a.enabled = true;
        a.action = Action::Role { role: Role::Tester, engine: Engine::Codex, prompt: "x".into() };
        assert!(check(&a).unwrap_err().contains("Codex"));
        a.enabled = false;
        assert!(check(&a).is_ok(), "a Codex tester automation can still be turned off");
        a.action = Action::Role { role: Role::Reviewer, engine: Engine::Codex, prompt: "x".into() };
        assert!(check(&a).is_ok());
        a.action = Action::Role { role: Role::Developer, engine: Engine::Claude, prompt: "x".into() };
        a.trigger = Trigger::Weekly { days: vec![9], at: 0 };
        assert!(check(&a).is_err());

        // A briefing needs no project (none means all active projects) and counts against the budget.
        let mut brief = templates().into_iter().find(|t| t.id == "weekly-briefing").unwrap();
        assert!(check(&brief).is_ok());
        assert_eq!(unaffordable(&brief, &Fake { broke: true, ..Default::default() }).as_deref(), Some("Today's learning budget is used"));
        brief.action = Action::ExecutiveBriefing { briefing: "gossip".into(), days: 7 };
        assert!(check(&brief).unwrap_err().contains("kind of briefing"));
        brief.action = Action::ExecutiveBriefing { briefing: "risks".into(), days: 0 };
        assert!(check(&brief).unwrap_err().contains("1 to 90"));
    }

    /// A batch next_batch answers: the commits and the tips after them.
    type Batch = (Vec<String>, String);

    #[derive(Default)]
    struct Fake {
        ran: Mutex<Vec<(String, Vars)>>,
        /// What next_batch answers: unset reviews HEAD alone, Some(None) stands for a git failure.
        batch: Mutex<Option<Option<Batch>>>,
        notes: Mutex<Vec<String>>,
        head: Mutex<Option<String>>,
        /// git log fails.
        log_broken: Mutex<bool>,
        broke: bool,
        session: bool,
        paused: Mutex<bool>,
        /// run waits (up to 10 s) for its cancel flag, then reports whether it saw it.
        slow: bool,
        saw_cancel: AtomicBool,
        /// run commits its result, then takes a moment to finish.
        commits: bool,
        committed: AtomicBool,
        /// run waits (up to 10 s) while this is set, with `inside` set, as a session start that takes a while.
        hold: AtomicBool,
        inside: AtomicBool,
        charged: Mutex<Vec<f64>>,
        stopped: Mutex<Vec<Started>>,
        /// What is left of today's automation budget; None is plenty.
        room: Option<f64>,
    }
    impl Doer for Fake {
        fn run(&self, a: &Automation, vars: &Vars, cancel: &Cancel) -> Result<Started, String> {
            self.ran.lock().unwrap().push((a.id.clone(), vars.clone()));
            if self.hold.load(Ordering::SeqCst) {
                self.inside.store(true, Ordering::SeqCst);
                let start = std::time::Instant::now();
                while self.hold.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(10) {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            if self.slow {
                let start = std::time::Instant::now();
                while !cancel.is_set() && start.elapsed() < Duration::from_secs(10) {
                    std::thread::sleep(Duration::from_millis(10));
                }
                self.saw_cancel.store(cancel.is_set(), Ordering::Relaxed);
                return Err("Cancelled".into());
            }
            if self.commits {
                cancel.commit(|| Ok(()))?;
                self.committed.store(true, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(300));
            }
            if self.session {
                return Ok(Started::Session("s1".into()));
            }
            Ok(Started::Done { detail: "done".into(), cost: Some(0.01) })
        }
        fn head(&self, _repo: &str) -> Option<String> {
            self.head.lock().unwrap().clone()
        }
        fn log(&self, _repo: &str, since: Option<&str>) -> Result<String, String> {
            if *self.log_broken.lock().unwrap() {
                return Err("bad config".into());
            }
            Ok(format!("log since {}", since.unwrap_or("start")))
        }
        fn next_batch(&self, _repo: &str, _reviewed: &str, limit: usize) -> Option<(Vec<String>, String)> {
            assert_eq!(limit, COMMIT_BATCH);
            let head = self.head.lock().unwrap().clone();
            self.batch.lock().unwrap().clone().unwrap_or_else(|| head.map(|h| (vec![h.clone()], h)))
        }
        fn budget_left(&self) -> bool {
            !self.broke
        }
        fn budget_fits(&self, budget_usd: Option<f64>) -> bool {
            !self.broke && budget_usd.unwrap_or(5.0) <= self.room.unwrap_or(f64::MAX)
        }
        fn charge(&self, usd: f64) {
            self.charged.lock().unwrap().push(usd);
        }
        fn stop(&self, started: &Started) {
            self.stopped.lock().unwrap().push(started.clone());
        }
        fn paused(&self, _a: &Automation) -> Option<String> {
            self.paused.lock().unwrap().then(|| "paused".into())
        }
        fn notify(&self, title: &str, text: &str) {
            self.notes.lock().unwrap().push(format!("{title}: {text}"));
        }
        fn changed(&self) {}
    }

    fn store() -> (PathBuf, Automations) {
        let dir = std::env::temp_dir().join(format!("hivemind-automations-{}", uuid::Uuid::new_v4().simple()));
        (dir.clone(), Automations::new(dir))
    }

    fn daily(name: &str) -> Automation {
        Automation { name: name.into(), enabled: true, ..templates().into_iter().find(|t| t.id == "nightly-maintenance").unwrap() }
    }

    #[test]
    fn a_missed_schedule_runs_once_then_moves_on() {
        let (dir, autos) = store();
        let mut a = autos.put(Automation { id: String::new(), ..daily("Nightly") }, now_ms()).unwrap();
        assert!(a.next_due.unwrap() > now_ms());
        // Pretend the app was closed for three days.
        a.next_due = Some(now_ms() - 3 * 86_400_000);
        autos.state.lock().unwrap().iter_mut().for_each(|x| x.next_due = a.next_due);
        let doer = Fake::default();
        autos.tick(now_ms(), false, &doer);
        autos.tick(now_ms(), false, &doer);
        assert_eq!(doer.ran.lock().unwrap().len(), 1, "once, not three times");
        let runs = autos.runs(&a.id);
        assert_eq!((runs.len(), runs[0].cause.as_str(), runs[0].state), (1, "catch_up", RunState::Succeeded));
        assert!(autos.list()[0].next_due.unwrap() > now_ms());
        // Survives a restart.
        assert_eq!(Automations::new(dir.clone()).list(), autos.list());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ask_first_waits_and_overlapping_triggers_coalesce() {
        let (dir, autos) = store();
        let mut def = daily("Asks");
        def.id = String::new();
        def.ask_first = true;
        let a = autos.put(def, now_ms()).unwrap();
        let doer = Fake { session: true, ..Default::default() };
        let row = autos.fire(&a.id, "event", None, &doer).unwrap();
        assert_eq!(row.state, RunState::Waiting);
        assert!(doer.ran.lock().unwrap().is_empty());
        assert!(doer.notes.lock().unwrap()[0].contains("Waiting for you"));
        assert!(autos.fire(&a.id, "event", None, &doer).is_none(), "one run at a time");
        let row = autos.approve(&row.id, &doer).unwrap();
        assert_eq!((row.state, row.session.as_deref()), (RunState::Running, Some("s1")));
        assert!(autos.finished(Some("s1"), None, false, "The session failed".into(), Some(0.2), &doer).is_some());
        assert!(autos.finished(Some("s1"), None, false, "again".into(), Some(0.2), &doer).is_none(), "a run ends once");
        let row = &autos.runs(&a.id)[0];
        assert_eq!((row.state, row.cost_usd), (RunState::Failed, Some(0.2)));
        assert!(doer.notes.lock().unwrap().iter().any(|n| n == "Asks: The session failed"), "failures are reported");
        let next = autos.fire(&a.id, "manual", None, &doer).unwrap();
        assert_eq!(next.state, RunState::Running, "a manual run never asks");
        assert_eq!(autos.cancel(&next.id).unwrap().state, RunState::Cancelled);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_commit_backlog_is_reviewed_oldest_first_in_batches() {   // HIDE-14
        let (dir, autos) = store();
        let def = Automation { id: String::new(), enabled: true, project: Some("p".into()), repo: Some("r".into()), ..templates().into_iter().find(|t| t.id == "commit-capture").unwrap() };
        autos.put(def, now_ms()).unwrap();
        let doer = Fake::default();
        let ids = |r: std::ops::RangeInclusive<u32>| r.map(|n| format!("c{n}")).collect::<Vec<_>>();
        *doer.head.lock().unwrap() = Some("aaa".into());
        autos.tick(now_ms(), true, &doer);
        // 45 commits land; the first run reviews the oldest 30 and the cursor covers those, not HEAD (the old code).
        *doer.head.lock().unwrap() = Some("c45".into());
        *doer.batch.lock().unwrap() = Some(Some((ids(1..=30), "c30".into())));
        autos.tick(now_ms(), true, &doer);
        assert_eq!(doer.ran.lock().unwrap().last().unwrap().1.batch, Some(ids(1..=30)));
        assert_eq!(autos.list()[0].last_seen.as_deref(), Some("c30"));
        // HEAD is not covered yet, so the next tick reviews the rest.
        *doer.batch.lock().unwrap() = Some(Some((ids(31..=45), "c45".into())));
        autos.tick(now_ms(), true, &doer);
        let ran = doer.ran.lock().unwrap().clone();
        assert_eq!((ran.len(), ran[1].1.batch.clone()), (2, Some(ids(31..=45))));
        assert_eq!(autos.list()[0].last_seen.as_deref(), Some("c45"));
        autos.tick(now_ms(), true, &doer);
        assert_eq!(doer.ran.lock().unwrap().len(), 2, "caught up");
        // Several reviewed tips (a merge in progress): HEAD among them is caught up.
        *doer.batch.lock().unwrap() = Some(Some((ids(46..=47), "x9 c47".into())));
        *doer.head.lock().unwrap() = Some("c47".into());
        autos.tick(now_ms(), true, &doer);
        assert_eq!(autos.list()[0].last_seen.as_deref(), Some("x9 c47"));
        autos.tick(now_ms(), true, &doer);
        assert_eq!(doer.ran.lock().unwrap().len(), 3, "c47 is one of the tips");
        // When git cannot say what to review, the reviewed tips stay (Codex review of c8a7ca5: HEAD used to replace them).
        *doer.head.lock().unwrap() = Some("d01".into());
        *doer.batch.lock().unwrap() = Some(None);
        autos.tick(now_ms(), true, &doer);
        assert_eq!(doer.ran.lock().unwrap().last().unwrap().1.batch, None);
        assert_eq!(autos.list()[0].last_seen.as_deref(), Some("x9 c47"));
        // A failed commit check starts a commit capture (it fails visibly) but never a role (Codex re-review of b3f5b40).
        let capture = autos.list()[0].id.clone();
        let role = Automation { id: String::new(), enabled: true, project: Some("p".into()), repo: Some("r".into()),
            action: Action::Role { role: Role::Reviewer, engine: Engine::Claude, prompt: "Review {commits}".into() },
            ..templates().into_iter().find(|t| t.id == "commit-capture").unwrap() };
        let role = autos.put(role, now_ms()).unwrap();
        autos.tick(now_ms(), true, &doer); // the role's first look remembers HEAD
        *doer.head.lock().unwrap() = Some("e01".into());
        *doer.log_broken.lock().unwrap() = true;
        let due: Vec<String> = autos.due(now_ms(), true, &doer).into_iter().map(|d| d.id).collect();
        assert!(due.contains(&capture) && !due.contains(&role.id), "{due:?}");
        *doer.log_broken.lock().unwrap() = false;
        // A new automation never takes the caller's reviewed commits.
        let def = Automation { id: String::new(), enabled: true, project: Some("p".into()), repo: Some("r".into()), last_seen: Some("--output=x".into()), ..templates().into_iter().find(|t| t.id == "commit-capture").unwrap() };
        assert_eq!(autos.put(def, now_ms()).unwrap().last_seen, None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_budget_and_commit_triggers() {
        let (dir, autos) = store();
        let def = Automation { id: String::new(), enabled: true, project: Some("p".into()), repo: Some("r".into()), ..templates().into_iter().find(|t| t.id == "commit-capture").unwrap() };
        let a = autos.put(def, now_ms()).unwrap();
        let doer = Fake::default();
        *doer.head.lock().unwrap() = Some("aaa".into());
        autos.tick(now_ms(), true, &doer);
        assert!(doer.ran.lock().unwrap().is_empty(), "the first look only remembers the head");
        autos.tick(now_ms(), true, &doer);
        assert!(doer.ran.lock().unwrap().is_empty());
        *doer.head.lock().unwrap() = Some("bbb".into());
        autos.tick(now_ms(), true, &doer);
        let ran = doer.ran.lock().unwrap().clone();
        assert_eq!(ran.len(), 1);
        assert_eq!((ran[0].1.commits.as_str(), ran[0].1.head.as_deref()), ("log since aaa", Some("bbb")));
        assert_eq!(autos.list()[0].last_seen.as_deref(), Some("bbb"));
        autos.tick(now_ms(), true, &doer);
        assert_eq!(doer.ran.lock().unwrap().len(), 1, "nothing new");

        // While paused, new commits start nothing, record no run and keep the cursor for later.
        *doer.paused.lock().unwrap() = true;
        *doer.head.lock().unwrap() = Some("ccc".into());
        let rows = autos.runs(&a.id).len();
        autos.tick(now_ms(), true, &doer);
        autos.tick(now_ms(), true, &doer);
        assert_eq!(doer.ran.lock().unwrap().len(), 1);
        assert_eq!(autos.runs(&a.id).len(), rows);
        assert_eq!(autos.list()[0].last_seen.as_deref(), Some("bbb"));
        *doer.paused.lock().unwrap() = false;
        autos.tick(now_ms(), true, &doer);
        assert_eq!(doer.ran.lock().unwrap().last().unwrap().1.commits, "log since bbb");
        assert_eq!(autos.list()[0].last_seen.as_deref(), Some("ccc"));

        let broke = Fake { broke: true, ..Default::default() };
        let row = autos.fire(&a.id, "manual", None, &broke).unwrap();
        assert_eq!(row.state, RunState::Failed);
        assert_eq!(row.detail.as_deref(), Some("Today's learning budget is used"));
        // A commit review draws on the learning budget only: a full automation budget does not stop it.
        let automations_spent = Fake { room: Some(0.0), ..Default::default() };
        *automations_spent.head.lock().unwrap() = Some("ddd".into());
        assert_eq!(autos.fire(&a.id, "manual", None, &automations_spent).unwrap().state, RunState::Succeeded);

        // A session fires only when its whole budget fits in what is left of today's automation budget (R7).
        let role = Automation { id: String::new(), enabled: true, project: Some("p".into()), repo: Some("r".into()), budget_usd: Some(2.0),
            ..templates().into_iter().find(|t| t.id == "failure-investigation").unwrap() };
        let role = autos.put(role, now_ms()).unwrap();
        let tight = Fake { session: true, room: Some(1.5), ..Default::default() };
        let refused = autos.fire(&role.id, "manual", None, &tight).unwrap();
        assert_eq!((refused.state, refused.detail.as_deref()), (RunState::Failed, Some("Today's automation budget has no room left for this run's budget")));
        assert!(!tight.ran.lock().unwrap().iter().any(|(id, _)| *id == role.id), "nothing started");
        let roomy = Fake { session: true, room: Some(2.0), ..Default::default() };
        assert_eq!(autos.fire(&role.id, "manual", None, &roomy).unwrap().state, RunState::Running);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn event_triggers_fire_matching_automations() {
        let (dir, autos) = store();
        let def = Automation { id: String::new(), enabled: true, project: Some("p".into()), repo: Some("r".into()),
            ..templates().into_iter().find(|t| t.id == "failure-investigation").unwrap() };
        autos.put(def, now_ms()).unwrap();
        let doer = Fake::default();
        autos.on_event(&Trigger::ReviewApproved, "p", "r", "x".into(), &doer);
        assert!(doer.ran.lock().unwrap().is_empty());
        autos.on_event(&Trigger::SessionFailed, "other", "C:/other", "A session failed elsewhere".into(), &doer);
        autos.on_event(&Trigger::SessionFailed, "p", "C:/elsewhere", "A session failed in another repository".into(), &doer);
        assert!(doer.ran.lock().unwrap().is_empty(), "another project's or repository's events stay there");
        autos.on_event(&Trigger::SessionFailed, "p", "R/", "A session failed: Fix retries".into(), &doer);
        assert_eq!(doer.ran.lock().unwrap()[0].1.event, "A session failed: Fix retries");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn ids_from_the_webview_never_name_a_file_outside_the_runs_folder() {
        let (dir, autos) = store();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        let outside = Automation { id: "../settings".into(), ..daily("Sneaky") };
        assert_eq!(autos.put(outside, now_ms()).unwrap_err(), "Unknown automation");
        assert_eq!(autos.delete("../settings").unwrap_err(), "Unknown automation");
        assert!(dir.join("settings.json").exists());
        assert!(autos.runs("..\\settings").is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_run_left_running_by_a_restart_ends_and_an_unreadable_history_is_set_aside() {
        let (dir, autos) = store();
        let a = autos.put(Automation { id: String::new(), ..daily("Nightly") }, now_ms()).unwrap();
        let doer = Fake { session: true, ..Default::default() };
        let row = autos.fire(&a.id, "manual", None, &doer).unwrap();
        assert_eq!(row.state, RunState::Running);
        let again = Automations::new(dir.clone());
        let rows = again.runs(&a.id);
        assert_eq!((rows[0].state, rows[0].detail.as_deref()), (RunState::Failed, Some("Hivemind stopped while this ran")));
        assert!(again.fire(&a.id, "manual", None, &doer).is_some(), "the automation runs again");

        std::fs::write(dir.join("automation-runs").join(format!("{}.json", a.id)), b"{ torn \xff").unwrap();
        assert!(again.runs(&a.id).is_empty());
        assert!(dir.join("automation-runs").join(format!("{}.json", a.id)).exists(), "a reader never moves the file");
        assert!(again.fire(&a.id, "manual", None, &doer).is_some());
        let kept = std::fs::read_dir(dir.join("automation-runs")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains("unreadable")).count();
        assert_eq!((kept, again.runs(&a.id).len()), (1, 1), "the torn file is kept aside, not overwritten");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cancelling_a_running_action_stops_it() {   // EXEC-5
        let (dir, autos) = store();
        let a = autos.put(Automation { id: String::new(), ..daily("Briefing") }, now_ms()).unwrap();
        let doer = Fake { slow: true, ..Default::default() };
        let row = std::thread::scope(|s| {
            let fired = s.spawn(|| autos.fire(&a.id, "manual", None, &doer));
            let start = std::time::Instant::now();
            let running = loop {
                if let Some(r) = autos.runs(&a.id).into_iter().find(|r| r.state == RunState::Running) {
                    break r;
                }
                assert!(start.elapsed() < Duration::from_secs(10), "the run never started");
                std::thread::sleep(Duration::from_millis(10));
            };
            assert_eq!(autos.cancel(&running.id).unwrap().state, RunState::Cancelled);
            fired.join().unwrap().unwrap()
        });
        assert!(doer.saw_cancel.load(Ordering::Relaxed), "the action was told to stop");
        assert_eq!(row.state, RunState::Cancelled);
        assert!(autos.cancels.lock().unwrap().is_empty());
        // A run that has kept its result cannot be cancelled after the fact (Codex review of 74bba49).
        let doer = Fake { commits: true, ..Default::default() };
        let row = std::thread::scope(|s| {
            let fired = s.spawn(|| autos.fire(&a.id, "manual", None, &doer));
            let start = std::time::Instant::now();
            while !doer.committed.load(Ordering::Relaxed) {
                assert!(start.elapsed() < Duration::from_secs(10), "the run never committed");
                std::thread::sleep(Duration::from_millis(5));
            }
            let running = autos.runs(&a.id).into_iter().find(|r| r.state == RunState::Running).unwrap();
            assert_eq!(autos.cancel(&running.id).unwrap_err(), "This run has ended");
            fired.join().unwrap().unwrap()
        });
        assert_eq!(row.state, RunState::Succeeded);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_due_occurrence_with_a_run_still_open_is_used_up_and_a_queued_one_rechecks_the_definition() {
        let (dir, autos) = store();
        let a = autos.put(Automation { id: String::new(), ask_first: true, ..daily("Nightly") }, now_ms()).unwrap();
        let doer = Fake { session: true, ..Default::default() };
        let open = autos.fire(&a.id, "manual", None, &doer).unwrap();
        assert_eq!(open.state, RunState::Running);
        autos.state.lock().unwrap()[0].next_due = Some(now_ms() - 1000);
        assert_eq!(autos.due(now_ms(), false, &doer).len(), 1);
        assert!(autos.fire(&a.id, "schedule", None, &doer).is_none(), "a run is still waiting");
        assert!(autos.due(now_ms(), false, &doer).is_empty(), "the scheduler does not come straight back");

        autos.cancel(&open.id).unwrap();
        autos.state.lock().unwrap()[0].next_due = Some(now_ms() - 1000);
        let off = Automation { enabled: false, ..autos.list()[0].clone() };
        autos.put(off, now_ms()).unwrap();
        assert!(autos.fire(&a.id, "schedule", None, &doer).is_none(), "turned off while queued");
        assert!(autos.fire(&a.id, "manual", None, &doer).is_some(), "Run now still runs it");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_waiting_event_run_is_cancelled_when_its_automation_moves_to_another_project() {
        let (dir, autos) = store();
        let def = Automation { id: String::new(), enabled: true, ask_first: true, project: Some("p".into()), repo: Some("r".into()),
            ..templates().into_iter().find(|t| t.id == "failure-investigation").unwrap() };
        let a = autos.put(def, now_ms()).unwrap();
        let doer = Fake { session: true, ..Default::default() };
        autos.on_event(&Trigger::SessionFailed, "p", "r", "secret error text from p".into(), &doer);
        let waiting = autos.runs(&a.id)[0].clone();
        assert_eq!(waiting.state, RunState::Waiting);
        autos.put(Automation { project: Some("q".into()), repo: Some("s".into()), ..autos.list()[0].clone() }, now_ms()).unwrap();
        assert!(autos.approve(&waiting.id, &doer).unwrap_err().contains("another project"));
        assert!(doer.ran.lock().unwrap().is_empty(), "p's event never reaches q");
        assert_eq!(autos.runs(&a.id)[0].state, RunState::Cancelled);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A role automation and a maintenance one, and a doer whose session start is held open until `release`.
    fn starting(dir_autos: &(PathBuf, Automations)) -> (Automation, Automation) {
        let autos = &dir_autos.1;
        let role = Automation { id: String::new(), enabled: true, project: Some("p".into()), repo: Some("r".into()),
            ..templates().into_iter().find(|t| t.id == "failure-investigation").unwrap() };
        (autos.put(role, now_ms()).unwrap(), autos.put(Automation { id: String::new(), ..daily("Nightly") }, now_ms()).unwrap())
    }

    #[track_caller]
    fn wait_until(what: &str, done: impl Fn() -> bool) {
        let start = std::time::Instant::now();
        while !done() {
            assert!(start.elapsed() < Duration::from_secs(10), "timed out: {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_session_start_does_not_hold_up_other_automations() {   // F15
        let store = store();
        let (role, other) = starting(&store);
        let autos = &store.1;
        let doer = Fake { session: true, hold: AtomicBool::new(true), ..Default::default() };
        let row = std::thread::scope(|s| {
            let fired = s.spawn(|| autos.fire(&role.id, "manual", None, &doer));
            wait_until("the start", || doer.inside.load(Ordering::SeqCst));
            // Another automation runs while the session is still starting (it used to wait for the start).
            let free = Fake::default();
            assert_eq!(autos.fire(&other.id, "manual", None, &free).unwrap().state, RunState::Succeeded);
            // A second trigger of the starting automation is still coalesced into its open run.
            assert!(autos.fire(&role.id, "manual", None, &doer).is_none());
            doer.hold.store(false, Ordering::SeqCst);
            fired.join().unwrap().unwrap()
        });
        assert_eq!((row.state, row.session.as_deref()), (RunState::Running, Some("s1")));
        assert_eq!(autos.pending.lock().unwrap().starting, 0);
        let ended = autos.finished(Some("s1"), None, true, "done".into(), Some(0.2), &doer).unwrap();
        assert_eq!((ended.state, ended.cost_usd), (RunState::Succeeded, Some(0.2)));
        assert_eq!(*doer.charged.lock().unwrap(), [0.2]);
        let _ = std::fs::remove_dir_all(&store.0);
    }

    #[test]
    fn a_child_that_ends_before_its_run_knows_it_still_ends_the_run() {   // F15, C1
        let store = store();
        let (role, _) = starting(&store);
        let autos = &store.1;
        let doer = Fake { session: true, hold: AtomicBool::new(true), ..Default::default() };
        let row = std::thread::scope(|s| {
            let fired = s.spawn(|| autos.fire(&role.id, "manual", None, &doer));
            wait_until("the start", || doer.inside.load(Ordering::SeqCst));
            // The session reports before the run has saved its id: nothing matches yet, so the report is kept.
            assert!(autos.finished(Some("s1"), None, false, "It failed".into(), Some(0.4), &doer).is_none());
            // Reports of children no run started are kept only while a start is under way, and once.
            assert!(autos.finished(Some("s1"), None, false, "It failed".into(), Some(0.4), &doer).is_none());
            doer.hold.store(false, Ordering::SeqCst);
            fired.join().unwrap().unwrap()
        });
        assert_eq!((row.state, row.detail.as_deref(), row.cost_usd), (RunState::Failed, Some("It failed"), Some(0.4)));
        assert_eq!(autos.runs(&role.id)[0], row, "saved");
        assert_eq!(*doer.charged.lock().unwrap(), [0.4], "counted once");
        assert!(doer.notes.lock().unwrap().iter().any(|n| n.contains("It failed")), "the failure is reported");
        let pending = autos.pending.lock().unwrap();
        assert_eq!((pending.starting, pending.early.len()), (0, 0));
        drop(pending);
        // With no start under way, a report for no run is not kept.
        assert!(autos.finished(Some("s9"), None, true, "x".into(), None, &doer).is_none());
        assert!(autos.pending.lock().unwrap().early.is_empty());
        let _ = std::fs::remove_dir_all(&store.0);
    }

    #[test]
    fn a_run_cancelled_while_its_session_starts_stops_the_session_and_counts_its_cost() {   // F15, C2
        let store = store();
        let (role, _) = starting(&store);
        let autos = &store.1;
        let doer = Fake { session: true, hold: AtomicBool::new(true), ..Default::default() };
        let row = std::thread::scope(|s| {
            let fired = s.spawn(|| autos.fire(&role.id, "manual", None, &doer));
            wait_until("the start", || doer.inside.load(Ordering::SeqCst));
            let cancelled = autos.cancel(&autos.runs(&role.id)[0].id).unwrap();
            assert_eq!((cancelled.state, cancelled.session.as_deref()), (RunState::Cancelled, None), "nothing to stop yet");
            doer.hold.store(false, Ordering::SeqCst);
            fired.join().unwrap().unwrap()
        });
        assert_eq!((row.state, row.session.as_deref()), (RunState::Cancelled, Some("s1")));
        assert_eq!(*doer.stopped.lock().unwrap(), [Started::Session("s1".into())], "the run stops the session it started");
        assert_eq!(autos.runs(&role.id)[0], row);
        let ended = autos.finished(Some("s1"), None, false, "stopped".into(), Some(0.1), &doer).unwrap();
        assert_eq!((ended.state, ended.cost_usd), (RunState::Cancelled, Some(0.1)));
        assert_eq!(*doer.charged.lock().unwrap(), [0.1]);
        assert_eq!(autos.pending.lock().unwrap().starting, 0);
        let _ = std::fs::remove_dir_all(&store.0);
    }

    #[test]
    fn approval_checks_the_budget_and_a_cancelled_run_still_counts_its_cost() {
        let (dir, autos) = store();
        let def = Automation { id: String::new(), enabled: true, ask_first: true, project: Some("p".into()), repo: Some("r".into()),
            ..templates().into_iter().find(|t| t.id == "failure-investigation").unwrap() };
        let a = autos.put(def, now_ms()).unwrap();
        let rich = Fake { session: true, ..Default::default() };
        let row = autos.fire(&a.id, "event", None, &rich).unwrap();
        assert_eq!(row.state, RunState::Waiting);
        let broke = Fake { session: true, broke: true, ..Default::default() };
        assert!(autos.approve(&row.id, &broke).unwrap_err().contains("budget"));
        // Some of today's budget is left, but not this run's whole $1 (R7).
        let tight = Fake { session: true, room: Some(0.99), ..Default::default() };
        assert_eq!(autos.approve(&row.id, &tight).unwrap_err(), "Today's automation budget has no room left for this run's budget");
        assert_eq!(autos.runs(&a.id)[0].state, RunState::Waiting, "it keeps waiting");
        let row = autos.approve(&row.id, &rich).unwrap();
        assert_eq!(autos.cancel(&row.id).unwrap().state, RunState::Cancelled);
        let ended = autos.finished(Some("s1"), None, false, "stopped".into(), Some(0.3), &rich).unwrap();
        assert_eq!((ended.state, ended.cost_usd), (RunState::Cancelled, Some(0.3)));
        assert!(autos.finished(Some("s1"), None, false, "stopped".into(), Some(0.3), &rich).is_none(), "counted once");
        let _ = std::fs::remove_dir_all(dir);
    }
}
