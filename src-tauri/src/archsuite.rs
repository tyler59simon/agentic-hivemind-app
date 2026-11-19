//! The Architecture Suite's command line, run headless: `diff`, `check` and `verify` with their JSON outputs. Hivemind
//! writes their results under `app_data_dir/architecture-runs/<system>/`, never into the system's architecture folder
//! (only a passport session writes there). Drift puts together what the Suite and git can tell about a system: commits
//! since its output was made, output files edited by hand, structural changes since the previous model, rule findings
//! and diagram layout problems.
use crate::agent::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const MANIFEST: &str = ".architecture-suite-manifest.json";
const MODEL: &str = "architecture-model.json";
const SCRIPT: &str = "skills/architecture-suite-runtime/scripts/architecture-suite.py";
const TIMEOUT: Duration = Duration::from_secs(180);
/// Runs kept per system.
const RUNS_KEPT: usize = 20;
/// Snapshots read when looking for the previous model.
pub const SNAPSHOTS_READ: usize = 5;

/// Where the Suite's interpreter and entry script are.
#[derive(Debug, Clone, PartialEq)]
pub struct Cli {
    pub python: PathBuf,
    pub script: PathBuf,
}

/// The interpreter from the Suite's one-time setup (or HIVEMIND_ARCHSUITE_PYTHON), and the entry script inside the plugin
/// folder set in Settings.
pub fn locate(plugin: Option<&str>, home: &Path) -> Result<Cli, String> {
    let plugin = plugin.map(str::trim).filter(|p| !p.is_empty()).ok_or("Set the Architecture Suite plugin folder in Settings first")?;
    let script = Path::new(plugin).join(SCRIPT);
    if !script.is_file() {
        return Err(format!("The Architecture Suite plugin folder has no command line at {}", script.display()));
    }
    let python = match std::env::var_os("HIVEMIND_ARCHSUITE_PYTHON").filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => crate::agent::scope::suite_runtime(home)?,
    };
    Ok(Cli { python, script })
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputFile {
    pub path: String,
    /// "edited" (its hash no longer matches the manifest) or "missing".
    pub state: String,
}

/// Output files whose content no longer matches the Suite's manifest: someone edited them by hand, or removed them.
pub fn edited_outputs(folder: &Path) -> Vec<OutputFile> {
    let Some(manifest) = std::fs::read(folder.join(MANIFEST)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return vec![] };
    let mut out: Vec<OutputFile> = manifest
        .get("owners")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|owners| owners.values())
        .filter_map(|owner| owner.get("files").and_then(Value::as_object))
        .flat_map(|files| files.iter())
        .filter(|(path, _)| !path.contains("..") && !Path::new(path.as_str()).is_absolute())
        .filter_map(|(path, hash)| {
            let hash = hash.as_str()?;
            let state = match std::fs::read(folder.join(path)) {
                Err(_) => "missing",
                Ok(bytes) if hex(&Sha256::digest(&bytes)) != hash => "edited",
                Ok(_) => return None,
            };
            Some(OutputFile { path: path.clone(), state: state.into() })
        })
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup();
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// "elements" or "relationships".
    pub section: String,
    pub id: String,
    /// "added", "removed" or "changed".
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub rule: String,
    pub source: String,
    pub destination: String,
    pub severity: String,
    /// Accepted in the baseline of an earlier check.
    #[serde(default)]
    pub existing: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    /// The Suite's verdict: "clean" or another word.
    pub status: String,
    pub diagrams: u64,
    /// Layout findings across the diagrams (overlaps, unreadable labels and so on).
    pub findings: u64,
}

/// The changes in an `architecture-diff/v1` file.
pub fn parse_diff(diff: &Value) -> Vec<Change> {
    diff.get("changes").and_then(Value::as_array).into_iter().flatten().filter_map(|c| {
        let side = c.get("after").filter(|v| !v.is_null()).or_else(|| c.get("before"));
        Some(Change {
            section: c.get("section")?.as_str()?.to_string(),
            id: c.get("id")?.as_str()?.to_string(),
            kind: c.get("kind")?.as_str()?.to_string(),
            name: side.and_then(|s| s.get("name")).and_then(Value::as_str).map(str::to_string),
        })
    }).collect()
}

