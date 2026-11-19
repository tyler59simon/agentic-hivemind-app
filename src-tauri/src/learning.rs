//! The post-session reviewer: after a chat session's work is judged (or a long session ends), a tool-free Claude call reads a
//! digest of the session and stages what is worth keeping. Memory drafts go to Living Memory's proposal inbox (`propose`),
//! where the user accepts or rejects them; a skill draft goes to Hivemind's skill proposals. Nothing is saved without the
//! user, except a patch to a well-used skill when the user turned that on.
//!
//! Files under `app_data_dir/learning`: `runs.jsonl` (one row per review) and `spend.json` (the daily cap's account).
use crate::agent::events::{clip, RunEvent, SeqEvent, Status};
use crate::agent::scope::AgentTask;
use crate::agent::{now_ms, Interface, ReviewState, SessionInfo};
use crate::skills::{self, Kind, NewProposal, Skills};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The most one review may spend; reserved against the daily cap before the call.
pub const REVIEW_USD: f64 = 0.25;
pub const MODEL: &str = "sonnet";
/// A session that changed no files is reviewed only after this many tool calls.
pub const MIN_TOOL_CALLS: usize = 15;
const DIGEST_CHARS: usize = 24_000;
const TIMEOUT: Duration = Duration::from_secs(300);
const DAY_MS: u64 = 86_400_000;
const MEMORY_TYPES: [&str; 6] = ["knowledge", "decision", "bug", "runbook", "preference", "risk"];

/// Why a review was asked for.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    /// The user approved the session's edits: memory and skills.
    Approved,
    /// The user discarded the edits: memory only (what did not work).
    Dismissed,
    /// The session ended without edits after many tool calls: memory only.
    Finished,
    /// The user asked from the session view.
    Manual,
    /// An automation read new commits (no session).
    Commits,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    /// Living Memory's proposal id.
    pub id: String,
    pub title: String,
}

/// One review: what it was about and what it staged.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub session: String,
    pub title: String,
    pub at: u64,
    pub trigger: Trigger,
    /// "staged", "nothing" or "failed".
    pub state: String,
    #[serde(default)]
    pub memory: Vec<Staged>,
    /// Hivemind's skill proposal id, and the skill's name.
    #[serde(default)]
    pub skill: Option<String>,
    #[serde(default)]
    pub skill_name: Option<String>,
    /// True when the skill patch was applied without asking (the auto-patch setting).
    #[serde(default)]
    pub skill_applied: bool,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
struct Spend {
    day: u64,
    spent: f64,
    /// Calls in flight. A crash leaves its reservation counted for the rest of the day, so it never grants extra allowance.
    reserved: std::collections::BTreeMap<String, f64>,
}

/// The daily cap's account.
pub struct Ledger {
    path: PathBuf,
    lock: Mutex<()>,
}

impl Ledger {
    pub fn new(path: PathBuf) -> Ledger {
        Ledger { path, lock: Mutex::new(()) }
    }

    fn load(&self, now: u64) -> Spend {
        let spend: Spend = std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        if spend.day == now / DAY_MS { spend } else { Spend { day: now / DAY_MS, ..Default::default() } }
    }

    fn save(&self, spend: &Spend) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = self.path.with_extension("tmp");
        std::fs::write(&temp, serde_json::to_string(spend).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &self.path).map_err(|e| e.to_string())
    }

    /// Spent plus reserved today (UTC day).
    pub fn used(&self, now: u64) -> f64 {
        let spend = self.load(now);
        spend.spent + spend.reserved.values().sum::<f64>()
    }

    pub fn reserve(&self, id: &str, usd: f64, cap: f64, now: u64) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        let mut spend = self.load(now);
        let used = spend.spent + spend.reserved.values().sum::<f64>();
        if used + usd > cap + 1e-9 {
            return Err(format!("Today's learning budget is used (${used:.2} of ${cap:.2})"));
        }
        spend.reserved.insert(id.into(), usd);
        self.save(&spend)
    }

    /// Drop a reservation without charging it: the call never started.
    pub fn release(&self, id: &str, now: u64) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        let mut spend = self.load(now);
        spend.reserved.remove(id);
        self.save(&spend)
    }

    /// Replace a reservation with what the call cost; an unknown cost keeps the whole reservation.
    pub fn settle(&self, id: &str, cost: Option<f64>, now: u64) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        let mut spend = self.load(now);
        let reserved = spend.reserved.remove(id).unwrap_or(0.0);
        spend.spent += cost.filter(|c| c.is_finite() && *c >= 0.0).unwrap_or(reserved);
        self.save(&spend)
    }
}

/// Whether a session gets a review for this trigger, and whether it may propose a skill. Only chat sessions keep a log the
/// digest can read. Skills come only from work the user approved.
pub fn wanted(info: &SessionInfo, trigger: Trigger, tool_calls: usize) -> Option<bool> {
    if info.interface != Interface::Chat || !matches!(info.task, AgentTask::Work { .. }) {
        return None;
    }
    let approved = info.review.as_ref().is_some_and(|r| r.state == ReviewState::Approved);
    let files = info.files_changed.as_ref().is_some_and(|t| t.files > 0);
    match trigger {
        Trigger::Approved => Some(true),
        Trigger::Dismissed => Some(false),
        // A session with edits waits for the user's decision.
        Trigger::Finished => (!files && tool_calls >= MIN_TOOL_CALLS).then_some(false),
        Trigger::Manual => Some(approved),
        Trigger::Commits => None,
    }
}

