//! The executive workspace's backend. It keeps the operational records Living Memory does not hold (milestones, project
//! health, stakeholders, communication drafts, generated briefings and capture batches waiting for review), builds the
//! evidence pack that grounds every generated text, and runs the tool-free calls that extract, draft, refine, brief and learn
//! a writing style. Durable knowledge stays in Living Memory: this module only reads it, and the webview writes there only
//! when the user accepts an item.
//!
//! Files under `app_data_dir/executive`: `<kind>/<id>.json`, one per record, and `agent/`, the executive chat's empty
//! working folder.
use crate::agent::events::{clip, RunEvent, SeqEvent};
use crate::learning::Ledger;
use crate::oneshot::{self, Call};
use chrono::{Duration as Days, NaiveDate};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

pub const KINDS: [&str; 6] = ["milestone", "health", "stakeholder", "draft", "briefing", "capture"];
const MAX_RECORD: usize = 1 << 20;
const TIMEOUT: Duration = Duration::from_secs(300);
const MODEL: &str = "sonnet";
const PACK_CHARS: usize = 40_000;
const AGENT_PACK_CHARS: usize = 20_000;
const SOURCE_CHARS: usize = 20_000;
/// A project with no status note newer than this many days is reported as a gap.
const STALE_STATUS_DAYS: i64 = 14;

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// One JSON file per record. The webview owns the shapes; Rust checks the kind, the id and the size.
pub struct Store {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl Store {
    pub fn new(dir: PathBuf) -> Store {
        Store { dir, lock: Mutex::new(()) }
    }

    /// The executive chat's working folder: empty, so the agent has nothing to read there but what it is given.
    pub fn agent_dir(&self) -> PathBuf {
        self.dir.join("agent")
    }

    fn kind_dir(&self, kind: &str) -> Result<PathBuf, String> {
        if KINDS.contains(&kind) { Ok(self.dir.join(kind)) } else { Err(format!("Unknown record kind: {kind}")) }
    }

    /// Newest first. A kind with no folder yet has no records; any other read error is an error, not an empty list. A file
    /// that does not parse is read again under the lock (a save may have been under way) and only then renamed aside, not
    /// deleted.
    pub fn list(&self, kind: &str) -> Result<Vec<Value>, String> {
        let dir = self.kind_dir(kind)?;
        let failed = |e: std::io::Error| format!("Could not read the {kind} records: {e}");
        let entries = match std::fs::read_dir(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            entries => entries.map_err(failed)?,
        };
        let mut rows = vec![];
        for entry in entries {
            let path = entry.map_err(failed)?.path();
            if !path.extension().is_some_and(|x| x == "json") {
                continue;
            }
            let row = match read_record(&path) {
                Ok(row) => row,
                Err(_) => {
                    let _guard = self.lock.lock().unwrap();
                    match read_record(&path) {
                        Ok(row) => row,
                        Err(Unreadable::Io(e)) => return Err(format!("Could not read the {kind} record {}: {e}", path.display())),
                        Err(Unreadable::Invalid) => match std::fs::rename(&path, path.with_extension(format!("unreadable-{}", crate::agent::now_ms()))) {
                            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                                return Err(format!("The {kind} record {} is damaged and could not be set aside: {e}", path.display()));
                            }
                            _ => None,
                        },
                    }
                }
            };
            rows.extend(row);
        }
        rows.sort_by_key(|r| std::cmp::Reverse(r.get("updated").and_then(Value::as_u64).unwrap_or(0)));
        Ok(rows)
    }

    /// Save a record. A record without an id gets one; `created` is kept, `updated` is now.
    pub fn put(&self, kind: &str, mut record: Value, now: u64) -> Result<Value, String> {
        let dir = self.kind_dir(kind)?;
        let object = record.as_object_mut().ok_or("A record is a JSON object")?;
        let id = match object.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => uuid::Uuid::new_v4().simple().to_string(),
        };
        if !valid_id(&id) {
            return Err(format!("Not a record id: {id}"));
        }
        object.insert("id".into(), json!(id));
        object.entry("created").or_insert(json!(now));
        object.insert("updated".into(), json!(now));
        let text = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        if text.len() > MAX_RECORD {
            return Err("The record is too large to save".into());
        }
        let _guard = self.lock.lock().unwrap();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{id}.json"));
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
        Ok(record)
    }

    /// Change one stored record under the lock, leaving its other fields and its `updated` time as they are. `change` returns
    /// false to leave the record alone. False when the record is gone or was left alone.
    pub fn update(&self, kind: &str, id: &str, change: impl FnOnce(&mut serde_json::Map<String, Value>) -> bool) -> Result<bool, String> {
        if !valid_id(id) {
            return Err(format!("Not a record id: {id}"));
        }
        let path = self.kind_dir(kind)?.join(format!("{id}.json"));
        let _guard = self.lock.lock().unwrap();
        let Some(mut record) = read_record(&path).map_err(|_| format!("Could not read the {kind} record {}", path.display()))? else { return Ok(false) };
        if !record.as_object_mut().is_some_and(change) {
            return Ok(false);
        }
        let text = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        if text.len() > MAX_RECORD {
            return Err("The record is too large to save".into());
        }
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, text).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// How far capture has read the executive conversation `session` (an event seq). Kept beside the record kinds, which
    /// the webview writes, so a part that yields no batch still moves it.
    pub fn capture_cursor(&self, session: &str) -> Option<u64> {
        if !valid_id(session) {
            return None;
        }
        std::fs::read_to_string(self.dir.join("cursors").join(format!("{session}.json"))).ok()?.trim().parse().ok()
    }

    pub fn set_capture_cursor(&self, session: &str, upto: u64) -> Result<(), String> {
        if !valid_id(session) {
            return Err(format!("Not a session id: {session}"));
        }
        let _guard = self.lock.lock().unwrap();
        let dir = self.dir.join("cursors");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{session}.json"));
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, upto.to_string()).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    }

    pub fn delete(&self, kind: &str, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err(format!("Not a record id: {id}"));
        }
        let _guard = self.lock.lock().unwrap();
        match std::fs::remove_file(self.kind_dir(kind)?.join(format!("{id}.json"))) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// A read-only Living Memory command: argv without `--actor`, the result on exit code 0.
/// Why a record file could not be read.
enum Unreadable {
    Io(std::io::Error),
    /// Read, but not a JSON object.
    Invalid,
}

/// One record file: None when it is gone (deleted since the folder was listed). Bytes that are not UTF-8 are a malformed
/// record, not a read error.
fn read_record(path: &std::path::Path) -> Result<Option<Value>, Unreadable> {
    match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(Unreadable::Io(e)),
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok().filter(Value::is_object).map(Some).ok_or(Unreadable::Invalid),
    }
}

pub type Lm<'a> = dyn Fn(&[&str]) -> Result<Value, String> + 'a;

/// Living Memory through the app's bridge, as a viewer.
pub fn viewer(bridge: &crate::bridge::Bridge) -> impl Fn(&[&str]) -> Result<Value, String> + '_ {
    move |argv| {
        let mut args: Vec<String> = argv.iter().map(|a| a.to_string()).collect();
        args.extend(["--actor".into(), "viewer".into()]);
        let reply = bridge.call(&args, None)?;
        if reply.exit_code != 0 {
            return Err(format!("Living Memory could not run {}: {}", argv.first().unwrap_or(&""), reply.error));
        }
        Ok(reply.result)
    }
}

/// One fact a generated text may cite, as `[E3]`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub project: Option<String>,
    /// A Living Memory note ref, or `milestone:<id>` / `health:<slug>` for Hivemind's own records.
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Pack {
    pub evidence: Vec<Evidence>,
    /// What a reader would expect and the evidence does not show.
    pub gaps: Vec<String>,
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn array<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    v.get(key).and_then(Value::as_array).into_iter().flatten()
}