/// The findings in an `architecture-check/v1` file.
pub fn parse_check(check: &Value) -> Vec<Finding> {
    check.get("findings").and_then(Value::as_array).into_iter().flatten().filter_map(|f| serde_json::from_value(f.clone()).ok()).collect()
}

/// `verify`'s summary from its standard output.
pub fn parse_verify(stdout: &str) -> Result<Layout, String> {
    let v: Value = serde_json::from_str(stdout.trim()).map_err(|_| "The Architecture Suite's verify printed no JSON summary".to_string())?;
    let diagrams = v.get("diagrams").and_then(Value::as_object);
    Ok(Layout {
        status: v.get("status").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        diagrams: diagrams.map_or(0, |d| d.len() as u64),
        findings: diagrams.map_or(0, |d| d.values().map(|x| x.get("findings").and_then(Value::as_array).map_or(0, |f| f.len() as u64)).sum()),
    })
}

/// A rules file must be an `architecture-rules/v1` document.
pub fn check_rules(path: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Could not read the rules file {}: {e}", path.display()))?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "The rules file is not JSON".to_string())?;
    if v.get("schema_version").and_then(Value::as_str) != Some("architecture-rules/v1") || !v.get("rules").is_some_and(Value::is_array) {
        return Err("The rules file must be an architecture-rules/v1 document with a rules list".into());
    }
    Ok(())
}

impl Cli {
    fn run(&self, args: &[&str]) -> Result<crate::git::Ran, String> {
        let mut command = Command::new(&self.python);
        command.arg(&self.script).args(args);
        crate::git::run_captured(command, TIMEOUT)
    }

    fn failed(ran: &crate::git::Ran, what: &str) -> String {
        let line = ran.stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no message").trim();
        format!("The Architecture Suite's {what} failed: {line}")
    }

    /// Structural changes from `before` to `after`, written under `dir`.
    pub fn diff(&self, before: &Path, after: &Path, dir: &Path) -> Result<Vec<Change>, String> {
        let out = dir.join("diff");
        let ran = self.run(&["diff", "--before", &before.to_string_lossy(), "--after", &after.to_string_lossy(), "--output", &out.to_string_lossy(), "--confirm-write"])?;
        if !ran.status.success() {
            return Err(Self::failed(&ran, "diff"));
        }
        let file = std::fs::read(out.join("architecture-diff.json")).map_err(|e| format!("The diff wrote no result: {e}"))?;
        Ok(parse_diff(&serde_json::from_slice(&file).map_err(|e| e.to_string())?))
    }

    /// Rule findings for `model`, written under `dir`.
    pub fn check(&self, model: &Path, rules: &Path, dir: &Path) -> Result<Vec<Finding>, String> {
        let out = dir.join("check");
        let ran = self.run(&["check", "--model", &model.to_string_lossy(), "--rules", &rules.to_string_lossy(), "--output", &out.to_string_lossy(), "--confirm-write"])?;
        if !ran.status.success() {
            return Err(Self::failed(&ran, "check"));
        }
        let file = std::fs::read(out.join("architecture-check.json")).map_err(|e| format!("The check wrote no result: {e}"))?;
        Ok(parse_check(&serde_json::from_slice(&file).map_err(|e| e.to_string())?))
    }