pub fn tool_calls(events: &[SeqEvent]) -> usize {
    events.iter().filter(|e| matches!(e.event, RunEvent::ToolUse { .. })).count()
}

/// A Living Memory write the session already made (so the reviewer does not propose it again).
fn is_capture(command: &str) -> bool {
    let c = command.to_ascii_lowercase();
    (c.contains("alm ") || c.contains("living_memory")) && [" capture", " update ", " propose"].iter().any(|verb| c.contains(verb))
}

/// What the reviewer reads: the session's facts, the conversation with tool calls in short form, what changed, what was
/// already saved, and the skills that exist. Long conversations keep their start and their end.
pub fn digest(info: &SessionInfo, events: &[SeqEvent], skills: &[(String, String)], allow_skill: bool) -> String {
    let mut head = vec![format!("# Session: {}", info.title)];
    head.push(format!("Engine: {}. Status: {:?}. Turns: {}.", info.adapter, info.status, info.turns));
    if let Some(role) = info.role {
        head.push(format!("Role: {}.", role.label()));
    }
    if let AgentTask::Work { project, repo, .. } = &info.task {
        head.push(format!("Project: {project}. Repository: {}.", Path::new(repo).file_name().map_or(repo.clone(), |n| n.to_string_lossy().into())));
    }
    head.push(format!("Review: {}.", match info.review.as_ref().map(|r| r.state) {
        Some(ReviewState::Approved) => "the user approved the edits",
        Some(ReviewState::ChangesRequested) => "the user asked for changes",
        Some(ReviewState::Dismissed) => "the user discarded the edits",
        _ => "not decided",
    }));
    head.push(format!("Skills allowed: {}.", if allow_skill { "yes" } else { "no (use action none)" }));

    let mut lines = vec![];
    let mut captured = vec![];
    let mut files = vec![];
    let mut result = None;
    for event in events {
        match &event.event {
            RunEvent::UserMessage { text, .. } => lines.push(format!("\nUser: {}", clip(text.trim(), 1500))),
            RunEvent::Text { text } if !text.trim().is_empty() => lines.push(format!("Agent: {}", clip(text.trim(), 600))),
            RunEvent::ToolUse { name, summary, .. } => {
                if is_capture(summary) {
                    captured.push(clip(summary, 300));
                }
                lines.push(format!("Tool {name}: {}", clip(summary, 200)));
            }
            RunEvent::ToolResult { ok: false, summary, .. } => lines.push(format!("  failed: {}", clip(summary, 200))),
            RunEvent::Denied { tool, summary } => lines.push(format!("  denied {tool}: {}", clip(summary, 160))),
            RunEvent::FilesChanged { files: changed } => files = changed.clone(),
            RunEvent::TurnFinished { result: Some(r), .. } | RunEvent::Finished { result: Some(r), .. } => result = Some(r.clone()),
            _ => {}
        }
    }
    let mut tail = vec![];
    if !files.is_empty() {
        tail.push("\n## Files changed".to_string());
        tail.extend(files.iter().take(60).map(|f| format!("- {} {} (+{} -{})", f.status, f.path, f.added, f.removed)));
    }
    if let Some(result) = result {
        tail.push(format!("\n## Final reply\n{}", clip(result.trim(), 2000)));
    }
    tail.push("\n## Already captured in the session".into());
    tail.push(if captured.is_empty() { "Nothing.".into() } else { captured.iter().map(|c| format!("- {c}")).collect::<Vec<_>>().join("\n") });
    tail.push("\n## Existing skills".into());
    tail.push(if skills.is_empty() { "None.".into() } else { skills.iter().map(|(n, d)| format!("- {n}: {}", clip(d, 200))).collect::<Vec<_>>().join("\n") });

    let fixed: usize = head.iter().chain(tail.iter()).map(|l| l.len() + 1).sum();
    let room = DIGEST_CHARS.saturating_sub(fixed + 40);
    let mut conversation = lines.join("\n");
    if conversation.len() > room {
        let half = room / 2;
        let start: String = conversation.chars().take(half).collect();
        let end: String = conversation.chars().rev().take(half).collect::<Vec<_>>().into_iter().rev().collect();
        conversation = format!("{start}\n[... the middle of the session is left out ...]\n{end}");
    }
    format!("{}\n\n## Conversation\n{}\n{}", head.join("\n"), conversation, tail.join("\n"))
}

const POLICY: &str = "You review one finished coding-agent session for knowledge worth keeping. You have no tools. Answer only with the JSON the schema asks for.

Memory: propose at most 3 notes that a future session must not get wrong: a verified cause and fix, a constraint the agent hit, a decision with its reason, a non-obvious command. Skip progress reports, what the diff already shows, guesses, and anything listed under \"Already captured in the session\". Each note has a type (knowledge, decision, bug, runbook, preference or risk), a title that states the fact, a summary of one or two sentences, optional sections, and the reason it is worth keeping. Section headings by type: decision \"Why\" and \"Alternatives considered\"; bug \"Cause\", \"Fix\" and \"How to check\"; runbook \"When to use\", \"When not to use\", \"Steps\", \"Check\" and \"Roll back\"; knowledge any heading. An empty list is the expected answer for most sessions.

Skill: only when the session header says skills are allowed and the session shows a procedure that worked and will recur. Prefer action \"patch\" of an existing skill (its exact name, and the full new text) over \"create\". A new skill needs a lowercase-hyphen name, a description that starts with \"Use when\", and a body with the sections \"## When to use\", \"## When not to use\", \"## Steps\" and \"## Check\". \"When not to use\" names the lookalike cases where the steps would be wrong. Otherwise use action \"none\".