/// The due date in a commitment written `... (owner: Dana, due: 2026-11-25)`.
pub fn due_of(item: &str) -> Option<NaiveDate> {
    let lower = item.to_ascii_lowercase();
    let at = lower.find("due:")? + 4;
    let date = item[at..].trim_start().get(..10)?;
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

fn day(stamp: &str) -> &str {
    stamp.get(..10).unwrap_or(stamp)
}

/// The plan note of commitments that belong to no single project (`commitmentsTitle` in the frontend).
const CROSS_PROJECT: &str = "Commitments: Cross-project";

const STYLE_WORDS: [&str; 7] = ["writ", "tone", "email", "style", "communicat", "wording", "draft"];

/// What Living Memory and Hivemind's records know about one project (or all active ones) over the last `days` days,
/// in priority order, within `PACK_CHARS`.
pub fn pack(lm: &Lm, store: &Store, project: Option<&str>, days: u32, today: NaiveDate) -> Result<Pack, String> {
    pack_within(lm, store, project, days, today, PACK_CHARS)
}

fn pack_within(lm: &Lm, store: &Store, project: Option<&str>, days: u32, today: NaiveDate, room: usize) -> Result<Pack, String> {
    let registry = lm(&["projects"])?;
    let projects: Vec<&Value> = array(&registry, "projects")
        .filter(|p| text(p, "status") != "archived" && project.is_none_or(|slug| text(p, "slug") == slug))
        .collect();
    if let Some(slug) = project.filter(|_| projects.is_empty()) {
        return Err(format!("Unknown project: {slug}"));
    }
    let since = (today - Days::days(i64::from(days))).format("%Y-%m-%d").to_string();
    let stale = (today - Days::days(STALE_STATUS_DAYS)).format("%Y-%m-%d").to_string();
    let (milestones, health) = (store.list("milestone")?, store.list("health")?);
    let mut found: Vec<Evidence> = vec![];
    let mut gaps = vec![];
    for p in projects {
        let (slug, name) = (text(p, "slug"), text(p, "name"));
        let of = |kind: &str, title: String, reference: Option<String>, date: Option<String>, body: String| Evidence {
            id: String::new(), kind: kind.into(), title, project: Some(name.clone()), reference, date, text: body,
        };
        match health.iter().find(|h| text(h, "project") == slug) {
            Some(h) => found.push(of("health", format!("{name} health"), Some(format!("health:{slug}")), None,
                format!("Set to {} by the user. {}", text(h, "status"), text(h, "note")).trim().to_string())),
            None => gaps.push(format!("{name}: no project health has been set.")),
        }
        let mine: Vec<&Value> = milestones.iter().filter(|m| text(m, "project") == slug).collect();
        if mine.is_empty() {
            gaps.push(format!("{name}: no milestones are recorded."));
        }
        for m in mine {
            let due = text(m, "due");
            let late = text(m, "status") != "done" && !due.is_empty() && due.as_str() < today.format("%Y-%m-%d").to_string().as_str();
            found.push(of("milestone", text(m, "title"), Some(format!("milestone:{}", text(m, "id"))), Some(due.clone()),
                format!("Due {}. Status: {}.{} {}", if due.is_empty() { "date not set" } else { &due }, text(m, "status"), if late { " Overdue." } else { "" }, text(m, "note")).trim().to_string()));
        }
        let tag = format!("project/{slug}");
        let open = lm(&["open", "--all-domains", "--tag", &tag, "--limit", "200"])?;
        for item in array(&open, "items") {
            let line = text(item, "item");
            let late = due_of(&line).filter(|d| *d < today).map(|d| format!(" Overdue since {d}.")).unwrap_or_default();
            found.push(of("action item", line.clone(), Some(text(item, "ref")), due_of(&line).map(|d| d.to_string()),
                format!("Open item on \"{}\": {line}.{late}", text(item, "title"))));
        }
        let rows = lm(&["list", "--all-domains", "--status", "active", "--tag", &tag, "--with-summary", "--limit", "300"])?;
        let mut rows: Vec<&Value> = array(&rows, "notes").collect();
        rows.sort_by_key(|r| std::cmp::Reverse(text(r, "updated")));
        let note = |r: &Value| of(&text(r, "type"), text(r, "title"), Some(text(r, "ref")), Some(day(&text(r, "updated")).to_string()), text(r, "summary"));
        let latest_status = rows.iter().find(|r| text(r, "type") == "status");
        match latest_status {
            Some(r) if day(&text(r, "updated")) >= stale.as_str() => {}
            _ => gaps.push(format!("{name}: no status update in the last {STALE_STATUS_DAYS} days.")),
        }
        found.extend(latest_status.map(|r| note(r)));
        for r in &rows {
            let recent = day(&text(r, "updated")) >= since.as_str();
            let open_actions = r.pointer("/actions/open").and_then(Value::as_u64).unwrap_or(0) > 0;
            let keep = match text(r, "type").as_str() {
                "risk" | "bug" => true,
                "decision" => recent,
                "plan" => recent || open_actions,
                "status" | "map" | "brief" => false,
                _ => recent,
            };
            if keep {
                found.push(note(r));
            }
        }
    }
    // Commitments that belong to no project live on one plan note with no project tag; Today shows them, so does the pack.
    if project.is_none() {
        let open = lm(&["open", "--all-domains", "--limit", "500"])?;
        for item in array(&open, "items").filter(|i| text(i, "title") == CROSS_PROJECT) {
            let line = text(item, "item");
            let late = due_of(&line).filter(|d| *d < today).map(|d| format!(" Overdue since {d}.")).unwrap_or_default();
            found.push(Evidence { kind: "action item".into(), title: line.clone(), reference: Some(text(item, "ref")), date: due_of(&line).map(|d| d.to_string()),
                text: format!("Cross-project commitment: {line}.{late}"), ..Default::default() });
        }
    }
    let prefs =lm(&["list", "--all-domains", "--type", "preference", "--status", "active", "--with-summary", "--limit", "200"])?;
    for r in array(&prefs, "notes") {
        let words = format!("{} {}", text(r, "title"), text(r, "summary")).to_lowercase();
        if STYLE_WORDS.iter().any(|w| words.contains(w)) {
            found.push(Evidence { kind: "writing preference".into(), title: text(r, "title"), reference: Some(text(r, "ref")), text: text(r, "summary"), ..Default::default() });
        }
    }
    let mut used = 0;
    let mut evidence = vec![];
    for (i, mut e) in found.into_iter().enumerate() {
        used += e.title.len() + e.text.len() + 60;
        if used > room {
            gaps.push(format!("The evidence pack was cut to fit: later items (from item {}) were left out.", i + 1));
            break;
        }
        e.id = format!("E{}", evidence.len() + 1);
        evidence.push(e);
    }
    Ok(Pack { evidence, gaps })
}

/// The pack as the model reads it.
pub fn pack_text(pack: &Pack) -> String {
    let mut out = String::from("## Evidence\n");
    for e in &pack.evidence {
        let meta: Vec<&str> = [Some(e.kind.as_str()), e.project.as_deref(), e.date.as_deref()].into_iter().flatten().filter(|s| !s.is_empty()).collect();
        out.push_str(&format!("[{}] ({}) {}\n{}\n", e.id, meta.join(", "), e.title, e.text));
    }
    if pack.evidence.is_empty() {
        out.push_str("None.\n");
    }
    out.push_str("\n## Known gaps\n");
    out.push_str(&if pack.gaps.is_empty() { "None.".to_string() } else { pack.gaps.iter().map(|g| format!("- {g}")).collect::<Vec<_>>().join("\n") });
    out
}

/// What each call needs from the app.
pub struct Deps<'a> {
    pub claude: String,
    pub ledger: &'a Ledger,
    pub cap: f64,
    /// The cancel switch of the automation run that asked for this; None for the user's own requests.
    pub cancel: Option<&'a oneshot::Cancel>,
}

impl Deps<'_> {
    fn cancelled(&self) -> Result<(), String> {
        match self.cancel {
            Some(c) if c.is_set() => Err(oneshot::CANCELLED.into()),
            _ => Ok(()),
        }
    }
}

const GROUNDING: &str = "Ground every statement in the evidence, and list the evidence ids (such as E3) each part rests on in the fields \
the answer has for them. Never invent people, dates, numbers, \
decisions or commitments the evidence does not contain; when something the reader needs is missing or uncertain, say so in gaps. The \
reader already sees the evidence's known gaps, so do not repeat them. Write plainly: lead with the point, short sentences, no filler, no em dashes, no emoji. Never include secrets, tokens or passwords.";

const EXTRACT: &str = "You turn raw text from an engineering leader (meeting notes, a conversation, a document, loose thoughts) into items worth \
keeping. Kinds: decision (something decided, with the reason when stated), risk (something that may go wrong, with impact or mitigation when \
stated), commitment (someone promised to do something), status (a progress update on a project), milestone (a dated project checkpoint), \
knowledge (a durable fact worth remembering), preference (how the user likes to work or write). Extract only what the text states. For each \
item give: project (a slug from the project list, or empty when it is cross-project or unclear), a title that states the fact (for a \
milestone, its name, such as Public beta), a summary of one \
or two sentences, details (short supporting lines, may be empty), owner (the person named, or empty), due (YYYY-MM-DD only when the text gives \
a date or clearly implies one relative to today, else empty), quote (the exact line of the text it came from), and confidence (high when \
stated plainly, medium when loosely phrased, low when unsure it is meant). Skip small talk, repeats and work already done unless it is a \
decision. Put questions the user should answer (a commitment with no owner, an unclear project) in questions. An empty list is a fine answer. \
Write plainly. Never include secrets, tokens or passwords.";

const DRAFT: &str = "You draft professional communications for an engineering leader: emails, stakeholder updates, escalations and executive \
summaries. Use the request (kind, audience, tone, key points) and the evidence. Follow the writing preferences in the evidence. Match the \
length to the kind: an email or escalation fits on one screen; an update uses short headed sections. An escalation states the problem, the \
impact, what is needed from the reader and by when. Return the subject, the body in Markdown without citation marks, the evidence ids the draft \
rests on, the assumptions you made, and gaps: facts the draft needs that the evidence does not give. Where such a fact belongs in the body, \
write a placeholder in square brackets, for example [date].";

const REFINE: &str = "You revise a draft written for an engineering leader as instructed. Keep its facts; add no fact that is not in the \
evidence. Return the same fields as the draft: subject, body in Markdown without citation marks, the evidence ids used, assumptions and gaps.";

const BRIEF: &str = "You write briefings for an engineering leader from the evidence: what changed in the period, project health, priorities, \
outstanding commitments and risks. Every bullet cites the evidence ids it rests on; leave out anything you cannot cite. Say plainly when a \
commitment or milestone is overdue. In gaps list what a leadership reader would expect that the evidence does not show. Kinds: weekly (a \
leadership report: summary, status and health per project, decisions, risks, commitments, next priorities), project (one project in depth), \
priorities (what needs attention first and why), commitments (outstanding commitments by owner and due date, overdue first), risks (a risk \
assessment: impact and likelihood as stated, mitigations, owners). The summary is two or three sentences and may cite ids inline, for \
example [E3].";