    /// The layout of the diagrams `model` would produce; writes nothing.
    pub fn verify(&self, model: &Path) -> Result<Layout, String> {
        let ran = self.run(&["verify", "--model", &model.to_string_lossy()])?;
        // verify exits non-zero when it finds problems; its summary is still on stdout.
        parse_verify(&ran.stdout).map_err(|e| if ran.status.success() { e } else { Self::failed(&ran, "verify") })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Drift {
    pub system: String,
    pub at: u64,
    /// Commits on the repository since the output was made; None when it cannot be told.
    #[serde(default)]
    pub behind: Option<u64>,
    #[serde(default)]
    pub edited: Vec<OutputFile>,
    /// Changes from the previous snapshot's model to the current one; None without an earlier, different model.
    #[serde(default)]
    pub changes: Option<Vec<Change>>,
    /// When the previous model was taken.
    #[serde(default)]
    pub baseline_at: Option<u64>,
    #[serde(default)]
    pub findings: Option<Vec<Finding>>,
    #[serde(default)]
    pub rules: Option<String>,
    #[serde(default)]
    pub layout: Option<Layout>,
    /// Parts that could not be worked out, in words.
    #[serde(default)]
    pub problems: Vec<String>,
    /// `text()` and `needs_attention()` as saved, for the webview.
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub attention: bool,
}

impl Drift {
    /// Anything the user should look at: commits since the output, hand edits, new rule errors or layout findings.
    pub fn needs_attention(&self) -> bool {
        self.behind.unwrap_or(0) > 0
            || !self.edited.is_empty()
            || self.findings.as_ref().is_some_and(|f| f.iter().any(|x| !x.existing && x.severity == "error"))
            || self.layout.as_ref().is_some_and(|l| l.findings > 0)
    }

    /// "3 commits behind, 1 file edited by hand, 2 rule findings".
    pub fn text(&self) -> String {
        let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
        let mut parts = vec![];
        if let Some(b) = self.behind.filter(|b| *b > 0) {
            parts.push(format!("{} behind", plural(b as usize, "commit")));
        }
        if !self.edited.is_empty() {
            parts.push(format!("{} edited by hand or missing", plural(self.edited.len(), "output file")));
        }
        if let Some(c) = self.changes.as_ref().filter(|c| !c.is_empty()) {
            parts.push(format!("{} since the previous model", plural(c.len(), "structural change")));
        }
        if let Some(f) = self.findings.as_ref().filter(|f| !f.is_empty()) {
            parts.push(plural(f.len(), "rule finding"));
        }
        if let Some(l) = self.layout.as_ref().filter(|l| l.findings > 0) {
            parts.push(plural(l.findings as usize, "layout finding"));
        }
        if parts.is_empty() { "No drift found".into() } else { parts.join(", ") }
    }
}

/// The newest snapshot whose model differs from `current`: the baseline structural changes are counted against.
pub fn baseline<'a>(snapshots: &'a [(u64, Value)], current: &Value) -> Option<&'a (u64, Value)> {
    snapshots.iter().find(|(_, model)| model != current)
}

/// Where a system's runs go.
pub fn runs_dir(app_data: &Path, slug: &str) -> PathBuf {
    app_data.join("architecture-runs").join(slug)
}

/// The last drift worked out for a system, if any.
pub fn last_drift(app_data: &Path, slug: &str) -> Option<Drift> {
    serde_json::from_slice(&std::fs::read(runs_dir(app_data, slug).join("drift.json")).ok()?).ok()
}

/// What one drift check needs: where the output is, the repository's staleness, snapshots, and the rules file.
pub struct Inputs<'a> {
    pub slug: &'a str,
    pub folder: Option<PathBuf>,
    pub behind: Option<u64>,
    /// Snapshot models, newest first, with when each was taken.
    pub snapshots: Vec<(u64, Value)>,
    pub rules: Option<PathBuf>,
}