Write plainly and briefly. Never include secrets, tokens, passwords or personal data; write <REDACTED> instead.";

pub fn schema() -> Value {
    let text = json!({"type": "string"});
    json!({
        "type": "object", "additionalProperties": false, "required": ["memory", "skill"],
        "properties": {
            "memory": {"type": "array", "maxItems": 3, "items": {
                "type": "object", "additionalProperties": false, "required": ["type", "title", "summary", "sections", "reason"],
                "properties": {
                    "type": {"type": "string", "enum": MEMORY_TYPES}, "title": text, "summary": text, "reason": text,
                    "sections": {"type": "array", "items": {"type": "object", "additionalProperties": false, "required": ["heading", "text"],
                        "properties": {"heading": text, "text": text}}}
                }
            }},
            "skill": {"type": "object", "additionalProperties": false, "required": ["action", "name", "description", "body", "reason"],
                "properties": {"action": {"type": "string", "enum": ["none", "create", "patch"]}, "name": text, "description": text, "body": text, "reason": text}}
        }
    })
}

fn reviewer() -> crate::oneshot::Call<'static> {
    crate::oneshot::Call { who: "The reviewer", model: MODEL, policy: POLICY, schema: schema(), budget_usd: REVIEW_USD }
}

/// The reviewer's command line: print mode, no tools, no plugins, settings, MCP servers or saved session, a cost cap.
#[cfg(test)]
pub fn argv() -> Vec<String> {
    crate::oneshot::argv(&reviewer())
}

#[derive(Deserialize, Debug, Default, PartialEq)]
pub struct MemoryItem {
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub sections: Vec<SectionItem>,
    #[serde(default)]
    pub reason: String,
}

#[derive(Deserialize, Debug, Default, PartialEq)]
pub struct SectionItem {
    pub heading: String,
    pub text: String,
}

#[derive(Deserialize, Debug, Default, PartialEq)]
pub struct SkillItem {
    pub action: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Deserialize, Debug, Default, PartialEq)]
pub struct Answer {
    pub memory: Vec<MemoryItem>,
    pub skill: SkillItem,
}

fn answer_of(value: Result<Value, String>) -> Result<Answer, String> {
    value.and_then(|v| serde_json::from_value::<Answer>(v).map_err(|e| format!("The reviewer's answer did not match the schema: {e}")))
}

/// The CLI's JSON envelope: (answer, cost). A failed call still reports what it cost.
#[cfg(test)]
pub fn parse_envelope(stdout: &str) -> (Result<Answer, String>, Option<f64>) {
    let (value, cost) = crate::oneshot::parse_envelope("The reviewer", stdout);
    (answer_of(value), cost)
}

/// The tags a staged draft needs to be saved later: a `concern/` tag this store's taxonomy has (Living Memory refuses a
/// capture without one, and its default for some types, such as risk, is not in every taxonomy) and the project's tag.
pub struct Tags {
    pub concern: Option<String>,
    pub project: Option<String>,
}

/// Living Memory's default concern for the type, then the type's own name, then knowledge: the first the taxonomy has.
pub fn tags_for(kind: &str, project: &str, known: &[String]) -> Tags {
    let default = match kind {
        "runbook" => "workflow",
        "risk" => "constraint",
        other => other,
    };
    let concern = [default, kind, "knowledge"].into_iter().map(|c| format!("concern/{c}")).find(|t| known.contains(t));
    let project = Some(format!("project/{project}")).filter(|t| known.contains(t)).map(|_| project.to_string());
    Tags { concern, project }
}

/// `propose` arguments for one memory item. Unknown types become knowledge.
pub fn propose_argv(item: &MemoryItem, proposer: &str, domain: Option<&str>, cwd: &str, context: &str, known: &[String], project: &str) -> Vec<String> {
    let kind = if MEMORY_TYPES.contains(&item.kind.as_str()) { item.kind.as_str() } else { "knowledge" };
    let mut argv: Vec<String> = vec!["propose".into(), "--session".into(), proposer.into()];
    match domain {
        Some(d) => argv.extend(["--domain".into(), d.into()]),
        None => argv.extend(["--cwd".into(), cwd.into()]),
    }
    argv.extend(["--type".into(), kind.into(), "--title".into(), clip(item.title.trim(), 120), "--summary".into(), item.summary.trim().into()]);
    for s in item.sections.iter().filter(|s| !s.heading.trim().is_empty() && !s.text.trim().is_empty()) {
        argv.extend(["--section".into(), s.heading.trim().into(), s.text.trim().into()]);
    }
    let tags = tags_for(kind, project, known);
    if let Some(concern) = tags.concern {
        argv.extend(["--concern".into(), concern]);
    }
    if let Some(project) = tags.project {
        argv.extend(["--project".into(), project]);
    }
    argv.extend(["--context".into(), context.into()]);
    argv
}

/// What a review is about: a session, or an automation's commits.
struct Subject {
    key: String,
    title: String,
    project: String,
    repo: String,
    session: Option<String>,
    what: &'static str,
}

/// What the reviewer needs from the rest of the app.
pub struct Deps<'a> {
    pub bridge: &'a crate::bridge::Bridge,
    pub skills: &'a Skills,
    pub claude: String,
    pub daily_usd: f64,
    pub auto_patch: bool,
}

pub struct Learning {
    dir: PathBuf,
    ledger: Ledger,
    /// Sessions being reviewed now, so two triggers never review one session twice.
    busy: Mutex<BTreeSet<String>>,
}