const LEARN_STYLE: &str = "Compare a draft Hivemind generated with the version the user kept. Name at most 3 durable writing preferences the \
edits show, for example shorter subject lines, no greeting, bullets instead of paragraphs, the ask in the first line. Skip one-off content \
changes and facts. Each preference has a title starting with \"Writing preference: \", a summary of one or two sentences, and a short example \
from the edits. An empty list is a fine answer.";

fn string() -> Value {
    json!({"type": "string"})
}

fn strings() -> Value {
    json!({"type": "array", "items": {"type": "string"}})
}

fn object(required: &[&str], properties: Value) -> Value {
    json!({"type": "object", "additionalProperties": false, "required": required, "properties": properties})
}

pub const ITEM_KINDS: [&str; 7] = ["decision", "risk", "commitment", "status", "milestone", "knowledge", "preference"];

pub fn extract_schema() -> Value {
    let item = object(
        &["kind", "project", "title", "summary", "details", "owner", "due", "quote", "confidence"],
        json!({"kind": {"type": "string", "enum": ITEM_KINDS}, "project": string(), "title": string(), "summary": string(), "details": strings(),
            "owner": string(), "due": string(), "quote": string(), "confidence": {"type": "string", "enum": ["high", "medium", "low"]}}),
    );
    object(&["items", "questions"], json!({"items": {"type": "array", "maxItems": 25, "items": item}, "questions": strings()}))
}

pub fn draft_schema() -> Value {
    object(&["subject", "body", "evidence", "assumptions", "gaps"],
        json!({"subject": string(), "body": string(), "evidence": strings(), "assumptions": strings(), "gaps": strings()}))
}

pub fn brief_schema() -> Value {
    let bullet = object(&["text", "evidence"], json!({"text": string(), "evidence": strings()}));
    let section = object(&["heading", "bullets"], json!({"heading": string(), "bullets": {"type": "array", "items": bullet}}));
    object(&["title", "summary", "sections", "gaps"], json!({"title": string(), "summary": string(), "sections": {"type": "array", "items": section}, "gaps": strings()}))
}

pub fn style_schema() -> Value {
    let pref = object(&["title", "summary", "example"], json!({"title": string(), "summary": string(), "example": string()}));
    object(&["preferences"], json!({"preferences": {"type": "array", "maxItems": 3, "items": pref}}))
}

fn call(deps: &Deps, dir: &std::path::Path, name: &str, policy: &str, schema: Value, budget_usd: f64, input: &str) -> (Result<Value, String>, Option<f64>) {
    let who = Call { who: "The executive assistant", model: MODEL, policy, schema, budget_usd };
    let id = format!("exec-{name}-{}", uuid::Uuid::new_v4().simple());
    oneshot::run(&deps.claude, dir, deps.ledger, deps.cap, &id, &who, input, TIMEOUT, deps.cancel.map(oneshot::Cancel::flag))
}

pub const BRIEF_KINDS: [&str; 5] = ["weekly", "project", "priorities", "commitments", "risks"];

fn project_name(lm: &Lm, slug: &str) -> String {
    lm(&["projects"]).ok().and_then(|r| array(&r, "projects").find(|p| text(p, "slug") == slug).map(|p| text(p, "name"))).unwrap_or_else(|| slug.into())
}

/// Generate a briefing and save it as a record. `origin` is "manual" or "automation:<id>".
#[allow(clippy::too_many_arguments)] // each argument is one independent part of the briefing
pub fn brief(lm: &Lm, store: &Store, deps: &Deps, kind: &str, project: Option<&str>, days: u32, origin: &str, today: NaiveDate) -> Result<Value, String> {
    if !BRIEF_KINDS.contains(&kind) {
        return Err(format!("Unknown briefing kind: {kind}"));
    }
    let days = days.clamp(1, 90);
    deps.cancelled()?;
    let pack = pack(lm, store, project, days, today)?;
    let scope = project.map_or("all active projects".to_string(), |slug| format!("the project {}", project_name(lm, slug)));
    let input = format!("# Briefing request\nKind: {kind}. Scope: {scope}. Period: the {days} days up to {today} (today).\n\n{}", pack_text(&pack));
    let (answer, cost) = call(deps, &store.dir, "brief", &format!("{BRIEF}\n\n{GROUNDING}"), brief_schema(), 0.5, &input);
    let mut record = answer?;
    let object = record.as_object_mut().ok_or("The briefing is not an object")?;
    object.insert("kind".into(), json!(kind));
    object.insert("project".into(), json!(project));
    object.insert("days".into(), json!(days));
    object.insert("origin".into(), json!(origin));
    object.insert("evidence".into(), json!(pack.evidence));
    object.insert("packGaps".into(), json!(pack.gaps));
    object.insert("costUsd".into(), json!(cost));
    // Saving is the run's commit: a cancel before it keeps no briefing, and one after it is refused.
    match deps.cancel {
        Some(cancel) => cancel.commit(|| store.put("briefing", record, crate::agent::now_ms())),
        None => store.put("briefing", record, crate::agent::now_ms()),
    }
}

/// What the webview asks a draft for. Names only: the evidence is gathered here.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DraftRequest {
    pub kind: String,
    #[serde(default)]
    pub audience: String,
    #[serde(default)]
    pub tone: String,
    #[serde(default)]
    pub points: String,
    #[serde(default)]
    pub project: Option<String>,
}

/// A new draft (not saved: the webview saves it as the user edits). The answer plus the evidence it may cite.
pub fn draft(lm: &Lm, store: &Store, deps: &Deps, request: &DraftRequest, today: NaiveDate) -> Result<Value, String> {
    let pack = pack(lm, store, request.project.as_deref(), 30, today)?;
    let input = format!(
        "# Request\nKind: {}. Audience: {}. Tone: {}. Today: {today}.\nKey points from the user:\n{}\n\n{}",
        request.kind, or_none(&request.audience), or_none(&request.tone), or_none(&request.points), pack_text(&pack)
    );
    let (answer, cost) = call(deps, &store.dir, "draft", &format!("{DRAFT}\n\n{GROUNDING}"), draft_schema(), 0.25, &input);
    let mut out = answer?;
    out["evidence"] = json!(pack.evidence.iter().filter(|e| array(&out, "evidence").any(|id| id.as_str() == Some(e.id.as_str()))).collect::<Vec<_>>());
    out["packGaps"] = json!(pack.gaps);
    out["costUsd"] = json!(cost);
    Ok(out)
}

fn or_none(s: &str) -> &str {
    if s.trim().is_empty() { "not given" } else { s.trim() }
}

/// Revise a draft. `evidence` is what the draft was written from (the webview keeps it with the draft).
pub fn refine(store: &Store, deps: &Deps, subject: &str, body: &str, evidence: &[Evidence], instruction: &str) -> Result<Value, String> {
    if instruction.trim().is_empty() {
        return Err("Say how to change the draft".into());
    }
    let pack = Pack { evidence: evidence.to_vec(), gaps: vec![] };
    let input = format!("# Instruction\n{}\n\n# Draft\nSubject: {subject}\n\n{body}\n\n{}", instruction.trim(), pack_text(&pack));
    let (answer, cost) = call(deps, &store.dir, "refine", &format!("{REFINE}\n\n{GROUNDING}"), draft_schema(), 0.15, &input);
    let mut out = answer?;
    out["evidence"] = json!(evidence.iter().filter(|e| array(&out, "evidence").any(|id| id.as_str() == Some(e.id.as_str()))).collect::<Vec<_>>());
    out["costUsd"] = json!(cost);
    Ok(out)
}

/// Where a capture batch came from. Later connectors (mail, chat, tickets) add kinds here, behind the same review.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Source {
    /// "paste", "agent-session" or "draft-edits".
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// For an agent session: the last event seq the batch covers, so a later capture takes only what came after.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upto: Option<u64>,
}

const NOTE_KINDS: [&str; 5] = ["decision", "risk", "status", "knowledge", "preference"];

fn words(s: &str) -> BTreeSet<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 2).map(str::to_string).collect()
}