/// Work out a system's drift and keep it as the system's last drift. Each part that fails is named in `problems`.
pub fn drift(app_data: &Path, cli: Result<Cli, String>, inputs: Inputs) -> Result<Drift, String> {
    let at = now_ms();
    let mut d = Drift { system: inputs.slug.to_string(), at, behind: inputs.behind, rules: inputs.rules.as_ref().map(|r| r.display().to_string()), ..Default::default() };
    let Some(folder) = inputs.folder.filter(|f| f.join(MODEL).is_file()) else {
        d.problems.push("The system has no architecture-model.json yet: run a system passport first".into());
        return save(app_data, d);
    };
    d.edited = edited_outputs(&folder);
    let cli = match cli {
        Ok(cli) => cli,
        Err(e) => {
            d.problems.push(e);
            return save(app_data, d);
        }
    };
    let model = folder.join(MODEL);
    let dir = runs_dir(app_data, inputs.slug).join(at.to_string());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let current: Value = std::fs::read(&model).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    if let Some((taken, before)) = baseline(&inputs.snapshots, &current) {
        let before_path = dir.join("baseline-model.json");
        match std::fs::write(&before_path, before.to_string()).map_err(|e| e.to_string()).and_then(|_| cli.diff(&before_path, &model, &dir)) {
            Ok(changes) => {
                d.changes = Some(changes);
                d.baseline_at = Some(*taken);
            }
            Err(e) => d.problems.push(e),
        }
    }
    if let Some(rules) = &inputs.rules {
        match check_rules(rules).and_then(|_| cli.check(&model, rules, &dir)) {
            Ok(f) => d.findings = Some(f),
            Err(e) => d.problems.push(e),
        }
    }
    match cli.verify(&model) {
        Ok(l) => d.layout = Some(l),
        Err(e) => d.problems.push(e),
    }
    prune(&runs_dir(app_data, inputs.slug));
    save(app_data, d)
}

fn save(app_data: &Path, mut d: Drift) -> Result<Drift, String> {
    d.summary = d.text();
    d.attention = d.needs_attention();
    let dir = runs_dir(app_data, &d.system);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("drift.json"), serde_json::to_string_pretty(&d).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Keep the newest RUNS_KEPT run folders.
fn prune(dir: &Path) {
    let mut runs: Vec<u64> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().to_str()?.parse().ok()).collect();
    runs.sort_unstable_by(|a, b| b.cmp(a));
    for old in runs.into_iter().skip(RUNS_KEPT) {
        let _ = std::fs::remove_dir_all(dir.join(old.to_string()));
    }
}