impl Learning {
    pub fn new(dir: PathBuf) -> Learning {
        Learning { ledger: Ledger::new(dir.join("spend.json")), dir, busy: Mutex::new(BTreeSet::new()) }
    }

    pub fn spent_today(&self) -> f64 {
        self.ledger.used(now_ms())
    }

    /// Whether today's budget has room for more paid work.
    pub fn has_budget(&self, cap: f64) -> bool {
        self.ledger.used(now_ms()) < cap
    }

    /// The daily cap's account, shared with the executive workspace's calls.
    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    /// Count what an automation's sessions cost against today's budget.
    pub fn charge(&self, usd: f64) {
        let _ = self.ledger.settle(&format!("charge-{}", uuid::Uuid::new_v4().simple()), Some(usd), now_ms());
    }

    /// Newest first.
    pub fn runs(&self) -> Vec<Run> {
        let mut rows: Vec<Run> =
            std::fs::read_to_string(self.dir.join("runs.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        rows.reverse();
        rows
    }

    /// Reviewed already (a failed review may be tried again by hand).
    pub fn reviewed(&self, session: &str) -> bool {
        self.runs().iter().any(|r| r.session == session && r.state != "failed")
    }

    fn record(&self, run: &Run) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join("runs.jsonl")).map_err(|e| e.to_string())?;
        use std::io::Write;
        writeln!(file, "{}", serde_json::to_string(run).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }

    /// Review one session now (on the calling thread). Returns None when the session does not qualify or is already being
    /// reviewed; the run otherwise, also recorded in runs.jsonl.
    pub fn review(&self, deps: &Deps, info: &SessionInfo, events: &[SeqEvent], trigger: Trigger) -> Option<Run> {
        let allow_skill = wanted(info, trigger, tool_calls(events))?;
        if trigger != Trigger::Manual && self.reviewed(&info.id) {
            return None;
        }
        if !self.busy.lock().unwrap().insert(info.id.clone()) {
            return None;
        }
        let run = self.review_now(deps, info, events, trigger, allow_skill);
        let _ = self.record(&run);
        self.busy.lock().unwrap().remove(&info.id);
        Some(run)
    }

    fn review_now(&self, deps: &Deps, info: &SessionInfo, events: &[SeqEvent], trigger: Trigger, allow_skill: bool) -> Run {
        let AgentTask::Work { project, repo, .. } = &info.task else { unreachable!("wanted() admits work sessions only") };
        let subject = Subject {
            key: info.id.clone(), title: info.name.clone().unwrap_or_else(|| info.title.clone()), project: project.clone(), repo: repo.clone(),
            session: Some(info.id.clone()), what: "session",
        };
        let index: Vec<(String, String)> = deps.skills.list(now_ms()).into_iter().filter(|s| !s.meta.archived).map(|s| (s.meta.name, s.meta.description)).collect();
        self.call(deps, &subject, &digest(info, events, &index, allow_skill), trigger, allow_skill)
    }

    /// Review new commits of a project (the post-commit automation): memory drafts only. `key` names the source in
    /// runs.jsonl and in the drafts' proposer session.
    pub fn review_commits(&self, deps: &Deps, key: &str, title: &str, project: &str, repo: &str, log: &str) -> Run {
        let subject = Subject { key: key.into(), title: title.into(), project: project.into(), repo: repo.into(), session: None, what: "commits" };
        let input = format!("# New commits: {title}
Skills allowed: no (use action none).
Review these commits for knowledge worth keeping.

{}", clip(log, DIGEST_CHARS));
        let run = self.call(deps, &subject, &input, Trigger::Commits, false);
        let _ = self.record(&run);
        run
    }

    /// One reviewer call within the daily cap, then staging of what it proposes.
    fn call(&self, deps: &Deps, subject: &Subject, input: &str, trigger: Trigger, allow_skill: bool) -> Run {
        let mut run = Run {
            session: subject.key.clone(), title: subject.title.clone(), at: now_ms(), trigger, state: "failed".into(),
            memory: vec![], skill: None, skill_name: None, skill_applied: false, cost_usd: None, error: None,
        };
        let reservation = format!("review-{}-{}", subject.key, run.at);
        let (value, cost) = crate::oneshot::run(&deps.claude, &self.dir, &self.ledger, deps.daily_usd, &reservation, &reviewer(), input, TIMEOUT);
        let answer = answer_of(value);
        run.cost_usd = cost;
        let answer = match answer {
            Ok(a) => a,
            Err(e) => {
                run.error = Some(e);
                return run;
            }
        };
        let mut problems = vec![];
        self.stage_memory(deps, subject, &answer.memory, &mut run, &mut problems);
        if allow_skill && answer.skill.action != "none" {
            self.stage_skill(deps, subject, answer.skill, &mut run, &mut problems);
        }
        run.state = if run.memory.is_empty() && run.skill.is_none() { if problems.is_empty() { "nothing" } else { "failed" } } else { "staged" }.into();
        run.error = (!problems.is_empty()).then(|| problems.join("; "));
        run
    }

    fn stage_memory(&self, deps: &Deps, subject: &Subject, items: &[MemoryItem], run: &mut Run, problems: &mut Vec<String>) {
        let (project, repo) = (&subject.project, &subject.repo);
        let domain = crate::git::project_entry(deps.bridge, project).ok()
            .and_then(|p| p.get("charter").and_then(Value::as_str).and_then(|c| c.split_once(':')).map(|(d, _)| d.to_string()));
        let context = format!("Hivemind's review of the {} \"{}\" ({}).", subject.what, run.title, &subject.key[..8.min(subject.key.len())]);
        let known: Vec<String> = deps.bridge.call(&["taxonomy".into(), "--actor".into(), "viewer".into()], None).ok()
            .and_then(|r| r.result.get("tags").and_then(Value::as_array).map(|a| a.iter().filter_map(|t| t.as_str().map(str::to_string)).collect()))
            .unwrap_or_default();
        for item in items.iter().filter(|i| !i.title.trim().is_empty() && !i.summary.trim().is_empty()) {
            let reason = format!("{context} {}", item.reason.trim());
            let argv = propose_argv(item, &format!("hivemind-review-{}", subject.key), domain.as_deref(), repo, &reason, &known, project);
            match deps.bridge.call(&argv, None) {
                Ok(reply) if reply.exit_code == 0 => {
                    let id = reply.result.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                    run.memory.push(Staged { id, title: item.title.trim().into() });
                }
                Ok(reply) => problems.push(format!("Living Memory refused \"{}\": {}", clip(&item.title, 60), reply.error.as_str().unwrap_or(&reply.error.to_string()))),
                Err(e) => problems.push(e),
            }
        }
    }

    fn stage_skill(&self, deps: &Deps, subject: &Subject, skill: SkillItem, run: &mut Run, problems: &mut Vec<String>) {
        let name = if skill.action == "patch" { skill.name.trim().to_string() } else { skills::slug(&skill.name) };
        let kind = if skill.action == "patch" { Kind::Patch } else { Kind::Create };
        let new = NewProposal {
            kind: Some(kind), name: name.clone(), description: skill.description, body: skill.body, reason: skill.reason,
            session: subject.session.clone(), session_title: Some(run.title.clone()), note: None,
        };
        match deps.skills.propose(new, "reviewer") {
            Ok(p) => {
                run.skill = Some(p.id.clone());
                run.skill_name = Some(name.clone());
                if kind == Kind::Patch && deps.auto_patch && deps.skills.trusted(&name, now_ms()) {
                    match deps.skills.decide(&p.id, true, None, "auto", Some("Applied without asking: a patch to a well-used skill".into())) {
                        Ok(_) => run.skill_applied = true,
                        Err(e) => problems.push(format!("The patch to {name} waits for you: {e}")),
                    }
                }
            }
            Err(e) => problems.push(format!("Skill not proposed: {e}")),
        }
    }
}

/// How a lifecycle report maps to a review trigger and a skill outcome.
pub fn on_review_state(state: ReviewState) -> (Option<Trigger>, Option<skills::Outcome>) {
    match state {
        ReviewState::Approved => (Some(Trigger::Approved), Some(skills::Outcome::Approved)),
        ReviewState::Dismissed => (Some(Trigger::Dismissed), Some(skills::Outcome::Dismissed)),
        ReviewState::ChangesRequested => (None, Some(skills::Outcome::ChangesRequested)),
        ReviewState::Pending => (None, None),
    }
}

pub fn on_finished(status: Status) -> (Option<Trigger>, Option<skills::Outcome>) {
    (Some(Trigger::Finished), (status == Status::Failed).then_some(skills::Outcome::Failed))
}

/// Credentials taken out of a reviewer's input before it leaves the machine: private keys, tokens of a known shape,
/// passwords in URLs, and the values of settings named like a secret. A heuristic: it cannot know every secret, and it
/// sometimes removes a harmless value.
pub fn redact(text: &str) -> String {
    redact_tokens(&redact_auth_schemes(&redact_url_passwords(&redact_assignments(&strip_private_keys(text)))))
}

const REMOVED: &str = "[removed]";

/// The credential after `Bearer ` or `Basic ` (as in an Authorization header), whatever its shape: at least 12 characters
/// of a token's alphabet with a digit or punctuation in it, so "Basic authentication" stays.
fn redact_auth_schemes(text: &str) -> String {
    let token = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~' | '+' | '/' | '=');
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let (mut at, mut i) = (0, 0);
    while i < text.len() {
        let rest = &lower[i..];
        let scheme = ["bearer", "basic"].into_iter().find(|s| rest.starts_with(s) && !text[..i].ends_with(|c: char| c.is_ascii_alphanumeric()));
        if let Some(scheme) = scheme {
            let after = i + scheme.len();
            let gap = text[after..].len() - text[after..].trim_start_matches([' ', '\t']).len();
            let start = after + gap;
            let end = start + text[start..].find(|c: char| !token(c)).unwrap_or(text.len() - start);
            let value = &text[start..end];
            // In an Authorization header any credential goes; in prose only one that looks like a token.
            let line = lower[..i].rsplit('\n').next().unwrap_or("");
            let header = line.trim_end().ends_with("authorization:");
            let shaped = value.len() >= 12 && value.chars().any(|c| c.is_ascii_digit() || !c.is_ascii_alphanumeric());
            if gap > 0 && !value.is_empty() && (header || shaped) {
                out.push_str(&text[at..start]);
                out.push_str(REMOVED);
                at = end;
                i = end;
                continue;
            }
        }
        i += text[i..].chars().next().map_or(1, char::len_utf8);
    }
    out.push_str(&text[at..]);
    out
}

fn strip_private_keys(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("-----BEGIN ") {
        let line_end = rest[start..].find('\n').map_or(rest.len(), |i| start + i);
        if !rest[start..line_end].contains("PRIVATE KEY") {
            out.push_str(&rest[..line_end]);
            rest = &rest[line_end..];
            continue;
        }
        out.push_str(&rest[..start]);
        out.push_str("[private key removed]");
        rest = match rest[start..].find("-----END ") {
            Some(end) => {
                let tail = &rest[start + end + "-----END ".len()..];
                tail.find("-----").map_or("", |close| &tail[close + 5..])
            }
            None => "",
        };
    }
    out.push_str(rest);
    out
}

/// Names whose value is replaced in `name = value`, `name: value` and `"name": "value"`.
const SECRET_NAMES: [&str; 9] = ["password", "passwd", "secret", "token", "api_key", "apikey", "api-key", "access_key", "private_key"];

fn redact_assignments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let lower = line.to_ascii_lowercase();
        let bytes = line.as_bytes();
        let mut cut: Vec<(usize, usize)> = vec![];
        for name in SECRET_NAMES {
            let mut from = 0;
            while let Some(found) = lower[from..].find(name) {
                let mut i = from + found + name.len();
                from = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'-') {
                    i += 1;
                }
                while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'"' | b'\'') {
                    i += 1;
                }
                if i >= bytes.len() || !matches!(bytes[i], b'=' | b':') {
                    continue;
                }
                i += 1;
                while i < bytes.len() && matches!(bytes[i], b' ' | b'\t') {
                    i += 1;
                }
                // A quoted value runs to its closing quote (spaces and escaped quotes included); a bare one to the next space.
                let quote = (i < bytes.len() && matches!(bytes[i], b'"' | b'\'')).then(|| bytes[i]);
                if quote.is_some() {
                    i += 1;
                }
                let start = i;
                match quote {
                    Some(q) => {
                        while i < bytes.len() && bytes[i] != q && bytes[i] != b'\n' {
                            i += if bytes[i] == b'\\' { 2 } else { 1 };
                        }
                        i = i.min(bytes.len());
                        while !line.is_char_boundary(i) {
                            i += 1;
                        }
                    }
                    None => {
                        while i < bytes.len() && !matches!(bytes[i], b' ' | b'\t' | b'\r' | b'\n' | b'"' | b'\'' | b',' | b';' | b'}') {
                            i += 1;
                        }
                    }
                }
                if i > start {
                    cut.push((start, i));
                }
            }
        }
        cut.sort();
        let mut at = 0;
        for (start, end) in cut {
            if start < at {
                continue;
            }
            out.push_str(&line[at..start]);
            out.push_str(REMOVED);
            at = end;
        }
        out.push_str(&line[at..]);
    }
    out
}