/// Title overlap (Jaccard over words longer than two letters): how a likely duplicate is told from a search neighbour.
pub fn overlap(a: &str, b: &str) -> f64 {
    let (a, b) = (words(a), words(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    a.intersection(&b).count() as f64 / a.union(&b).count() as f64
}

const SIMILAR: f64 = 0.5;

/// Existing notes or milestones an extracted item may repeat.
fn similar(lm: &Lm, domains: &[String], milestones: &[Value], item: &Value) -> Vec<Value> {
    let (kind, title) = (text(item, "kind"), text(item, "title"));
    if kind == "milestone" {
        return milestones.iter().filter(|m| overlap(&text(m, "title"), &title) >= SIMILAR)
            .map(|m| json!({"ref": format!("milestone:{}", text(m, "id")), "title": text(m, "title"), "type": "milestone"})).take(2).collect();
    }
    if !NOTE_KINDS.contains(&kind.as_str()) {
        return vec![];
    }
    let mut hits: Vec<Value> = vec![];
    for domain in domains {
        let Ok(found) = lm(&["search", &title, "--domain", domain, "--scope", "active", "--limit", "5"]) else { continue };
        for hit in array(&found, "results").filter(|h| text(h, "type") == kind && overlap(&text(h, "title"), &title) >= SIMILAR) {
            hits.push(json!({"ref": format!("{}:{}", text(hit, "domain"), text(hit, "id")), "title": text(hit, "title"), "type": text(hit, "type")}));
        }
    }
    hits.truncate(2);
    hits
}

/// Save what a call extracted as a capture batch for the user to review: each item gets an id, a pending state and the
/// existing records it may repeat. Returns None when nothing was extracted.
#[allow(clippy::too_many_arguments)] // each argument is one independent part of the batch
pub fn stage(lm: &Lm, store: &Store, answer: &Value, source: Source, project: Option<&str>, original: &str, cost: Option<f64>, now: u64) -> Result<Option<Value>, String> {
    let registry = lm(&["projects"])?;
    let slugs: Vec<String> = array(&registry, "projects").map(|p| text(p, "slug")).collect();
    let domains: Vec<String> = array(&registry, "projects").filter_map(|p| text(p, "charter").split_once(':').map(|(d, _)| d.to_string()))
        .collect::<BTreeSet<_>>().into_iter().collect();
    let milestones = store.list("milestone")?;
    let mut items = vec![];
    for (i, item) in array(answer, "items").filter(|i| !text(i, "title").trim().is_empty()).enumerate() {
        let mut item = item.clone();
        // A project the registry does not know is no project; the user picks one in review.
        let named = text(&item, "project");
        let slug = if slugs.contains(&named) { Some(named) } else { project.map(str::to_string) };
        item["project"] = json!(slug);
        item["id"] = json!(format!("i{}", i + 1));
        item["state"] = json!("pending");
        item["similar"] = json!(similar(lm, &domains, &milestones, &item));
        items.push(item);
    }
    if items.is_empty() && array(answer, "questions").next().is_none() {
        return Ok(None);
    }
    let record = json!({
        "source": source, "project": project, "text": clip(original, SOURCE_CHARS), "items": items,
        "questions": answer.get("questions").cloned().unwrap_or(json!([])), "costUsd": cost,
    });
    store.put("capture", record, now).map(Some)
}

/// The text a capture starts from, framed for the extractor.
fn extract_input(lm: &Lm, text_in: &str, project: Option<&str>, source: &Source, today: NaiveDate) -> Result<String, String> {
    let registry = lm(&["projects"])?;
    let list: Vec<String> = array(&registry, "projects").filter(|p| text(p, "status") != "archived")
        .map(|p| format!("- {} ({}): {}", text(p, "slug"), text(p, "name"), clip(&text(p, "description"), 160))).collect();
    Ok(format!(
        "# Capture\nToday: {today}. Source: {}. Project picked by the user: {}.\n\n## Projects\n{}\n\n## Text\n{}",
        source.label, project.unwrap_or("none (decide per item)"), if list.is_empty() { "None.".into() } else { list.join("\n") }, text_in
    ))
}

/// Extract items from free text and stage them for review.
#[allow(clippy::too_many_arguments)] // each argument is one independent part of the capture
pub fn extract(lm: &Lm, store: &Store, deps: &Deps, input: &str, project: Option<&str>, source: Source, today: NaiveDate) -> Result<Option<Value>, String> {
    if input.trim().is_empty() {
        return Err("Paste or type something to capture first".into());
    }
    let framed = extract_input(lm, &clip(input, SOURCE_CHARS), project, &source, today)?;
    let (answer, cost) = call(deps, &store.dir, "extract", EXTRACT, extract_schema(), 0.25, &framed);
    stage(lm, store, &answer?, source, project, input, cost, crate::agent::now_ms())
}

/// Preferences the user's edits to a generated draft show, staged for review like any capture.
/// Record that the draft `id` was learned from, if it still exists with the same generated text (it may have been deleted
/// or refined during the call). Only `learnedFrom` changes, so edits saved meanwhile are kept.
pub fn mark_learned(store: &Store, id: &str, generated: &str) -> Result<bool, String> {
    store.update("draft", id, |draft| {
        if draft.get("generated").and_then(Value::as_str) != Some(generated) {
            return false;
        }
        draft.insert("learnedFrom".into(), json!(generated));
        true
    })
}

pub fn learn_style(lm: &Lm, store: &Store, deps: &Deps, generated: &str, kept: &str, label: &str) -> Result<Option<Value>, String> {
    if generated.trim() == kept.trim() {
        return Ok(None);
    }
    let input = format!("# Generated\n{}\n\n# Kept by the user\n{}", clip(generated, 8000), clip(kept, 8000));
    let (answer, cost) = call(deps, &store.dir, "style", LEARN_STYLE, style_schema(), 0.1, &input);
    let items: Vec<Value> = array(&answer?, "preferences").map(|p| json!({
        "kind": "preference", "project": "", "title": text(p, "title"), "summary": text(p, "summary"), "details": [format!("Example: {}", text(p, "example"))],
        "owner": "", "due": "", "quote": text(p, "example"), "confidence": "medium",
    })).collect();
    let source = Source { kind: "draft-edits".into(), label: format!("Your edits to \"{}\"", clip(label, 80)), session: None, upto: None };
    stage(lm, store, &json!({"items": items, "questions": []}), source, None, kept, cost, crate::agent::now_ms())
}

const PREAMBLE: &str = "You are the executive assistant of an engineering leader, inside Hivemind. Answer from what is known: the evidence \
below and Living Memory's read commands (search, ask, read, open, list, recap) when you need more. Cite each fact with its evidence id (E3) or \
note ref. When the evidence does not answer the question, say what is missing instead of guessing, and say how the user could find out. You \
cannot save to memory or change records. When the user decides something, makes a commitment, names a risk or gives a status, restate it as \
one line that starts with \"Decision:\", \"Commitment:\", \"Risk:\" or \"Status:\" (a commitment ends with \"(owner: Name, due: YYYY-MM-DD)\" \
when they are known); Hivemind extracts those lines for the user to review when the conversation ends. Draft emails and updates when asked. \
Write plainly: lead with the answer, no filler, no em dashes, no emoji.";

/// The domains the executive chat reads: the charter domain of `project`, or of every active project. The briefing names
/// them and the chat's allow rules (`agent::scope::executive`) are built from them.
pub fn bound_domains(lm: &Lm, project: Option<&str>) -> Result<BTreeSet<String>, String> {
    let registry = lm(&["projects"])?;
    Ok(array(&registry, "projects")
        .filter(|p| project.map_or(text(p, "status") == "active", |slug| text(p, "slug") == slug))
        .filter_map(|p| text(p, "charter").split_once(':').map(|(d, _)| d.to_string()))
        .collect())
}

/// The executive chat's briefing: the preamble, the scope and the evidence.
pub fn agent_briefing(lm: &Lm, store: &Store, project: Option<&str>, today: NaiveDate) -> Result<String, String> {
    let pack = pack_within(lm, store, project, 14, today, AGENT_PACK_CHARS)?;
    let scope = project.map_or("all active projects".to_string(), |slug| format!("the project {}", project_name(lm, slug)));
    // The chat's folder is bound to no domain, so Living Memory's own session hook gives it no command: name them here.
    let domains = bound_domains(lm, project)?;
    let domain = domains.iter().next().map_or("DOMAIN", |d| d.as_str());
    let reads = format!("To read Living Memory, run its commands in the shell, one domain at a time (domains: {}): \
`alm --json --domain {domain} search 'query'`, `alm --json --domain {domain} ask 'question'`, `alm --json --domain {domain} read REF`, \
`alm --json open --all-domains --tag project/SLUG` for open action items.", if domains.is_empty() { "none bound".to_string() } else { domains.iter().cloned().collect::<Vec<_>>().join(", ") });
    Ok(format!("{PREAMBLE}\n\n{reads}\n\nToday is {today}. Scope: {scope}.\n\n{}", pack_text(&pack)))
}

/// One transcript line for an event, or None for events the extractor does not read.
fn transcript_line(event: &SeqEvent) -> Option<String> {
    match &event.event {
        RunEvent::UserMessage { text, .. } => Some(format!("\nUser: {}", clip(text.trim(), 3000))),
        RunEvent::Text { text } if !text.trim().is_empty() => Some(format!("Assistant: {}", clip(text.trim(), 3000))),
        _ => None,
    }
}

fn transcript_head(title: &str) -> String {
    format!("Conversation with the executive assistant: {title}")
}

/// An executive conversation for the extractor: what the user and the assistant said.
pub fn transcript(title: &str, events: &[SeqEvent]) -> String {
    let mut lines = vec![transcript_head(title)];
    lines.extend(events.iter().filter_map(transcript_line));
    let all = lines.join("\n");
    if all.chars().count() <= SOURCE_CHARS {
        return all;
    }
    let tail: String = all.chars().rev().take(SOURCE_CHARS).collect::<Vec<_>>().into_iter().rev().collect();
    format!("[... the start of the conversation is left out ...]\n{tail}")
}

/// How many of `events`, from the first, fit in one transcript the extractor reads whole (at least one), so a capture
/// covers only what it sent. A part ends before a user turn when one fits.
pub fn transcript_fits(title: &str, events: &[SeqEvent]) -> usize {
    let mut used = transcript_head(title).chars().count();
    for (i, event) in events.iter().enumerate() {
        let Some(line) = transcript_line(event) else { continue };
        used += line.chars().count() + 1;
        if used > SOURCE_CHARS && i > 0 {
            // Between turns when a whole turn fits; inside a turn otherwise (the next part resumes there).
            return events[..=i].iter().rposition(|e| matches!(e.event, RunEvent::UserMessage { .. })).filter(|&turn| turn > 0).unwrap_or(i);
        }
    }
    events.len()
}

/// The last event seq the capture batches of `session` cover (`Source::upto`). A batch saved before `upto` existed has no
/// exact boundary, so it covers nothing and its turns are offered again (the review flags repeats).
pub fn captured_upto(batches: &[Value], session: &str) -> Option<u64> {
    batches.iter().filter(|b| b.pointer("/source/session").and_then(Value::as_str) == Some(session))
        .filter_map(|b| b.pointer("/source/upto").and_then(Value::as_u64)).max()
}

/// What an executive conversation still owes the capture inbox: the finished events after `covered`. While a turn is
/// running (`busy`), that turn is left for a later capture, so a reply is never cut off by the cursor. A reply that a
/// split left after the cursor is owed too. None when nothing said is new, except that a manual capture then takes the
/// whole conversation again. The bool says whether the events start after an earlier capture.
pub fn session_window(covered: Option<u64>, events: &[SeqEvent], manual: bool, busy: bool) -> Option<(&[SeqEvent], bool)> {
    let turn = |e: &SeqEvent| matches!(e.event, RunEvent::UserMessage { .. });
    let finished = if busy { &events[..events.iter().rposition(turn).unwrap_or(0)] } else { events };
    let start = covered.map_or(0, |seq| finished.iter().position(|e| e.seq > seq).unwrap_or(finished.len()));
    if finished[start..].iter().any(|e| transcript_line(e).is_some()) {
        Some((&finished[start..], start > 0))
    } else if manual && finished.iter().any(turn) {
        Some((finished, false))
    } else {
        None
    }
}

/// Conversations being captured now, so a manual and an automatic capture of one conversation never both run.
#[derive(Default)]
pub struct Claims {
    held: Mutex<BTreeSet<String>>,
    freed: std::sync::Condvar,
}

/// Held while a conversation is captured; dropping it frees the conversation.
pub struct Claim<'a>(&'a Claims, String);

impl Claims {
    /// The conversation, or None while another capture of it runs.
    pub fn claim(&self, id: &str) -> Option<Claim<'_>> {
        self.held.lock().unwrap().insert(id.to_string()).then(|| Claim(self, id.to_string()))
    }

    /// The conversation, once any capture of it that is running has ended.
    pub fn wait(&self, id: &str) -> Claim<'_> {
        let mut held = self.held.lock().unwrap();
        while !held.insert(id.to_string()) {
            held = self.freed.wait(held).unwrap();
        }
        Claim(self, id.to_string())
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.0.held.lock().unwrap().remove(&self.1);
        self.0.freed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-exec-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        dir
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, 19).unwrap()
    }

    #[test]
    fn records_round_trip_and_bad_names_are_refused() {
        let dir = temp("store");
        let store = Store::new(dir.clone());
        let saved = store.put("milestone", json!({"project": "pay", "title": "Beta"}), 5).unwrap();
        let id = text(&saved, "id");
        assert!(valid_id(&id) && saved["created"] == 5 && saved["updated"] == 5);
        let again = store.put("milestone", json!({"id": id, "project": "pay", "title": "Beta 2", "created": 5}), 9).unwrap();
        assert_eq!((again["created"].as_u64(), again["updated"].as_u64()), (Some(5), Some(9)));
        assert_eq!(store.list("milestone").unwrap().len(), 1);
        assert_eq!(text(&store.list("milestone").unwrap()[0], "title"), "Beta 2");
        assert!(store.put("secrets", json!({}), 1).is_err());
        assert!(store.put("milestone", json!({"id": "../x"}), 1).is_err());
        assert!(store.put("milestone", json!([1]), 1).is_err());
        assert!(store.delete("milestone", "..\\x").is_err());
        std::fs::write(dir.join("milestone").join("broken.json"), "{not json").unwrap();
        assert_eq!(store.list("milestone").unwrap().len(), 1, "an unreadable file is left out");
        assert!(!dir.join("milestone").join("broken.json").exists(), "and renamed aside");
        store.delete("milestone", &id).unwrap();
        store.delete("milestone", &id).unwrap();
        assert!(store.list("milestone").unwrap().is_empty());
        assert!(store.list("draft").unwrap().is_empty(), "a kind with no folder yet lists nothing");
        // Any other read error is reported, not shown as no records, and a file that cannot be read is not set aside
        // (EXEC-8).
        std::fs::write(dir.join("briefing"), "not a folder").unwrap();
        assert!(store.list("briefing").unwrap_err().contains("Could not read the briefing records"));
        std::fs::create_dir_all(dir.join("milestone").join("odd.json")).unwrap();
        assert!(store.list("milestone").unwrap_err().contains("odd.json"), "the error names the file");
        assert!(dir.join("milestone").join("odd.json").exists());
        std::fs::remove_dir_all(dir.join("milestone").join("odd.json")).unwrap();
        // Bytes that are not UTF-8 are set aside like any malformed record (Codex review of 7921fcb).
        std::fs::write(dir.join("milestone").join("latin.json"), [0xff, 0xfe, b'{']).unwrap();
        assert!(store.list("milestone").unwrap().is_empty());
        assert!(!dir.join("milestone").join("latin.json").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_learned_draft_is_marked_only_if_it_is_still_the_same() {   // Codex review of 34c668a
        let dir = temp("learned");
        let store = Store::new(dir.clone());
        let d = store.put("draft", json!({"subject": "Plan", "body": "Edited later", "generated": "v1"}), 5).unwrap();
        let id = text(&d, "id");
        assert!(mark_learned(&store, &id, "v1").unwrap());
        let now = &store.list("draft").unwrap()[0];
        assert_eq!((text(now, "learnedFrom"), text(now, "body"), now["updated"].as_u64()), ("v1".into(), "Edited later".into(), Some(5)));
        store.put("draft", json!({"id": id, "generated": "v2", "created": 5}), 9).unwrap();
        assert!(!mark_learned(&store, &id, "v1").unwrap(), "a refined draft is not marked by the older call");
        // The size limit holds here too (Codex re-review of 61a3474).
        let big = "x".repeat(MAX_RECORD / 2 + 10);
        store.put("draft", json!({"id": id, "generated": big, "created": 5}), 10).unwrap();
        assert!(mark_learned(&store, &id, &big).unwrap_err().contains("too large"));
        store.delete("draft", &id).unwrap();
        assert!(!mark_learned(&store, &id, "v2").unwrap());
        assert!(store.list("draft").unwrap().is_empty(), "a deleted draft is not recreated");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn due_dates_are_read_from_the_commitment_convention() {
        assert_eq!(due_of("Send the plan (owner: Dana, due: 2026-11-25)"), NaiveDate::from_ymd_opt(2026, 11, 25));
        assert_eq!(due_of("Send the plan (Due:2026-01-02)"), NaiveDate::from_ymd_opt(2026, 1, 2));
        assert_eq!(due_of("Send the plan (due: soon)"), None);
        assert_eq!(due_of("Send the plan"), None);
    }

    /// A fake Living Memory: one project with an overdue commitment, a decision, a risk, an old status and a style note.
    fn fake(argv: &[&str]) -> Result<Value, String> {
        Ok(match argv[0] {
            "projects" => json!({"projects": [
                {"slug": "pay", "name": "PayStream", "status": "active", "charter": "paystream:c1", "description": "Payments"},
                {"slug": "old", "name": "Old", "status": "archived", "charter": "paystream:c2"}]}),
            "open" if argv.contains(&"--tag") => json!({"items": [{"ref": "paystream:p1", "title": "Commitments: PayStream", "item": "Send the Q3 plan (owner: Dana, due: 2026-11-10)"}]}),
            "open" => json!({"items": [
                {"ref": "paystream:p1", "title": "Commitments: PayStream", "item": "Send the Q3 plan (owner: Dana, due: 2026-11-10)"},
                {"ref": "paystream:x1", "title": "Commitments: Cross-project", "item": "Hire a staff engineer (owner: Lee, due: 2026-12-15)"}]}),
            "list" if argv.contains(&"preference") => json!({"notes": [
                {"ref": "_global:w1", "title": "Writing preference: no greeting", "type": "preference", "summary": "Skip greetings in email.", "updated": "2026-11-01"},
                {"ref": "_global:w2", "title": "Use tabs", "type": "preference", "summary": "Indent code with tabs.", "updated": "2026-11-01"}]}),
            "list" => json!({"notes": [
                {"ref": "paystream:d1", "title": "Use event IDs as keys", "type": "decision", "summary": "Dedupe by event ID.", "updated": "2026-11-18T10:00:00"},
                {"ref": "paystream:d0", "title": "Old decision", "type": "decision", "summary": "Long ago.", "updated": "2026-01-01T10:00:00"},
                {"ref": "paystream:r1", "title": "Provider rate limit", "type": "risk", "summary": "Replays may hit the limit.", "updated": "2026-09-01"},
                {"ref": "paystream:s1", "title": "PayStream status", "type": "status", "summary": "On track.", "updated": "2026-10-01"}]}),
            "search" => json!({"results": [
                {"id": "d1", "domain": "paystream", "title": "Use event IDs as keys", "type": "decision"},
                {"id": "x", "domain": "paystream", "title": "Something unrelated", "type": "decision"}]}),
            other => return Err(format!("unexpected {other}")),
        })
    }

    #[test]
    fn the_pack_cites_what_matters_and_names_the_gaps() {
        let dir = temp("pack");
        let store = Store::new(dir.clone());
        store.put("milestone", json!({"project": "pay", "title": "Beta", "due": "2026-11-01", "status": "planned"}), 1).unwrap();
        let pack = pack(&fake, &store, None, 7, today()).unwrap();
        let titles: Vec<&str> = pack.evidence.iter().map(|e| e.title.as_str()).collect();
        assert!(titles.contains(&"Beta") && titles.contains(&"Use event IDs as keys") && titles.contains(&"Provider rate limit"), "{titles:?}");
        assert!(titles.contains(&"PayStream status"), "the latest status is kept even when old");
        assert!(!titles.contains(&"Old decision"), "a decision outside the period is left out");
        assert!(titles.contains(&"Writing preference: no greeting") && !titles.contains(&"Use tabs"));
        let commitment = pack.evidence.iter().find(|e| e.kind == "action item").unwrap();
        assert!(commitment.text.contains("Overdue since 2026-11-10") && commitment.reference.as_deref() == Some("paystream:p1"));
        assert!(pack.evidence.iter().find(|e| e.title == "Beta").unwrap().text.contains("Overdue."));
        assert_eq!(pack.evidence.iter().map(|e| e.id.clone()).collect::<Vec<_>>()[..2], ["E1", "E2"]);
        assert!(pack.gaps.iter().any(|g| g.contains("no project health")) && pack.gaps.iter().any(|g| g.contains("no status update")));
        assert!(!pack.evidence.iter().any(|e| e.project.as_deref() == Some("Old")), "archived projects are left out");
        let loose: Vec<&str> = pack.evidence.iter().filter(|e| e.text.starts_with("Cross-project")).map(|e| e.title.as_str()).collect();
        assert_eq!(loose, ["Hire a staff engineer (owner: Lee, due: 2026-12-15)"], "cross-project commitments, once");
        let one = super::pack(&fake, &store, Some("pay"), 7, today()).unwrap();
        assert!(!one.evidence.iter().any(|e| e.text.starts_with("Cross-project")), "a project's pack leaves them out");
        let text = pack_text(&pack);
        assert!(text.contains("[E1] (") && text.contains("## Known gaps\n- "));
        assert!(super::pack(&fake, &store, Some("nope"), 7, today()).is_err());
        let small = pack_within(&fake, &store, None, 7, today(), 150).unwrap();
        assert!(small.evidence.len() < pack.evidence.len() && small.gaps.iter().any(|g| g.contains("cut to fit")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staged_items_carry_ids_projects_and_likely_repeats() {
        let dir = temp("stage");
        let store = Store::new(dir.clone());
        let answer = json!({"items": [
            {"kind": "decision", "project": "pay", "title": "Use event IDs as keys", "summary": "S", "details": [], "owner": "", "due": "", "quote": "q", "confidence": "high"},
            {"kind": "commitment", "project": "nowhere", "title": "Send the plan", "summary": "S", "details": [], "owner": "Dana", "due": "", "quote": "q", "confidence": "high"},
            {"kind": "risk", "project": "", "title": " ", "summary": "", "details": [], "owner": "", "due": "", "quote": "", "confidence": "low"}],
            "questions": ["Who owns the plan?"]});
        let source = Source { kind: "paste".into(), label: "Standup".into(), session: None, upto: None };
        let saved = stage(&fake, &store, &answer, source.clone(), None, "notes", Some(0.01), 7).unwrap().unwrap();
        let items: Vec<&Value> = array(&saved, "items").collect();
        assert_eq!(items.len(), 2, "an item without a title is dropped");
        assert_eq!((text(items[0], "id"), text(items[0], "state")), ("i1".into(), "pending".into()));
        assert_eq!(items[0]["similar"][0]["ref"], "paystream:d1");
        assert_eq!(items[0]["similar"].as_array().unwrap().len(), 1, "an unrelated search hit is not a repeat");
        assert_eq!(items[1]["project"], Value::Null, "an unknown project becomes none");
        assert_eq!(saved["source"]["label"], "Standup");
        assert!(stage(&fake, &store, &json!({"items": [], "questions": []}), source, None, "", None, 8).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn overlap_tells_repeats_from_neighbours() {
        assert!(overlap("Use event IDs as keys", "Use event IDs as the keys") >= SIMILAR);
        assert!(overlap("Use event IDs as keys", "Rate limit on replays") < SIMILAR);
        assert_eq!(overlap("", "x"), 0.0);
    }

    #[test]
    fn schemas_are_valid_json_objects() {
        for schema in [extract_schema(), draft_schema(), brief_schema(), style_schema()] {
            assert_eq!(schema["type"], "object");
            assert!(schema["required"].as_array().is_some_and(|r| !r.is_empty()));
        }
    }

    #[test]
    fn the_agent_briefing_has_the_rules_and_the_evidence() {
        let dir = temp("briefing");
        let store = Store::new(dir.clone());
        let text = agent_briefing(&fake, &store, Some("pay"), today()).unwrap();
        assert!(text.starts_with("You are the executive assistant") && text.contains("Scope: the project PayStream") && text.contains("[E1]"));
        assert!(text.contains("`alm --json --domain paystream search 'query'`"), "{text}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A temporary store with the PayStream project, through a real Living Memory, when HIVEMIND_TEST_LM_SCRIPT is set.
    fn live_store(name: &str) -> Option<(PathBuf, crate::bridge::Bridge)> {
        use crate::{bridge::Bridge, settings::Launch};
        let script = std::env::var("HIVEMIND_TEST_LM_SCRIPT").ok()?;
        let base = temp(name);
        let (root, repo) = (base.join("store"), base.join("repo"));
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("bindings.json"), "{}").unwrap();
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let bridge = Bridge::new(Launch { program, args, script: script.into(), root: Some(root.clone()) });
        let ok = |argv: &[&str], stdin: Option<&str>| live_call(&bridge, argv, stdin);
        ok(&["bind", "pay", repo.to_str().unwrap()], None);
        std::fs::write(root.join("tag_taxonomy.json"), r#"{"tags":["subject/project","concern/decision","concern/planning","concern/knowledge","concern/risk","concern/status"]}"#).unwrap();
        let repo_text = repo.display().to_string().replace('\\', "/");
        ok(&["project", "create"], Some(&json!({"slug": "pay", "name": "PayStream", "repos": [repo_text], "charter": {"domain": "pay", "body": "Payments."}}).to_string()));
        Some((base, bridge))
    }

    fn live_call(bridge: &crate::bridge::Bridge, argv: &[&str], stdin: Option<&str>) -> Value {
        let reply = bridge.call(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(), stdin).unwrap();
        assert_eq!(reply.exit_code, 0, "{argv:?}: {:?}", reply.error);
        reply.result
    }

    /// End to end against a real Living Memory in a temporary store, with the writes the review dialog makes: the pack
    /// finds a decision and an overdue commitment, staging flags a repeat, and accepted items persist and are found again.
    /// Runs only when HIVEMIND_TEST_LM_SCRIPT points at a living_memory.py (optionally HIVEMIND_TEST_PYTHON).
    #[test]
    fn live_capture_round_trip() {
        let Some((base, bridge)) = live_store("live") else { return };
        let call = |argv: &[&str], stdin: Option<&str>| live_call(&bridge, argv, stdin);
        let tags = json!(["concern/decision", "project/pay"]);
        let decision = call(&["capture", "--domain", "pay"], Some(&json!({"title": "Use event IDs as idempotency keys", "type": "decision", "tags": tags,
            "body": "Dedupe payment events by their event ID.\n\n## Why\nProviders resend events."}).to_string()));
        let old = format!("pay:{}", text(&decision, "id"));
        let plan = call(&["capture", "--domain", "pay"], Some(&json!({"title": "Commitments: PayStream", "type": "plan", "tags": ["concern/planning", "project/pay"],
            "body": "Commitments for PayStream.\n\n## Action items\n- [ ] Send the Q3 plan (owner: Dana, due: 2026-11-10)"}).to_string()));
        let plan_ref = format!("pay:{}", text(&plan, "id"));

        let store = Store::new(base.join("executive"));
        let lm = viewer(&bridge);
        let found = pack(&lm, &store, Some("pay"), 7, today()).unwrap();
        assert!(found.evidence.iter().any(|e| e.reference.as_deref() == Some(old.as_str()) && e.kind == "decision"), "{found:?}");
        assert!(found.evidence.iter().any(|e| e.kind == "action item" && e.text.contains("Overdue since 2026-11-10")), "{found:?}");
        assert!(found.gaps.iter().any(|g| g.contains("no status update")));

        let answer = json!({"items": [
            {"kind": "decision", "project": "pay", "title": "Use event IDs as the idempotency keys", "summary": "Dedupe by event ID, kept for 30 days.", "details": [],
             "owner": "", "due": "", "quote": "keep event ids for 30 days", "confidence": "high"},
            {"kind": "commitment", "project": "pay", "title": "Review the retention window", "summary": "", "details": [], "owner": "Sam", "due": "2026-12-01", "quote": "", "confidence": "medium"}],
            "questions": []});
        let staged = stage(&lm, &store, &answer, Source { kind: "paste".into(), label: "Sync".into(), session: None, upto: None }, Some("pay"), "notes", None, 1).unwrap().unwrap();
        assert_eq!(staged["items"][0]["similar"][0]["ref"], json!(old), "the repeat is found");

        // What accepting does (lib/executive items.ts): the decision replaces the old one, the commitment joins the list.
        let body = "Dedupe by event ID, kept for 30 days.\n\n## Source\nCaptured in Hivemind from \"Sync\" on 2026-11-19: \"keep event ids for 30 days\"";
        let new = call(&["capture", "--domain", "pay"], Some(&json!({"title": "Use event IDs as the idempotency keys", "type": "decision", "tags": tags, "body": body,
            "supersedes": [old], "origin": "hivemind:local"}).to_string()));
        call(&["update", &plan_ref, "--domain", "pay", "--add-action", "Review the retention window (owner: Sam, due: 2026-12-01)"], None);
        let replaced = call(&["read", &old, "--domain", "pay", "--actor", "viewer"], None);
        assert_eq!(text(&replaced, "status"), "superseded");
        let open = call(&["open", "--all-domains", "--tag", "project/pay", "--actor", "viewer"], None);
        let items: Vec<String> = array(&open, "items").map(|i| text(i, "item")).collect();
        assert!(items.iter().any(|i| i == "Review the retention window (owner: Sam, due: 2026-12-01)"), "{items:?}");
        assert_eq!(items.iter().filter_map(|i| due_of(i)).count(), 2);
        let hits = call(&["search", "idempotency keys", "--domain", "pay", "--actor", "viewer"], None);
        assert!(array(&hits, "results").any(|h| text(h, "id") == text(&new, "id")), "the accepted note is found again");
        drop(lm);
        drop(bridge);
        std::fs::remove_dir_all(&base).ok();
    }

    /// The real model calls, against a real Living Memory and Claude Code, with a ledger of their own. Costs about $1 at
    /// most. Runs only when HIVEMIND_TEST_LM_SCRIPT and HIVEMIND_TEST_CLAUDE (the claude program) are both set.
    #[test]
    fn live_model_calls() {
        let Ok(claude) = std::env::var("HIVEMIND_TEST_CLAUDE") else { return };
        let Some((base, bridge)) = live_store("model") else { return };
        let call = |argv: &[&str], stdin: Option<&str>| live_call(&bridge, argv, stdin);
        call(&["capture", "--domain", "pay"], Some(&json!({"title": "Provider rate limit during replays", "type": "risk", "tags": ["concern/risk", "project/pay"],
            "body": "Replaying a day of events can exceed the provider's rate limit and delay alerts."}).to_string()));
        let store = Store::new(base.join("executive"));
        store.put("milestone", json!({"project": "pay", "title": "Public beta", "due": "2026-12-05", "status": "planned", "note": ""}), 1).unwrap();
        let ledger = Ledger::new(base.join("spend.json"));
        let deps = Deps { claude, ledger: &ledger, cap: 2.0, cancel: None };
        let lm = viewer(&bridge);
        let notes = "Platform sync, 19 Nov.\nWe decided to keep event IDs for 30 days so late redeliveries are still deduplicated.\n\
            Dana will send the Q3 plan to the VP by 25 November.\nRisk: the provider may throttle replays; Sam owns a rate ceiling flag.\nBeta is still on track for 5 December.";
        let source = Source { kind: "paste".into(), label: "Platform sync".into(), session: None, upto: None };
        let batch = extract(&lm, &store, &deps, notes, None, source, today()).unwrap().expect("something to keep");
        let kinds: Vec<String> = array(&batch, "items").map(|i| text(i, "kind")).collect();
        assert!(kinds.contains(&"decision".to_string()) && kinds.contains(&"commitment".to_string()), "{batch:#}");
        let commitment = array(&batch, "items").find(|i| text(i, "kind") == "commitment").unwrap();
        assert_eq!((text(commitment, "owner"), text(commitment, "due")), ("Dana".to_string(), "2026-11-25".to_string()), "{commitment:#}");

        let briefing = brief(&lm, &store, &deps, "weekly", None, 7, "manual", today()).unwrap();
        let ids: Vec<String> = array(&briefing, "evidence").map(|e| text(e, "id")).collect();
        let cited: Vec<String> = array(&briefing, "sections").flat_map(|s| array(s, "bullets")).flat_map(|b| array(b, "evidence")).filter_map(|e| e.as_str().map(String::from)).collect();
        assert!(!cited.is_empty() && cited.iter().all(|c| ids.contains(c)), "every citation is in the pack: {briefing:#}");
        assert_eq!(store.list("briefing").unwrap().len(), 1);

        let request = DraftRequest { kind: "escalation".into(), audience: "VP Engineering".into(), tone: "direct".into(), points: "Replays may delay alerts; we need the rate ceiling flag before beta.".into(), project: Some("pay".into()) };
        let drafted = draft(&lm, &store, &deps, &request, today()).unwrap();
        assert!(!text(&drafted, "subject").is_empty() && !text(&drafted, "body").is_empty(), "{drafted:#}");
        let evidence: Vec<Evidence> = serde_json::from_value(drafted["evidence"].clone()).unwrap();
        let shorter = refine(&store, &deps, &text(&drafted, "subject"), &text(&drafted, "body"), &evidence, "Make it at most four sentences").unwrap();
        assert!(!text(&shorter, "body").is_empty());
        let kept = format!("{}\n\nNo greeting, no sign-off: the ask is in the first line.", text(&shorter, "body").lines().skip(1).collect::<Vec<_>>().join("\n"));
        learn_style(&lm, &store, &deps, &text(&shorter, "body"), &kept, "Escalation").unwrap();
        assert!(ledger.used(crate::agent::now_ms()) > 0.0, "the calls are counted");
        drop(lm);
        drop(bridge);
        std::fs::remove_dir_all(&base).ok();
    }

    /// What one probe turn did: each command the model tried with its tool result (None when none came back), and the
    /// commands Claude Code refused.
    struct Probed {
        tried: Vec<(String, Option<(bool, String)>)>,
        denied: Vec<String>,
    }

    /// Run one executive chat turn that asks the model to run `commands`, each once. Gives up after three minutes; the CLI
    /// and everything it started are ended either way.
    fn probe(spec: &crate::agent::scope::Spec, commands: &[&str]) -> Probed {
        use crate::agent::{claude::ClaudeCode, Adapter};
        use std::io::{BufRead, BufReader, Write};
        use std::time::Instant;
        let list: Vec<String> = commands.iter().enumerate().map(|(i, c)| format!("{}. {c}", i + 1)).collect();
        let prompt = format!("This is an automated test of this session's permission rules. Run each of these commands once with the Bash tool, \
            exactly as written, one per tool call, then reply DONE. Run nothing else.\n{}", list.join("\n"));
        let mut command = ClaudeCode.command(spec);
        command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        let mut child = command.spawn().expect("claude starts");
        let line = json!({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}});
        writeln!(child.stdin.as_mut().unwrap(), "{line}").unwrap();
        let (lines, received) = std::sync::mpsc::channel();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || BufReader::new(stdout).lines().map_while(Result::ok).try_for_each(|l| lines.send(l)));
        let deadline = Instant::now() + Duration::from_secs(180);
        let (mut uses, mut results, mut result) = (Vec::<(String, String)>::new(), std::collections::HashMap::new(), None);
        while let Some(left) = deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()) {
            let Ok(line) = received.recv_timeout(left) else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            for block in value["message"]["content"].as_array().into_iter().flatten() {
                let id = block["id"].as_str().or(block["tool_use_id"].as_str()).unwrap_or_default().to_string();
                if value["type"] == "assistant" && block["type"] == "tool_use" {
                    uses.extend(block["input"]["command"].as_str().map(|c| (id, c.to_string())));
                } else if value["type"] == "user" && block["type"] == "tool_result" {
                    let content = match &block["content"] {
                        Value::String(s) => s.clone(),
                        other => array(&json!({"c": other}), "c").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n"),
                    };
                    results.insert(id, (block["is_error"] != json!(true), content));
                }
            }
            if value["type"] == "result" && Instant::now() < deadline {
                result = Some(value);
                break;
            }
        }
        drop(child.stdin.take());
        crate::git::kill_tree(&mut child);
        child.wait().ok();
        let result = result.expect("the CLI sent a result within three minutes");
        Probed {
            tried: uses.into_iter().map(|(id, command)| (command, results.get(&id).cloned())).collect(),
            denied: array(&result, "permission_denials").filter_map(|d| d["tool_input"]["command"].as_str().map(String::from)).collect(),
        }
    }

    /// EXEC-14: the executive chat's real launch (isolated, never asking, `scope::executive` rules) against a temporary
    /// store. Claude Code must refuse a write, and a read that an allow rule lets through but a deny rule names; a control
    /// run without the `capture` deny rules must run that read and get Living Memory's answer, so the deny rule, not a
    /// missing allow rule, refused it. The store must gain no note. Costs a few cents. Runs only when HIVEMIND_TEST_LM_SCRIPT
    /// and HIVEMIND_TEST_CLAUDE are both set; `alm` must be on PATH.
    #[test]
    fn live_executive_chat_is_refused_memory_writes() {
        use crate::agent::scope;
        let Ok(claude) = std::env::var("HIVEMIND_TEST_CLAUDE") else { return };
        let Some((base, bridge)) = live_store("deny") else { return };
        let made = scope::executive(&base.join("chat"), "Executive: probe".into(), &["pay".to_string()]).unwrap();
        let spec = |deny: Vec<String>| scope::Spec {
            session_id: uuid::Uuid::new_v4().to_string(), cwd: made.cwd.clone(), add_dirs: vec![], policy: made.policy.clone(), plugin_dirs: vec![],
            budget_usd: 0.5, schema: None, program: claude.clone(), program_args: vec![], resume: false, model: Some("haiku".into()),
            deny, isolated: made.isolated, memory_root: bridge.launch().root,
        };
        let write = "alm --json --domain pay capture --type knowledge --title 'Permission probe' --summary 'A probe.'";
        // A search for the word "capture": allowed by `alm --json --domain pay search *`, named by `*alm* capture`.
        let masked = "alm --json --domain pay search capture";
        let tried = |run: &Probed, command: &str| run.tried.iter().any(|(c, _)| c == command);

        let run = probe(&spec(made.deny.clone()), &[masked, write]);
        eprintln!("tried {:?}\ndenied {:?}", run.tried, run.denied);
        for command in [masked, write] {
            assert!(tried(&run, command), "the model did not try `{command}`, so the rule went untested (tried {:?}); run again", run.tried);
            assert!(run.denied.iter().any(|c| c == command), "`{command}` was not refused: denials {:?}", run.denied);
        }
        let without: Vec<String> = made.deny.iter().filter(|rule| !rule.contains(" capture")).cloned().collect();
        assert!(without.len() < made.deny.len(), "the capture deny rules exist");
        let control = probe(&spec(without), &[masked]);
        eprintln!("control: tried {:?}\ndenied {:?}", control.tried, control.denied);
        let answer = control.tried.iter().find(|(c, _)| c == masked).map(|(_, r)| r.clone());
        let Some(Some((ok, output))) = answer else { panic!("the model did not run `{masked}` in the control run (tried {:?}); run again", control.tried) };
        let reply: Option<Value> = output.lines().find_map(|l| serde_json::from_str(l.trim()).ok());
        assert!(ok && reply.as_ref().is_some_and(|r| r["ok"] == json!(true)), "the allowed read did not succeed, so the first run proved nothing: {output}");

        let hits = live_call(&bridge, &["search", "Permission probe", "--domain", "pay", "--actor", "viewer"], None);
        assert!(!array(&hits, "results").any(|h| text(h, "title") == "Permission probe"), "the write reached the store");
        drop(bridge);
        std::fs::remove_dir_all(&base).ok();
    }

    fn turn_events(texts: &[(bool, &str)]) -> Vec<SeqEvent> {
        texts.iter().enumerate().map(|(i, (user, text))| SeqEvent { session_id: "s".into(), seq: i as u64, at: i as u64, event: if *user {
            RunEvent::UserMessage { text: text.to_string(), context: vec![] } } else { RunEvent::Text { text: text.to_string() } } }).collect()
    }

    fn seqs(window: Option<(&[SeqEvent], bool)>) -> Option<(Vec<u64>, bool)> {
        window.map(|(events, later)| (events.iter().map(|e| e.seq).collect(), later))
    }

    #[test]
    fn a_capture_takes_only_the_turns_after_the_last_batch() {   // EXEC-4
        let events = turn_events(&[(true, "turn 0"), (false, "reply 1"), (true, "turn 2"), (false, "reply 3")]);
        // Nothing captured yet: everything.
        assert_eq!(seqs(session_window(None, &events, false, false)), Some((vec![0, 1, 2, 3], false)));
        // A manual capture after the first reply: the session end takes the later turn only (the old code skipped it).
        assert_eq!(seqs(session_window(Some(1), &events, false, false)), Some((vec![2, 3], true)));
        // Everything captured: the session end skips; asked by hand, the whole conversation is taken again.
        assert_eq!(seqs(session_window(Some(3), &events, false, false)), None);
        assert_eq!(seqs(session_window(Some(3), &events, true, false)), Some((vec![0, 1, 2, 3], false)));
        // The rest of a reply that a split left after the cursor is owed (Codex re-review of 545f75e); events with no
        // text are not.
        let only_reply = turn_events(&[(true, "turn 0"), (false, "reply 1"), (false, "reply 2"), (false, " ")]);
        assert_eq!(seqs(session_window(Some(1), &only_reply, false, false)), Some((vec![2, 3], true)));
        assert_eq!(seqs(session_window(Some(2), &only_reply, false, false)), None);
        assert_eq!(seqs(session_window(None, &[], true, false)), None);
    }

    #[test]
    fn a_running_turn_is_left_for_a_later_capture() {   // EXEC-4, Codex review of d352d27
        // Captured by hand while turn 2 runs: only the finished turn, so the cursor stops before turn 2 and its reply.
        let running = turn_events(&[(true, "turn 0"), (false, "reply 1"), (true, "turn 2"), (false, "half a reply")]);
        assert_eq!(seqs(session_window(None, &running, true, true)), Some((vec![0, 1], false)));
        // When the session ends, turn 2 and its whole reply are still owed.
        let ended = turn_events(&[(true, "turn 0"), (false, "reply 1"), (true, "turn 2"), (false, "half a reply"), (false, "the rest")]);
        assert_eq!(seqs(session_window(Some(1), &ended, false, false)), Some((vec![2, 3, 4], true)));
        // The only turn still running: nothing to capture yet.
        assert_eq!(seqs(session_window(None, &running[..2], true, true)), None);
    }

    #[test]
    fn captured_upto_reads_only_exact_cursors_of_the_conversation() {   // EXEC-4
        let batches = [
            json!({"source": {"session": "s", "upto": 1}}),
            json!({"source": {"session": "s", "upto": 4}}),
            json!({"source": {"session": "t", "upto": 9}}),
            // Saved before upto existed: no exact boundary, so it covers nothing (Codex review of d352d27).
            json!({"source": {"session": "s"}, "created": 99}),
        ];
        assert_eq!(captured_upto(&batches, "s"), Some(4));
        assert_eq!(captured_upto(&batches[3..], "s"), None);
        assert_eq!(captured_upto(&batches, "u"), None);
    }

    #[test]
    fn a_long_window_is_sent_in_parts_the_extractor_reads_whole() {   // EXEC-4, Codex review of d352d27
        let long = "x".repeat(2900);
        let events = turn_events(&(0..20).map(|i| (i % 2 == 0, long.as_str())).collect::<Vec<_>>());
        let first = transcript_fits("Sync", &events);
        assert!(first > 0 && first < events.len(), "{first}");
        assert!(!transcript("Sync", &events[..first]).contains("left out"), "the first part is read whole");
        assert!(transcript("Sync", &events[..first + 2]).chars().count() > SOURCE_CHARS, "and holds every whole turn that fits");
        let rest = &events[first..];
        assert!(!transcript("Sync", &rest[..transcript_fits("Sync", rest)]).contains("left out"));
        assert_eq!(transcript_fits("Sync", &events[..3]), 3);
        assert_eq!(transcript_fits("Sync", &[]), 0);
        // A part ends before a user turn when one fits (here each turn is a user line and a reply).
        assert!(matches!(events[first].event, RunEvent::UserMessage { .. }), "split between turns");
        // One turn too long for a part: split inside it, and the rest of the reply is still owed.
        let one = turn_events(&(0..9).map(|i| (i == 0, long.as_str())).collect::<Vec<_>>());
        let cut = transcript_fits("Sync", &one);
        assert!(cut > 1 && cut < one.len(), "{cut}");
        assert_eq!(seqs(session_window(Some(one[cut - 1].seq), &one, false, false)).map(|(e, _)| e.len()), Some(one.len() - cut));
    }

    #[test]
    fn the_capture_cursor_is_kept_apart_from_the_records() {   // EXEC-4, Codex re-review of 545f75e
        let dir = temp("cursor");
        let store = Store::new(dir.clone());
        assert_eq!(store.capture_cursor("s-1"), None);
        store.set_capture_cursor("s-1", 7).unwrap();
        assert_eq!(store.capture_cursor("s-1"), Some(7));
        assert!(store.set_capture_cursor("../x", 1).is_err());
        assert!(store.list("capture").unwrap().is_empty(), "no batch is made for it");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_capture_of_a_conversation_runs_at_a_time() {   // EXEC-4
        let claims = std::sync::Arc::new(Claims::default());
        let held = claims.claim("s").expect("free");
        assert!(claims.claim("s").is_none(), "a second manual capture of the same conversation is refused");
        assert!(claims.claim("t").is_some(), "another conversation is not blocked");
        // The session-end capture waits for the manual one instead of giving up (Codex review of d352d27).
        let (waiting, done) = (claims.clone(), std::sync::mpsc::channel());
        let thread = std::thread::spawn(move || {
            let _claim = waiting.wait("s");
            done.0.send(()).unwrap();
        });
        assert!(done.1.recv_timeout(Duration::from_millis(200)).is_err(), "it waits while the manual capture runs");
        drop(held);
        done.1.recv_timeout(Duration::from_secs(5)).expect("it runs once the manual capture ends");
        thread.join().unwrap();
        assert!(claims.claim("s").is_some(), "freed when the capture ends, failed or not");
    }

    #[test]
    fn a_transcript_keeps_what_was_said() {
        let ev = |event| SeqEvent { session_id: "s".into(), seq: 0, at: 0, event };
        let events = vec![
            ev(RunEvent::UserMessage { text: "We decided to ship Friday".into(), context: vec![] }),
            ev(RunEvent::Text { text: "Decision: ship on Friday [E2]".into() }),
        ];
        let text = transcript("Weekly sync", &events);
        assert!(text.contains("User: We decided to ship Friday") && text.contains("Assistant: Decision: ship on Friday"));
    }
}