/// What an architect or reviewer reads about the system its repository belongs to.
pub fn briefing(name: &str, folder: &Path, behind: Option<u64>) -> String {
    let mut out = vec![
        "## Architecture".to_string(),
        format!("This repository belongs to the system \"{name}\". Its Architecture Suite output is in {} (read only).", folder.display()),
        format!("- Model: {}", folder.join(MODEL).display()),
    ];
    for (file, what) in [("architecture-report.md", "Report"), ("plan.md", "Plan")] {
        if folder.join(file).is_file() {
            out.push(format!("- {what}: {}", folder.join(file).display()));
        }
    }
    match behind {
        Some(0) => out.push("The output is up to date with the repository.".into()),
        Some(n) => out.push(format!("The output is {n} commit{} behind the repository; check the code before trusting it.", if n == 1 { "" } else { "s" })),
        None => {}
    }
    out.push("Compare the change with the documented structure and say where they disagree.".into());
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-archsuite-{name}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hand_edits_and_missing_outputs_are_found() {
        let dir = scratch("edits");
        std::fs::write(dir.join("a.svg"), "<svg/>").unwrap();
        std::fs::write(dir.join("b.md"), "changed").unwrap();
        let manifest = json!({"owners": {"c4": {"files": {
            "a.svg": hex(&Sha256::digest(b"<svg/>")), "b.md": hex(&Sha256::digest(b"original")), "gone.png": "00", "../x": "00"}}}});
        std::fs::write(dir.join(MANIFEST), manifest.to_string()).unwrap();
        let found = edited_outputs(&dir);
        assert_eq!(found, vec![OutputFile { path: "b.md".into(), state: "edited".into() }, OutputFile { path: "gone.png".into(), state: "missing".into() }]);
        assert!(edited_outputs(&scratch("none")).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn suite_outputs_are_read() {
        let diff = json!({"schema_version": "architecture-diff/v1", "changes": [
            {"section": "elements", "id": "api", "kind": "changed", "before": {"name": "API"}, "after": {"name": "API v2"}},
            {"section": "relationships", "id": "a->b", "kind": "removed", "before": {"source_id": "a"}, "after": null}]});
        assert_eq!(parse_diff(&diff), vec![
            Change { section: "elements".into(), id: "api".into(), kind: "changed".into(), name: Some("API v2".into()) },
            Change { section: "relationships".into(), id: "a->b".into(), kind: "removed".into(), name: None },
        ]);
        let check = json!({"findings": [{"rule": "r", "source": "a", "destination": "b", "severity": "error", "fingerprint": "f", "existing": false}]});
        assert_eq!(parse_check(&check)[0].rule, "r");
        let verify = r#"{"ok": true, "diagrams": {"x": {"findings": [1, 2]}, "y": {"findings": []}}, "status": "clean"}"#;
        assert_eq!(parse_verify(verify).unwrap(), Layout { status: "clean".into(), diagrams: 2, findings: 2 });
        assert!(parse_verify("Traceback").is_err());
    }

    #[test]
    fn rules_files_are_checked() {
        let dir = scratch("rules");
        let good = dir.join("rules.json");
        std::fs::write(&good, json!({"schema_version": "architecture-rules/v1", "rules": []}).to_string()).unwrap();
        assert!(check_rules(&good).is_ok());
        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{}").unwrap();
        assert!(check_rules(&bad).is_err());
        assert!(check_rules(&dir.join("none.json")).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn drift_without_a_model_or_cli_says_why() {
        let app = scratch("drift");
        let d = drift(&app, Err("no cli".into()), Inputs { slug: "pay", folder: None, behind: Some(2), snapshots: vec![], rules: None }).unwrap();
        assert!(d.problems[0].contains("passport"));
        assert_eq!(last_drift(&app, "pay").unwrap(), d);
        let folder = scratch("folder");
        std::fs::write(folder.join(MODEL), "{}").unwrap();
        let d = drift(&app, Err("no cli".into()), Inputs { slug: "pay", folder: Some(folder.clone()), behind: Some(0), snapshots: vec![], rules: None }).unwrap();
        assert_eq!(d.problems, ["no cli"]);
        assert!(!d.needs_attention());
        assert_eq!(d.text(), "No drift found");
        let _ = (std::fs::remove_dir_all(app), std::fs::remove_dir_all(folder));
    }

    #[test]
    fn drift_words_and_attention() {
        let d = Drift { behind: Some(3), edited: vec![OutputFile { path: "a".into(), state: "edited".into() }],
            findings: Some(vec![Finding { rule: "r".into(), source: "a".into(), destination: "b".into(), severity: "warning".into(), existing: false }]), ..Default::default() };
        assert_eq!(d.text(), "3 commits behind, 1 output file edited by hand or missing, 1 rule finding");
        assert!(d.needs_attention());
        let quiet = Drift { findings: d.findings.clone(), ..Default::default() };
        assert!(!quiet.needs_attention(), "a warning alone does not need attention");
        let a = json!({"v": 1});
        let snaps = vec![(3, a.clone()), (2, json!({"v": 0}))];
        assert_eq!(baseline(&snaps, &a).map(|s| s.0), Some(2), "the newest different model");
    }

    #[test]
    fn the_briefing_names_the_model_and_staleness() {
        let folder = scratch("brief");
        std::fs::write(folder.join("architecture-report.md"), "r").unwrap();
        let text = briefing("PayStream", &folder, Some(4));
        assert!(text.contains("\"PayStream\"") && text.contains("architecture-report.md") && text.contains("4 commits behind") && !text.contains("plan.md"));
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn the_cli_is_found_in_the_plugin_folder() {
        assert!(locate(None, Path::new("/nowhere")).unwrap_err().contains("Settings"));
        let plugin = scratch("plugin");
        assert!(locate(Some(&plugin.to_string_lossy()), Path::new("/nowhere")).unwrap_err().contains("no command line"));
        let _ = std::fs::remove_dir_all(plugin);
    }
}
