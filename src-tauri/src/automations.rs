//! Automations: work Hivemind starts on its own, on a schedule or when something happens, while the app runs (the tray
//! keeps it running with the window closed). Each has a trigger, an action and a policy: ask before starting, and which
//! results to report. A scheduled automation whose time passed while the app was closed runs once at the next start.
//! One run per automation at a time; a trigger that fires while it runs is dropped (coalesced).
//!
//! Files under `app_data_dir`: `automations.json` (definitions) and `automation-runs/<id>.json` (the last RUNS_KEPT runs).
use crate::agent::roles::Role;
use crate::agent::{now_ms, Engine};
use chrono::{DateTime, Datelike, Duration as Days, Local, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
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
}

/// What a finished action reports.
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
    fn run(&self, automation: &Automation, prompt_vars: &Vars) -> Result<Started, String>;
    /// The commit the repository's current branch points at.
    fn head(&self, repo: &str) -> Option<String>;
    /// `git log --oneline` from `since` (exclusive) to HEAD, or the last few commits without `since`.
    fn log(&self, repo: &str, since: Option<&str>) -> String;
    /// Whether today's learning and automation budget has room.
    fn budget_left(&self) -> bool;
    fn notify(&self, title: &str, text: &str);
    /// Something changed that the UI shows.
    fn changed(&self);
}

/// The values a role prompt can use.
#[derive(Default, Clone, Debug, PartialEq)]
pub struct Vars {
    pub event: String,
    pub commits: String,
    pub head: Option<String>,
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
            (0..=7).find_map(|offset| {
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
        make("commit-capture", "Knowledge from new commits", Trigger::Commit, Action::CommitCapture, true),
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
        Action::Role { role: Role::Developer, .. } => Err("An automation may not start a developer: it would edit code with nobody watching. Use a workflow you start yourself.".into()),
        _ => Ok(()),
    }
}

pub struct Automations {
    path: PathBuf,
    runs_dir: PathBuf,
    state: Mutex<Vec<Automation>>,
    wake: Condvar,
    /// Held while a run is admitted, so two triggers at once start one run.
    admit: Mutex<()>,
}

impl Automations {
    pub fn new(app_data: PathBuf) -> Automations {
        let path = app_data.join("automations.json");
        let list: Vec<Automation> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Automations { path, runs_dir: app_data.join("automation-runs"), state: Mutex::new(list), wake: Condvar::new(), admit: Mutex::new(()) }
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
        self.wake.notify_all();
        Ok(a)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut list = self.state.lock().unwrap();
        list.retain(|a| a.id != id);
        self.save(&list)?;
        let _ = std::fs::remove_file(self.runs_dir.join(format!("{id}.json")));
        self.wake.notify_all();
        Ok(())
    }

    pub fn runs(&self, id: &str) -> Vec<RunRow> {
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return vec![];
        }
        std::fs::read_to_string(self.runs_dir.join(format!("{id}.json"))).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    /// Every automation's runs, newest first.
    pub fn all_runs(&self) -> Vec<RunRow> {
        let mut all: Vec<RunRow> = self.list().iter().flat_map(|a| self.runs(&a.id)).collect();
        all.sort_by_key(|r| std::cmp::Reverse(r.at));
        all
    }