fn redact_url_passwords(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find("://") {
        let (head, tail) = rest.split_at(i + 3);
        out.push_str(head);
        let end = tail.find(|c: char| c.is_whitespace() || matches!(c, '/' | '"' | '\'')).unwrap_or(tail.len());
        let auth = &tail[..end];
        match (auth.rfind('@'), auth.find(':')) {
            (Some(at), Some(colon)) if colon < at => {
                out.push_str(&auth[..colon + 1]);
                out.push_str(REMOVED);
                out.push_str(&auth[at..]);
            }
            _ => out.push_str(auth),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// Prefixes of API keys and tokens (OpenAI and Anthropic, Stripe, GitHub, GitLab, Slack, AWS, Google, npm, Hugging Face,
/// and JWTs).
const TOKEN_PREFIXES: [&str; 21] = [
    "sk-", "sk_live_", "sk_test_", "rk_live_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "xoxb-", "xoxp-", "xoxa-", "xoxs-",
    "AKIA", "ASIA", "AIza", "npm_", "hf_", "eyJ",
];

fn redact_tokens(text: &str) -> String {
    fn flush(word: &mut String, out: &mut String) {
        // A diff line's + or - (or other punctuation) before a token is not part of it.
        let lead = word.len() - word.trim_start_matches(|c: char| !c.is_ascii_alphanumeric()).len();
        let (head, token) = word.split_at(lead);
        let secret = token.len() >= 20 && TOKEN_PREFIXES.iter().any(|p| token.starts_with(p));
        out.push_str(head);
        out.push_str(if secret { REMOVED } else { token });
        word.clear();
    }
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '/' | '=') {
            word.push(c);
        } else {
            flush(&mut word, &mut out);
            out.push(c);
        }
    }
    flush(&mut word, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{Review, ReviewState};
    use crate::worktree::{FileChange, Totals};

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("hivemind-learning-{name}-{}", uuid::Uuid::new_v4().simple()))
    }
    fn info() -> SessionInfo {
        let mut info: SessionInfo = serde_json::from_value(json!({
            "id": "0123456789abcdef", "adapter": "claude-code", "cliVersion": null,
            "task": {"kind": "work", "project": "pay", "repo": "C:/src/pay"}, "title": "Fix the retry", "workspace": [], "status": "idle",
            "startedAt": 0, "endedAt": null, "costUsd": null, "error": null, "structured": null, "mode": "interactive", "policy": "ask",
            "project": "pay", "worktree": null, "turns": 2, "filesChanged": null, "context": [], "model": null
        })).unwrap();
        info.interface = Interface::Chat;
        info
    }
    fn ev(event: RunEvent) -> SeqEvent {
        SeqEvent { session_id: "s".into(), seq: 0, at: 0, event }
    }
    fn tool(summary: &str) -> SeqEvent {
        ev(RunEvent::ToolUse { id: "t".into(), name: "Bash".into(), summary: summary.into() })
    }

    #[test]
    fn which_sessions_are_reviewed() {
        let mut s = info();
        assert_eq!(wanted(&s, Trigger::Finished, 3), None, "a short session without edits");
        assert_eq!(wanted(&s, Trigger::Finished, MIN_TOOL_CALLS), Some(false));
        s.files_changed = Some(Totals { files: 2, added: 1, removed: 0 });
        assert_eq!(wanted(&s, Trigger::Finished, 40), None, "edits wait for the user's decision");
        assert_eq!(wanted(&s, Trigger::Approved, 0), Some(true));
        assert_eq!(wanted(&s, Trigger::Dismissed, 0), Some(false));
        assert_eq!(wanted(&s, Trigger::Manual, 0), Some(false));
        s.review = Some(Review { state: ReviewState::Approved, commit: None, at: 0 });
        assert_eq!(wanted(&s, Trigger::Manual, 0), Some(true));
        s.interface = Interface::Terminal;
        assert_eq!(wanted(&s, Trigger::Approved, 0), None, "a terminal session has no log to read");
    }

    #[test]
    fn the_digest_keeps_the_facts_and_marks_what_was_captured() {
        let events = vec![
            ev(RunEvent::UserMessage { text: "Fix the retry loop".into(), context: vec![] }),
            tool("cargo test"),
            ev(RunEvent::ToolResult { id: "t".into(), ok: false, summary: "1 failed".into() }),
            tool("alm --json --domain sandbox capture --title 'Retry needs jitter'"),
            ev(RunEvent::FilesChanged { files: vec![FileChange { path: "src/retry.rs".into(), status: "M".into(), added: 4, removed: 1, binary: false }] }),
            ev(RunEvent::TurnFinished { ok: true, reason: None, cost_usd: None, duration_ms: None, result: Some("Done: jitter added.".into()), denials: 0, outcome: Default::default() }),
        ];
        let text = digest(&info(), &events, &[("restart-worker".into(), "Use when it stalls.".into())], true);
        for part in ["# Session: Fix the retry", "Project: pay. Repository: pay.", "Skills allowed: yes.", "User: Fix the retry loop", "Tool Bash: cargo test",
            "  failed: 1 failed", "- M src/retry.rs (+4 -1)", "## Final reply\nDone: jitter added.", "- alm --json --domain sandbox capture", "- restart-worker: Use when it stalls."] {
            assert!(text.contains(part), "missing {part:?} in\n{text}");
        }
        let long: Vec<SeqEvent> = (0..2000).map(|i| tool(&format!("step {i} {}", "x".repeat(100)))).collect();
        let text = digest(&info(), &long, &[], false);
        assert!(text.len() < DIGEST_CHARS + 2000 && text.contains("step 0 ") && text.contains("step 1999 ") && text.contains("left out"));
        assert!(text.contains("Skills allowed: no"));
    }

    #[test]
    fn the_envelope_is_read_strictly() {
        let ok = json!({"type": "result", "subtype": "success", "is_error": false, "total_cost_usd": 0.03,
            "structured_output": {"memory": [{"type": "bug", "title": "T", "summary": "S", "sections": [], "reason": "R"}],
                "skill": {"action": "none", "name": "", "description": "", "body": "", "reason": ""}}});
        let (answer, cost) = parse_envelope(&ok.to_string());
        assert_eq!((answer.unwrap().memory[0].kind.as_str(), cost), ("bug", Some(0.03)));
        let capped = json!({"subtype": "error_max_budget_usd", "is_error": true, "total_cost_usd": 0.25});
        let (answer, cost) = parse_envelope(&capped.to_string());
        assert!(answer.unwrap_err().contains("spending cap"));
        assert_eq!(cost, Some(0.25));
        assert!(parse_envelope("I think...").0.is_err());
        assert!(parse_envelope(&json!({"subtype": "success", "is_error": false, "structured_output": {"memory": "x"}}).to_string()).0.is_err());
    }

    #[test]
    fn the_command_line_has_no_tools_and_a_cap() {
        let args = argv();
        let at = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone());
        assert_eq!(at("--tools").as_deref(), Some(""));
        assert_eq!(at("--max-budget-usd").as_deref(), Some("0.25"));
        assert_eq!(at("--model").as_deref(), Some(MODEL));
        for flag in ["--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(serde_json::from_str::<Value>(&at("--json-schema").unwrap()).is_ok());
    }

    #[test]
    fn propose_arguments() {
        let item = MemoryItem { kind: "made-up".into(), title: "Retry needs jitter".into(), summary: "S.".into(),
            sections: vec![SectionItem { heading: "Why".into(), text: "Thundering herd.".into() }, SectionItem { heading: " ".into(), text: "x".into() }], reason: "R".into() };
        let known: Vec<String> = ["concern/knowledge", "concern/risk", "project/pay"].map(String::from).to_vec();
        let argv = propose_argv(&item, "hivemind-review-1", Some("pay"), "C:/src/pay", "ctx", &known, "pay");
        assert_eq!(argv, ["propose", "--session", "hivemind-review-1", "--domain", "pay", "--type", "knowledge", "--title", "Retry needs jitter", "--summary", "S.",
            "--section", "Why", "Thundering herd.", "--concern", "concern/knowledge", "--project", "pay", "--context", "ctx"]);
        assert!(propose_argv(&item, "p", None, "C:/src/pay", "c", &[], "pay").windows(2).any(|w| w == ["--cwd", "C:/src/pay"]));
        assert!(!propose_argv(&item, "p", None, "C:/src/pay", "c", &[], "pay").iter().any(|a| a == "--concern" || a == "--project"));
    }

    #[test]
    fn a_concern_the_taxonomy_has() {
        let mine: Vec<String> = ["concern/constraint", "concern/workflow", "concern/knowledge"].map(String::from).to_vec();
        let demo: Vec<String> = ["concern/risk", "concern/knowledge"].map(String::from).to_vec();
        assert_eq!(tags_for("risk", "x", &mine).concern.as_deref(), Some("concern/constraint"), "Living Memory's own default first");
        assert_eq!(tags_for("risk", "x", &demo).concern.as_deref(), Some("concern/risk"));
        assert_eq!(tags_for("runbook", "x", &demo).concern.as_deref(), Some("concern/knowledge"));
        assert_eq!(tags_for("bug", "x", &[]).concern, None);
    }

    #[test]
    fn the_daily_cap_counts_reservations_until_settled() {
        let dir = scratch("spend");
        let ledger = Ledger::new(dir.join("spend.json"));
        let now = 10 * DAY_MS + 5;
        ledger.reserve("a", 0.25, 0.5, now).unwrap();
        ledger.reserve("b", 0.25, 0.5, now).unwrap();
        assert!(ledger.reserve("c", 0.25, 0.5, now).unwrap_err().contains("budget is used"));
        ledger.settle("a", Some(0.05), now).unwrap();
        ledger.settle("b", None, now).unwrap();
        assert!((ledger.used(now) - 0.30).abs() < 1e-9, "an unknown cost keeps the reservation");
        ledger.reserve("c", 0.2, 0.5, now).unwrap();
        assert!((ledger.used(now + DAY_MS) - 0.0).abs() < 1e-9, "a new day starts empty, even with a reservation left over");
        assert!(ledger.reserve("d", 0.25, 0.0, now + DAY_MS).is_err(), "a zero cap turns paid work off");
        // A call that never started is not charged (EXEC-6).
        let later = now + 2 * DAY_MS;
        ledger.reserve("e", 0.25, 0.5, later).unwrap();
        ledger.release("e", later).unwrap();
        assert!(ledger.used(later).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_review_that_cannot_reserve_is_recorded_as_failed_and_can_be_retried() {
        let dir = scratch("runs");
        let learning = Learning::new(dir.clone());
        let bridge = crate::bridge::Bridge::new(crate::settings::Launch { program: "missing".into(), args: vec![], script: PathBuf::new(), root: None });
        let skills = Skills::new(dir.join("skills"), vec![]);
        let deps = Deps { bridge: &bridge, skills: &skills, claude: "missing-claude".into(), daily_usd: 0.0, auto_patch: false };
        let mut s = info();
        s.files_changed = Some(Totals { files: 1, added: 1, removed: 0 });
        assert!(learning.review(&deps, &s, &[], Trigger::Finished).is_none(), "waits for the decision");
        let run = learning.review(&deps, &s, &[], Trigger::Approved).unwrap();
        assert_eq!((run.state.as_str(), run.error.as_deref().map(|e| e.contains("budget"))), ("failed", Some(true)));
        assert!(!learning.reviewed(&s.id), "a failed review does not count");
        assert_eq!(learning.runs().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn secrets_are_taken_out_of_the_reviewer_input() {
        let text = "export OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl\n\
            const config = { \"password\": \"hunter2\", user: \"ann\" };\n\
            remote: https://ann:s3cret@github.com/acme/app.git\n\
            -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----\n\
            Bearer ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4\n\
            +github_pat_abcdefghijklmnopqrstuvwxyz\n\
            db_password = \"correct horse \\\" battery\" # note\n\
            api_token:\ttab-separated-value\n\
            The retry token count stays at 3 and src/sk-learn/notes.md is a path.";
        let clean = redact(text);
        for secret in ["sk-proj-abc123", "tab-separated-value", "hunter2", "s3cret", "b3BlbnNz", "ghp_A1b2", "github_pat_abc", "horse", "battery"] {
            assert!(!clean.contains(secret), "{secret} left in:\n{clean}");
        }
        for kept in ["OPENAI_API_KEY=", "user: \"ann\"", "# note", "+[removed]", "https://ann:", "@github.com/acme/app.git", "[private key removed]", "token count stays at 3", "src/sk-learn/notes.md"] {
            assert!(clean.contains(kept), "{kept} missing from:\n{clean}");
        }
    }

    #[test]
    fn an_authorization_credential_of_any_shape_is_taken_out() {   // Codex R2 on c65ac7b..b5e0a4b
        let text = "curl -H 'Authorization: Bearer q8Zt1vXw9LmN0pRs4TuV' x\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\n\
            bearer\tAbCdEfGh1234ijkl\nWe use Basic authentication and bearer tokens.";
        let clean = redact(text);
        for secret in ["q8Zt1vXw9LmN0pRs4TuV", "dXNlcjpwYXNzd29yZA", "AbCdEfGh1234ijkl"] {
            assert!(!clean.contains(secret), "{secret} left in:\n{clean}");
        }
        assert!(clean.contains("Authorization: Bearer [removed]") && clean.contains("Basic authentication and bearer tokens."), "{clean}");
        // In a header, a short or all-letter credential goes too (Codex re-review).
        let short = redact("Authorization: Bearer abcdefghijklmnop\nauthorization:  basic dXNlcjpwYXNz");
        assert!(!short.contains("abcdefghijklmnop") && !short.contains("dXNlcjpwYXNz"), "{short}");
    }
}
