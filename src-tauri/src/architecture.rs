//! Read-only view of a system's Architecture Suite output folder. The folder comes from Living
//! Memory (`systems`), never from the webview, and only diagrams the suite's manifest lists are served.
use crate::bridge::Bridge;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MANIFEST: &str = ".architecture-suite-manifest.json";
const MODEL: &str = "architecture-model.json";
const MAX_JSON: u64 = 16 * 1024 * 1024;
const MAX_DIAGRAM: u64 = 32 * 1024 * 1024;
/// Stored baselines kept per system.
pub const SNAPSHOT_KEEP: usize = 10;

#[derive(Serialize, Debug, PartialEq)]
pub struct Diagram {
    /// Path inside the folder, as the manifest spells it (forward slashes).
    pub path: String,
    /// The suite's level folder, e.g. `02-containers`; empty for a file at the top.
    pub level: String,
    pub format: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Architecture {
    pub folder: Option<String>,
    /// When the model (else the manifest) was last written, in milliseconds since the epoch.
    pub generated_at: Option<u64>,
    pub tool_version: Option<String>,
    pub model: Option<Value>,
    pub inventory: Option<Value>,
    pub topology: Option<Value>,
    pub diagrams: Vec<Diagram>,
    /// Why there is nothing to show (no folder set, folder missing, nothing generated yet).
    pub error: Option<String>,
}

/// One system's registry entry, looked up in Living Memory.
pub fn system_entry(bridge: &Bridge, slug: &str) -> Result<Value, String> {
    let reply = bridge.call(&["systems".into(), "--actor".into(), "viewer".into()], None)?;
    if reply.exit_code != 0 {
        return Err(format!("Living Memory could not list systems (is it up to date?): {}", reply.error));
    }
    reply
        .result
        .get("systems")
        .and_then(Value::as_array)
        .and_then(|all| all.iter().find(|s| s.get("slug").and_then(Value::as_str) == Some(slug)))
        .cloned()
        .ok_or_else(|| format!("Unknown system: {slug}"))
}

pub fn folder_of(entry: &Value) -> Option<PathBuf> {
    entry.get("architecture").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(PathBuf::from)
}

fn read_json(path: &Path) -> Option<Value> {
    let size = std::fs::metadata(path).ok()?.len();
    if size > MAX_JSON {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn modified_ms(path: &Path) -> Option<u64> {
    let time = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(time.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn format_of(path: &str) -> Option<&'static str> {
    match path.rsplit('.').next()?.to_ascii_lowercase().as_str() {
        "svg" => Some("svg"),
        "png" => Some("png"),
        _ => None,
    }
}

/// SVG and PNG files the manifest lists, across every owner (the C4 set, scenarios and so on).
fn diagrams(manifest: &Value) -> Vec<Diagram> {
    let mut found: Vec<Diagram> = manifest
        .get("owners")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|owners| owners.values())
        .filter_map(|owner| owner.get("files").and_then(Value::as_object))
        .flat_map(|files| files.keys())
        .filter_map(|path| {
            let format = format_of(path)?;
            let level = path.rsplit_once('/').map(|(dir, _)| dir.split('/').next().unwrap_or("")).unwrap_or("");
            Some(Diagram { path: path.clone(), level: level.to_string(), format: format.to_string() })
        })
        .collect();
    found.sort_by(|a, b| a.path.cmp(&b.path));
    found.dedup();
    found
}

fn tool_version(manifest: &Value) -> Option<String> {
    let owners = manifest.get("owners")?.as_object()?;
    let version = |owner: &Value| owner.get("tool_version").and_then(Value::as_str).map(str::to_string);
    owners.get("c4").and_then(version).or_else(|| owners.values().find_map(version))
}

/// The registered systems (not retired) whose repositories include `repo`, with their architecture folders.
pub fn systems_for_repo(bridge: &Bridge, repo: &Path) -> Vec<(String, String, PathBuf)> {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let want = norm(&repo.to_string_lossy());
    let Ok(reply) = bridge.call(&["systems".into(), "--actor".into(), "viewer".into()], None) else { return vec![] };
    reply.result.get("systems").and_then(Value::as_array).into_iter().flatten()
        .filter(|s| s.get("status").and_then(Value::as_str) != Some("retired"))
        .filter(|s| s.get("repos").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).any(|r| norm(r) == want))
        .filter_map(|s| {
            let slug = s.get("slug")?.as_str()?.to_string();
            let name = s.get("name").and_then(Value::as_str).unwrap_or(&slug).to_string();
            Some((slug, name, folder_of(s)?))
        })
        .collect()
}

/// What an Architecture Suite output folder holds. Never fails: a missing piece is left empty.
pub fn read_folder(folder: &Path) -> Architecture {
    let mut out = Architecture { folder: Some(folder.display().to_string()), ..Default::default() };
    if !folder.is_dir() {
        out.error = Some(format!("The architecture folder does not exist yet: {}", folder.display()));
        return out;
    }
    let first = |names: &[&str]| names.iter().find_map(|name| read_json(&folder.join(name)));
    out.model = read_json(&folder.join(MODEL));
    out.inventory = first(&["inventory/dependency-inventory.json", "dependency-inventory.json"]);
    out.topology = first(&["infrastructure/topology.json", "topology.json"]);
    if let Some(manifest) = read_json(&folder.join(MANIFEST)) {
        out.diagrams = diagrams(&manifest);
        out.tool_version = tool_version(&manifest);
    }
    out.generated_at = modified_ms(&folder.join(MODEL)).or_else(|| modified_ms(&folder.join(MANIFEST)));
    if out.model.is_none() && out.diagrams.is_empty() {
        out.error = Some("Nothing has been generated in the architecture folder yet.".into());
    }
    out
}

/// One listed diagram as a data URL, for an `<img>`.
pub fn read_diagram(folder: &Path, relative: &str) -> Result<String, String> {
    let manifest = read_json(&folder.join(MANIFEST)).ok_or("This folder has no Architecture Suite manifest")?;
    let listed = diagrams(&manifest);
    let diagram = listed.iter().find(|d| d.path == relative).ok_or("That file is not a diagram in this folder's manifest")?;
    let root = folder.canonicalize().map_err(|e| e.to_string())?;
    let path = folder.join(relative).canonicalize().map_err(|e| format!("Cannot open {relative}: {e}"))?;
    if !path.starts_with(&root) {
        return Err("That file is outside the architecture folder".into());
    }
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_DIAGRAM {
        return Err(format!("{relative} is too large to show"));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let mime = if diagram.format == "svg" { "image/svg+xml" } else { "image/png" };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// The Mermaid source the suite wrote beside a diagram (a `.mmd` file its manifest lists), as text.
pub fn read_source(folder: &Path, relative: &str) -> Result<String, String> {
    if !relative.to_ascii_lowercase().ends_with(".mmd") {
        return Err("Only a diagram's Mermaid source can be shown".into());
    }
    let manifest = read_json(&folder.join(MANIFEST)).ok_or("This folder has no Architecture Suite manifest")?;
    let listed = manifest
        .get("owners")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|owners| owners.values())
        .filter_map(|owner| owner.get("files").and_then(Value::as_object))
        .any(|files| files.contains_key(relative));
    if !listed {
        return Err("That file is not in this folder's manifest".into());
    }
    let root = folder.canonicalize().map_err(|e| e.to_string())?;
    let path = folder.join(relative).canonicalize().map_err(|e| format!("Cannot open {relative}: {e}"))?;
    if !path.starts_with(&root) {
        return Err("That file is outside the architecture folder".into());
    }
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_JSON {
        return Err(format!("{relative} is too large to show"));
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub fn for_system(bridge: &Bridge, slug: &str) -> Result<Architecture, String> {
    Ok(match folder_of(&system_entry(bridge, slug)?) {
        Some(folder) => read_folder(&folder),
        None => Architecture { error: Some("No architecture folder is set for this system.".into()), ..Default::default() },
    })
}

pub fn diagram_for_system(bridge: &Bridge, slug: &str, relative: &str) -> Result<String, String> {
    let folder = folder_of(&system_entry(bridge, slug)?).ok_or("No architecture folder is set for this system")?;
    read_diagram(&folder, relative)
}

pub fn source_for_system(bridge: &Bridge, slug: &str, relative: &str) -> Result<String, String> {
    let folder = folder_of(&system_entry(bridge, slug)?).ok_or("No architecture folder is set for this system")?;
    read_source(&folder, relative)
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Staleness {
    /// The commit the current output was generated from, when a Hivemind session generated it.
    pub source_sha: Option<String>,
    /// Commits on the repository's HEAD that the output has not seen; None when it cannot be told.
    pub behind: Option<u64>,
    /// False when `behind` was counted from the model file's date because no `source_sha` applies.
    pub exact: bool,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    /// The file's stem: "<takenAt>-<sessionId>".
    pub id: String,
    pub session_id: String,
    pub taken_at: u64,
}

/// One stored copy of architecture-model.json, as written to disk.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub session_id: String,
    pub taken_at: u64,
    pub source_sha: Option<String>,
    pub model: Value,
}

/// Where snapshots are kept: beside the sessions folder, in the app data folder.
pub fn snapshots_root(sessions_dir: &Path) -> PathBuf {
    sessions_dir.with_file_name("architecture-snapshots")
}

fn snapshot_dir(root: &Path, slug: &str) -> Result<PathBuf, String> {
    let mut chars = slug.chars();
    let first = chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    if !first || slug.len() > 40 || !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("Invalid system slug".into());
    }
    Ok(root.join(slug))
}

/// A system's snapshots, newest first, from the file names alone.
pub fn list_snapshots(root: &Path, slug: &str) -> Result<Vec<SnapshotInfo>, String> {
    let dir = snapshot_dir(root, slug)?;
    let mut found: Vec<SnapshotInfo> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let id = name.strip_suffix(".json")?;
            let (taken, session) = id.split_once('-')?;
            if taken.is_empty() || !taken.bytes().all(|b| b.is_ascii_digit()) || uuid::Uuid::try_parse(session).is_err() {
                return None;
            }
            Some(SnapshotInfo { id: id.to_string(), session_id: session.to_string(), taken_at: taken.parse().ok()? })
        })
        .collect();
    found.sort_by(|a, b| b.taken_at.cmp(&a.taken_at).then_with(|| a.id.cmp(&b.id)));
    Ok(found)
}

/// Keep a copy of the folder's model for this session; drop all but the newest SNAPSHOT_KEEP of the system.
pub fn save_snapshot(root: &Path, slug: &str, session_id: &str, taken_at: u64, source_sha: Option<&str>, folder: &Path) -> Result<(), String> {
    let dir = snapshot_dir(root, slug)?;
    let Some(model) = read_json(&folder.join(MODEL)) else { return Ok(()) };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let snapshot = Snapshot { session_id: session_id.to_string(), taken_at, source_sha: source_sha.map(String::from), model };
    let text = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    let (file, temp) = (dir.join(format!("{taken_at}-{session_id}.json")), dir.join(format!("{taken_at}-{session_id}.tmp")));
    std::fs::write(&temp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &file).map_err(|e| e.to_string())?;
    for old in list_snapshots(root, slug)?.into_iter().skip(SNAPSHOT_KEEP) {
        let _ = std::fs::remove_file(dir.join(format!("{}.json", old.id)));
    }
    Ok(())
}

pub fn read_snapshot(root: &Path, slug: &str, id: &str) -> Result<Snapshot, String> {
    let unknown = || "Unknown snapshot".to_string();
    if !list_snapshots(root, slug)?.iter().any(|s| s.id == id) {
        return Err(unknown());
    }
    let value = read_json(&snapshot_dir(root, slug)?.join(format!("{id}.json"))).ok_or_else(unknown)?;
    serde_json::from_value(value).map_err(|_| unknown())
}

/// How far the repository has moved since the system's architecture output was generated.
pub fn staleness(bridge: &Bridge, sessions: &[crate::agent::SessionInfo], slug: &str) -> Result<Staleness, String> {
    use crate::agent::{events::Status, scope::AgentTask};
    let entry = system_entry(bridge, slug)?;
    let repo = entry.get("repos").and_then(Value::as_array).and_then(|repos| repos.first()).and_then(Value::as_str);
    let generated = folder_of(&entry).and_then(|folder| modified_ms(&folder.join(MODEL)));
    let (Some(repo), Some(generated)) = (repo, generated) else { return Ok(Staleness { source_sha: None, behind: None, exact: false }) };
    let repo = Path::new(repo);
    let current = sessions.iter().find(|s| {
        matches!(&s.task, AgentTask::SystemPassport { slug: of } if of == slug)
            && s.status == Status::Succeeded
            && s.source_sha.as_deref().is_some_and(crate::git::is_sha)
            && s.ended_at.is_some_and(|at| at >= generated)
    });
    if let Some(sha) = current.and_then(|s| s.source_sha.as_deref())
        && let Ok(behind) = crate::git::rev_count(repo, &[&format!("{sha}..HEAD")])
    {
        return Ok(Staleness { source_sha: Some(sha.to_string()), behind: Some(behind), exact: true });
    }
    let since = format!("--since=@{}", generated / 1000);
    Ok(Staleness { source_sha: None, behind: crate::git::rev_count(repo, &[&since, "HEAD"]).ok(), exact: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-arch-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("02-containers")).unwrap();
        std::fs::create_dir_all(dir.join("inventory")).unwrap();
        let manifest = json!({"schema_version": "architecture-output-manifest/v1", "owners": {
            "c4": {"command": "plan-render", "tool_version": "1.1.0", "files": {
                "02-containers/containers.svg": "aa", "02-containers/containers.png": "bb",
                "02-containers/containers.mmd": "cc", "architecture-report.md": "dd", "../outside.svg": "ee"}},
            "scenario-render": {"command": "scenario-render", "tool_version": "1.1.0", "files": {"scenario.svg": "ff"}}}});
        std::fs::write(dir.join(MANIFEST), manifest.to_string()).unwrap();
        std::fs::write(dir.join(MODEL), json!({"schema_version": "2.0", "elements": []}).to_string()).unwrap();
        std::fs::write(dir.join("inventory/dependency-inventory.json"), json!({"routes": []}).to_string()).unwrap();
        std::fs::write(dir.join("02-containers/containers.svg"), "<svg/>").unwrap();
        std::fs::write(dir.join("02-containers/containers.png"), [0x89, b'P', b'N', b'G']).unwrap();
        dir
    }

    #[test]
    fn reads_model_inventory_and_listed_diagrams() {
        let dir = fixture("read");
        let found = read_folder(&dir);
        assert_eq!(found.error, None);
        assert_eq!(found.tool_version.as_deref(), Some("1.1.0"));
        assert!(found.generated_at.is_some());
        assert_eq!(found.model.unwrap()["schema_version"], "2.0");
        assert!(found.inventory.is_some());
        assert!(found.topology.is_none());
        let paths: Vec<(&str, &str, &str)> = found.diagrams.iter().map(|d| (d.path.as_str(), d.level.as_str(), d.format.as_str())).collect();
        assert_eq!(
            paths,
            vec![
                ("../outside.svg", "..", "svg"),
                ("02-containers/containers.png", "02-containers", "png"),
                ("02-containers/containers.svg", "02-containers", "svg"),
                ("scenario.svg", "", "svg"),
            ]
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn serves_only_listed_files_inside_the_folder() {
        let dir = fixture("serve");
        assert_eq!(read_diagram(&dir, "02-containers/containers.svg").unwrap(), "data:image/svg+xml;base64,PHN2Zy8+");
        assert!(read_diagram(&dir, "02-containers/containers.png").unwrap().starts_with("data:image/png;base64,"));
        // Listed in the manifest but not a diagram, not listed at all, and listed but outside the folder.
        assert!(read_diagram(&dir, "02-containers/containers.mmd").is_err());
        assert!(read_diagram(&dir, MODEL).is_err());
        std::fs::write(dir.parent().unwrap().join("outside.svg"), "<svg/>").unwrap();
        let outside = read_diagram(&dir, "../outside.svg");
        std::fs::remove_file(dir.parent().unwrap().join("outside.svg")).ok();
        assert_eq!(outside.unwrap_err(), "That file is outside the architecture folder");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn serves_only_listed_mermaid_sources() {
        let dir = fixture("source");
        std::fs::write(dir.join("02-containers/containers.mmd"), "flowchart LR\n  a --> b\n").unwrap();
        assert_eq!(read_source(&dir, "02-containers/containers.mmd").unwrap(), "flowchart LR\n  a --> b\n");
        // Not Mermaid, listed but missing on disk, and present on disk but not listed.
        assert!(read_source(&dir, "02-containers/containers.svg").is_err());
        assert!(read_source(&dir, MODEL).is_err());
        std::fs::remove_file(dir.join("02-containers/containers.mmd")).unwrap();
        assert!(read_source(&dir, "02-containers/containers.mmd").is_err());
        std::fs::write(dir.join("loose.mmd"), "flowchart LR").unwrap();
        assert_eq!(read_source(&dir, "loose.mmd").unwrap_err(), "That file is not in this folder's manifest");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn missing_or_empty_folders_explain_themselves() {
        let missing = std::env::temp_dir().join(format!("hivemind-arch-missing-{}", std::process::id()));
        assert!(read_folder(&missing).error.unwrap().contains("does not exist yet"));
        std::fs::create_dir_all(&missing).unwrap();
        let empty = read_folder(&missing);
        assert!(empty.error.unwrap().contains("Nothing has been generated"));
        assert!(empty.diagrams.is_empty());
        assert!(read_diagram(&missing, "a.svg").is_err());
        std::fs::remove_dir_all(missing).ok();
    }

    #[test]
    fn folder_comes_from_the_registry_entry() {
        assert_eq!(folder_of(&json!({"architecture": "C:/arch/billing"})), Some(PathBuf::from("C:/arch/billing")));
        assert_eq!(folder_of(&json!({"architecture": null})), None);
        assert_eq!(folder_of(&json!({"architecture": " "})), None);
    }

    fn root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hivemind-snap-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        root
    }

    #[test]
    fn snapshots_are_kept_listed_and_pruned() {
        let (root, folder) = (root("keep"), fixture("snap-model"));
        let session = |n: u64| format!("00000000-0000-4000-8000-{n:012}");
        for n in 1..=12u64 {
            save_snapshot(&root, "paystream", &session(n), 1000 + n, Some("abc"), &folder).unwrap();
        }
        let listed = list_snapshots(&root, "paystream").unwrap();
        assert_eq!(listed.len(), SNAPSHOT_KEEP);
        assert_eq!(listed[0], SnapshotInfo { id: format!("1012-{}", session(12)), session_id: session(12), taken_at: 1012 });
        assert_eq!(listed.last().unwrap().taken_at, 1003);
        for gone in [1001, 1002] {
            assert!(!root.join("paystream").join(format!("{gone}-{}.json", session(gone - 1000))).exists());
        }
        let read = read_snapshot(&root, "paystream", &listed[0].id).unwrap();
        assert_eq!((read.session_id, read.source_sha.as_deref(), read.model["schema_version"].as_str()), (session(12), Some("abc"), Some("2.0")));
        for id in [format!("1001-{}", session(1)), "../x".to_string()] {
            assert_eq!(read_snapshot(&root, "paystream", &id).unwrap_err(), "Unknown snapshot");
        }
        // A folder with no model saves nothing.
        let empty = root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(save_snapshot(&root, "other", &session(1), 5, None, &empty), Ok(()));
        assert!(list_snapshots(&root, "other").unwrap().is_empty());
        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(folder).ok();
    }

    #[test]
    fn snapshot_folders_take_only_slugs() {
        let root = Path::new("snaps");
        assert_eq!(snapshot_dir(root, "paystream"), Ok(root.join("paystream")));
        assert_eq!(snapshot_dir(root, "a-1"), Ok(root.join("a-1")));
        for bad in ["", "../x", "A", "a/b", &"a".repeat(41)] {
            assert_eq!(snapshot_dir(root, bad), Err("Invalid system slug".to_string()), "{bad}");
        }
    }
}