    fn put_run(&self, row: &RunRow) -> Result<(), String> {
        let mut rows = self.runs(&row.automation);
        rows.retain(|r| r.id != row.id);
        rows.insert(0, row.clone());
        rows.sort_by_key(|r| std::cmp::Reverse(r.at));
        rows.truncate(RUNS_KEPT);
        std::fs::create_dir_all(&self.runs_dir).map_err(|e| e.to_string())?;
        std::fs::write(self.runs_dir.join(format!("{}.json", row.automation)), serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }

    fn find_run(&self, run: &str) -> Option<RunRow> {
        self.all_runs().into_iter().find(|r| r.id == run)
    }

    /// Fire an automation. Returns the new run, or None when one is already waiting or running (coalesced), or when the
    /// automation is gone.
    pub fn fire(&self, id: &str, cause: &str, event: Option<String>, doer: &dyn Doer) -> Option<RunRow> {
        let admit = self.admit.lock().unwrap();
        let a = self.list().into_iter().find(|a| a.id == id)?;
        if self.runs(id).iter().any(|r| matches!(r.state, RunState::Waiting | RunState::Running)) {
            return None;
        }
        let now = now_ms();
        let mut row = RunRow {
            id: uuid::Uuid::new_v4().simple().to_string(), automation: id.into(), at: now, cause: cause.into(), event,
            state: RunState::Running, detail: None, session: None, workflow: None, cost_usd: None, ended_at: None,
        };
        // The schedule moves on whether or not this run goes ahead, so a refused run is not retried every minute.
        self.mark_ran(id, now, None);
        let paid = matches!(a.action, Action::Role { .. } | Action::Workflow { .. } | Action::CommitCapture);
        if paid && !doer.budget_left() {
            row.state = RunState::Failed;
            row.detail = Some("Today's learning and automation budget is used".into());
            row.ended_at = Some(now);
        } else if a.ask_first && cause != "manual" {
            row.state = RunState::Waiting;
            doer.notify(&a.name, "Waiting for you to start it (Workflows, Automations)");
        }
        let _ = self.put_run(&row);
        drop(admit);
        if row.state == RunState::Running {
            row = self.execute(&a, row, doer);
        } else if row.state == RunState::Failed {
            self.report(&a, &row, doer);
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
        let row = RunRow { state: RunState::Running, ..row };
        self.put_run(&row)?;
        drop(admit);
        let row = self.execute(&a, row, doer);
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
        self.put_run(&row)?;
        Ok(row)
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

    fn execute(&self, a: &Automation, mut row: RunRow, doer: &dyn Doer) -> RunRow {
        let repo = a.repo.clone().unwrap_or_default();
        let head = (!repo.is_empty()).then(|| doer.head(&repo)).flatten();
        let vars = Vars {
            event: row.event.clone().unwrap_or_default(),
            commits: if repo.is_empty() { String::new() } else { doer.log(&repo, a.last_seen.as_deref()) },
            head: head.clone(),
        };
        match doer.run(a, &vars) {
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
        if head.is_some() && row.state != RunState::Failed {
            self.mark_ran(&a.id, row.at, head);
        }
        let _ = self.put_run(&row);
        if row.ended_at.is_some() {
            self.report(a, &row, doer);
        }
        row
    }

    fn report(&self, a: &Automation, row: &RunRow, doer: &dyn Doer) {
        let failed = matches!(row.state, RunState::Failed);
        if a.notify == Notify::All || (a.notify == Notify::Failures && failed) {
            let text = row.detail.clone().unwrap_or_else(|| if failed { "Failed".into() } else { "Finished".into() });
            doer.notify(&a.name, &text);
        }
    }

    /// A session or workflow a run started has ended. Returns the run it ended, once; None when no running run had it.
    pub fn finished(&self, session: Option<&str>, workflow: Option<&str>, ok: bool, detail: String, cost: Option<f64>, doer: &dyn Doer) -> Option<RunRow> {
        let admit = self.admit.lock().unwrap();
        let mut row = self.all_runs().into_iter().find(|r| {
            r.state == RunState::Running && ((session.is_some() && r.session.as_deref() == session) || (workflow.is_some() && r.workflow.as_deref() == workflow))
        })?;
        row.state = if ok { RunState::Succeeded } else { RunState::Failed };
        row.detail = Some(detail);
        row.cost_usd = cost;
        row.ended_at = Some(now_ms());
        let _ = self.put_run(&row);
        drop(admit);
        if let Some(a) = self.list().into_iter().find(|a| a.id == row.automation) {
            self.report(&a, &row, doer);
        }
        doer.changed();
        Some(row)
    }

    /// Fire the automations an event trigger matches.
    pub fn on_event(&self, trigger: &Trigger, event: String, doer: &dyn Doer) {
        let ids: Vec<String> = self.list().into_iter().filter(|a| a.enabled && &a.trigger == trigger).map(|a| a.id).collect();
        for id in ids {
            self.fire(&id, "event", Some(event.clone()), doer);
        }
    }

    /// One pass of the scheduler: run what is due (once, however many times it was missed) and check commit triggers.
    /// Returns how long to sleep before the next pass.
    pub fn tick(&self, now: u64, check_commits: bool, doer: &dyn Doer) -> Duration {
        let list = self.list();
        for a in list.iter().filter(|a| a.enabled) {
            if let Some(due) = a.next_due.filter(|due| *due <= now) {
                let cause = if now.saturating_sub(due) > POLL.as_millis() as u64 * 2 { "catch_up" } else { "schedule" };
                self.fire(&a.id, cause, None, doer);
            }
            if check_commits && a.trigger == Trigger::Commit
                && let Some(repo) = a.repo.as_deref()
                && let Some(head) = doer.head(repo)
            {
                match a.last_seen.as_deref() {
                    // The first look only remembers where the branch is.
                    None => self.mark_seen(&a.id, head),
                    Some(seen) if seen != head => {
                        let log = doer.log(repo, Some(seen));
                        self.fire(&a.id, "commit", Some(format!("New commits:\n{log}")), doer);
                    }
                    _ => {}
                }
            }
        }
        let next = self.list().iter().filter(|a| a.enabled).filter_map(|a| a.next_due).min();
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
                let wait = self.tick(now, check_commits, doer.as_ref());
                let guard = self.state.lock().unwrap();
                let _ = self.wake.wait_timeout(guard, wait).unwrap();
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
        assert_eq!(fill("A {event} B {commits}", &Vars { event: " x ".into(), commits: "".into(), head: None }), "A x B (no new commits)");
    }

    #[test]
    fn definitions_are_checked() {
        for t in templates() {
            let mut a = t.clone();
            if a.project.is_some() {
                a.project = Some("p".into());
                a.repo = Some("r".into());
            }
            assert!(check(&a).is_ok(), "{}", a.id);
        }
        let mut a = templates().remove(0);
        assert!(check(&a).unwrap_err().contains("project"));
        a.project = Some("p".into());
        a.repo = Some("r".into());
        a.action = Action::Role { role: Role::Developer, engine: Engine::Claude, prompt: "x".into() };
        assert!(check(&a).unwrap_err().contains("developer"));
        a.trigger = Trigger::Weekly { days: vec![9], at: 0 };
        assert!(check(&a).is_err());
    }

    #[derive(Default)]
    struct Fake {
        ran: Mutex<Vec<(String, Vars)>>,
        notes: Mutex<Vec<String>>,
        head: Mutex<Option<String>>,
        broke: bool,
        session: bool,
    }
    impl Doer for Fake {
        fn run(&self, a: &Automation, vars: &Vars) -> Result<Started, String> {
            self.ran.lock().unwrap().push((a.id.clone(), vars.clone()));
            if self.session {
                return Ok(Started::Session("s1".into()));
            }
            Ok(Started::Done { detail: "done".into(), cost: Some(0.01) })
        }
        fn head(&self, _repo: &str) -> Option<String> {
            self.head.lock().unwrap().clone()
        }
        fn log(&self, _repo: &str, since: Option<&str>) -> String {
            format!("log since {}", since.unwrap_or("start"))
        }
        fn budget_left(&self) -> bool {
            !self.broke
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
        let row = autos.fire(&a.id, "schedule", None, &doer).unwrap();
        assert_eq!(row.state, RunState::Waiting);
        assert!(doer.ran.lock().unwrap().is_empty());
        assert!(doer.notes.lock().unwrap()[0].contains("Waiting for you"));
        assert!(autos.fire(&a.id, "schedule", None, &doer).is_none(), "one run at a time");
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

        let broke = Fake { broke: true, ..Default::default() };
        let row = autos.fire(&a.id, "manual", None, &broke).unwrap();
        assert_eq!(row.state, RunState::Failed);
        assert!(row.detail.unwrap().contains("budget"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn event_triggers_fire_matching_automations() {
        let (dir, autos) = store();
        let def = Automation { id: String::new(), enabled: true, project: Some("p".into()), repo: Some("r".into()),
            ..templates().into_iter().find(|t| t.id == "failure-investigation").unwrap() };
        autos.put(def, now_ms()).unwrap();
        let doer = Fake::default();
        autos.on_event(&Trigger::ReviewApproved, "x".into(), &doer);
        assert!(doer.ran.lock().unwrap().is_empty());
        autos.on_event(&Trigger::SessionFailed, "A session failed: Fix retries".into(), &doer);
        assert_eq!(doer.ran.lock().unwrap()[0].1.event, "A session failed: Fix retries");
        let _ = std::fs::remove_dir_all(dir);
    }
}
