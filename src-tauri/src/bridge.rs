//! One long-lived `living_memory.py serve --stdio` process. Requests are sent one at a time:
//! a request line goes out, then exactly one reply line comes back.
use crate::settings::Launch;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

/// Oldest `serve` API this app speaks (Living Memory's `version` reports it).
pub const MIN_API: u64 = 1;
const REQUIRED: [&str; 4] = ["serve", "list", "domains", "version"];

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Reply {
    pub exit_code: i64,
    pub result: Value,
    pub error: Value,
}

struct Proc {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next: u64,
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Bridge {
    launch: Mutex<Launch>,
    proc: Mutex<Option<Proc>>,
}

impl Bridge {
    pub fn new(launch: Launch) -> Self {
        Bridge { launch: Mutex::new(launch), proc: Mutex::new(None) }
    }

    /// Point at a different interpreter/script/store; the next call starts a fresh process.
    pub fn reconfigure(&self, launch: Launch) {
        *self.launch.lock().unwrap() = launch;
        *self.proc.lock().unwrap() = None;
    }

    pub fn launch(&self) -> Launch {
        self.launch.lock().unwrap().clone()
    }

    fn spawn(launch: &Launch) -> Result<Proc, String> {
        let mut command = Command::new(&launch.program);
        command.args(&launch.args).arg(&launch.script);
        if let Some(root) = &launch.root {
            command.arg("--root").arg(root);
        }
        command
            .args(["serve", "--stdio"])
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            // The main actor starts the server; each request picks viewer or main.
            .env_remove("LIVING_MEMORY_ACTOR")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start {} {}: {e}", launch.program, launch.script.display()))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);
        Ok(Proc { child, stdin, stdout, next: 1 })
    }

    fn exchange(proc: &mut Proc, argv: &[String], stdin: Option<&str>) -> Result<Reply, String> {
        let id = proc.next;
        proc.next += 1;
        let mut request = json!({ "id": id, "argv": argv });
        if let Some(text) = stdin {
            request["stdin"] = Value::String(text.to_string());
        }
        let mut line = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        line.push('\n');
        proc.stdin.write_all(line.as_bytes()).map_err(|e| format!("Living Memory stopped: {e}"))?;
        proc.stdin.flush().map_err(|e| format!("Living Memory stopped: {e}"))?;
        let mut answer = String::new();
        let read = proc.stdout.read_line(&mut answer).map_err(|e| format!("Living Memory stopped: {e}"))?;
        if read == 0 {
            return Err("Living Memory exited. If it is older than the app bridge, update it (needs `serve --stdio`).".into());
        }
        let value: Value = serde_json::from_str(&answer).map_err(|e| format!("Unreadable reply from Living Memory: {e}"))?;
        if value.get("id").and_then(Value::as_u64) != Some(id) {
            return Err("Living Memory replied out of order".into());
        }
        serde_json::from_value(value).map_err(|e| e.to_string())
    }

    /// Check a freshly started server speaks a compatible API.
    fn handshake(proc: &mut Proc) -> Result<Value, String> {
        let reply = Self::exchange(proc, &["version".into()], None)?;
        check_version(&reply)?;
        Ok(reply.result)
    }

    /// Run one command. Transport failures drop the process so the next call starts a new one;
    /// a failed request is never retried, because it may already have changed the store.
    pub fn call(&self, argv: &[String], stdin: Option<&str>) -> Result<Reply, String> {
        let mut guard = self.proc.lock().unwrap();
        if guard.is_none() {
            let mut proc = Self::spawn(&self.launch())?;
            Self::handshake(&mut proc)?;
            *guard = Some(proc);
        }
        let outcome = Self::exchange(guard.as_mut().unwrap(), argv, stdin);
        if outcome.is_err() {
            *guard = None;
        }
        outcome
    }
}

pub fn check_version(reply: &Reply) -> Result<(), String> {
    if reply.exit_code != 0 {
        return Err(format!("Living Memory `version` failed: {}", reply.error));
    }
    let api = reply.result.get("api").and_then(Value::as_u64).unwrap_or(0);
    let commands: Vec<&str> = reply.result.get("commands").and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let missing: Vec<&str> = REQUIRED.iter().copied().filter(|c| !commands.contains(c)).collect();
    if api < MIN_API || !missing.is_empty() {
        return Err(format!("Living Memory is too old for Hivemind (api {api}, needs {MIN_API}; missing: {})", missing.join(", ")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(result: Value) -> Reply {
        Reply { exit_code: 0, result, error: Value::Null }
    }

    #[test]
    fn version_check_accepts_current_api() {
        let ok = reply(json!({"api": 1, "commands": ["serve", "list", "domains", "version", "read"]}));
        assert!(check_version(&ok).is_ok());
    }

    /// End to end against a real Living Memory in a temporary store. Runs only when
    /// HIVEMIND_TEST_LM_SCRIPT points at a living_memory.py with `serve` (optionally HIVEMIND_TEST_PYTHON).
    #[test]
    fn live_round_trip_through_serve() {
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let base = std::env::temp_dir().join(format!("hivemind-bridge-{}", std::process::id()));
        let (store, project) = (base.join("store"), base.join("project"));
        std::fs::create_dir_all(&project).unwrap();
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let bridge = Bridge::new(Launch { program, args, script: script.into(), root: Some(store.clone()) });
        let call = |argv: &[&str], stdin: Option<&str>| bridge.call(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(), stdin).unwrap();

        assert_eq!(call(&["bind", "demo", project.to_str().unwrap()], None).exit_code, 0);
        std::fs::write(store.join("tag_taxonomy.json"), r#"{"tags":["subject/project","concern/architecture"]}"#).unwrap();
        let payload = r#"{"title":"Cache","body":"The local cache is rebuildable.","tags":["subject/project","concern/architecture"]}"#;
        let created = call(&["capture", "--domain", "demo"], Some(payload));
        assert_eq!(created.exit_code, 0, "{:?}", created.error);
        let id = created.result["id"].as_str().unwrap().to_string();

        let page = call(&["list", "--domain", "demo", "--actor", "viewer"], None);
        let revision = page.result["notes"][0]["revision"].as_str().unwrap().to_string();
        assert_eq!(page.result["total"], 1);

        let note = call(&["read", &id, "--domain", "demo", "--actor", "viewer"], None);
        assert!(note.result["body"].as_str().unwrap().contains("rebuildable"));
        assert_eq!(call(&["update", &id, "--domain", "demo", "--body", "x", "--actor", "viewer"], None).exit_code, 2);

        let stale = call(&["update", &id, "--domain", "demo", "--body", "Stale.", "--expected-revision", &"0".repeat(64)], None);
        assert_eq!((stale.exit_code, stale.error["code"].as_str()), (6, Some("stale")));
        let saved = call(&["update", &id, "--domain", "demo", "--body", "The cache is rebuilt nightly.", "--expected-revision", &revision], None);
        assert_eq!(saved.exit_code, 0, "{:?}", saved.error);

        let history = call(&["history", "--note", &id, "--actor", "viewer"], None);
        assert_eq!(history.exit_code, 0);
        drop(bridge);
        std::fs::remove_dir_all(base).ok();
    }

    /// The Phase 2 write paths Hivemind uses, end to end (same gating as the test above).
    #[test]
    fn live_phase2_writes_plans_links_and_history() {
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let base = std::env::temp_dir().join(format!("hivemind-bridge2-{}", std::process::id()));
        let (store, project) = (base.join("store"), base.join("project"));
        std::fs::create_dir_all(&project).unwrap();
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let bridge = Bridge::new(Launch { program, args, script: script.into(), root: Some(store.clone()) });
        let call = |argv: &[&str], stdin: Option<&str>| bridge.call(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(), stdin).unwrap();
        let ok = |r: Reply| { assert_eq!(r.exit_code, 0, "{:?}", r.error); r.result };

        ok(call(&["bind", "demo", project.to_str().unwrap()], None));
        std::fs::write(store.join("tag_taxonomy.json"), r#"{"tags":["subject/project","concern/architecture"]}"#).unwrap();
        let tags = r#"["subject/project","concern/architecture"]"#;
        let target = ok(call(&["capture", "--domain", "demo"], Some(&format!(
            r#"{{"title":"Cache","body":"The cache is rebuildable.","tags":{tags},"type":"knowledge","origin":"hivemind:local"}}"#))));
        let plan_note = ok(call(&["capture", "--domain", "demo"], Some(&format!(
            r###"{{"title":"Rollout","body":"## 📌 Executive Summary\nShip it, see [[cache]].\n\n## 🟩 Action Items\n- [x] build\n- [ ] ship","tags":{tags},"type":"plan"}}"###))));
        let (cache, rollout) = (format!("demo:{}", target["id"].as_str().unwrap()), format!("demo:{}", plan_note["id"].as_str().unwrap()));

        let note = ok(call(&["read", &cache, "--actor", "viewer"], None));
        assert_eq!(note["origin"], "hivemind:local");
        // Payload update with only the changed field, guarded by the revision.
        let payload = format!(r#"{{"body":"The cache is rebuilt nightly.","expected_revision":"{}"}}"#, note["revision"].as_str().unwrap());
        let updated = ok(call(&["update", &cache, "--domain", "demo"], Some(&payload)));
        assert_eq!(updated["status"], "update");
        // check --index counts ticked items too: item 2 is "ship".
        let ticked = ok(call(&["check", &rollout, "--index", "2", "--domain", "demo"], None));
        assert_eq!((ticked["item"].as_str(), ticked["open"].as_i64()), (Some("ship"), Some(0)));

        let links = ok(call(&["links", "--domain", "demo", "--actor", "viewer"], None));
        assert_eq!(links["edges"][0]["from"], rollout.as_str());
        assert_eq!(links["edges"][0]["to"], cache.as_str());

        let plan = ok(call(&["plan", "archive", &rollout, "--domain", "demo"], None));
        let inspected = ok(call(&["inspect-plan", plan["plan_id"].as_str().unwrap(), "--actor", "viewer"], None));
        assert_eq!(inspected["effects"].as_array().unwrap().len(), 2);
        let applied = ok(call(&["apply", plan["plan_id"].as_str().unwrap(), "--expected-plan-sha256", plan["digest"].as_str().unwrap()], None));
        let archive_op = applied["operation_id"].as_str().unwrap().to_string();

        let history = ok(call(&["history", "--note", plan_note["id"].as_str().unwrap(), "--actor", "viewer"], None));
        assert_eq!(history[0]["operation_id"], archive_op.as_str());
        let diff = ok(call(&["diff", &archive_op, "--actor", "viewer"], None));
        assert!(!diff.as_array().unwrap().is_empty());
        let undo = ok(call(&["undo", &archive_op], None));
        ok(call(&["apply", undo["plan_id"].as_str().unwrap(), "--expected-plan-sha256", undo["digest"].as_str().unwrap()], None));
        assert_eq!(ok(call(&["read", &rollout, "--actor", "viewer"], None))["status"], "active");
        assert_eq!(ok(call(&["validate", "demo"], None))["issues"].as_array().unwrap().len(), 0);
        drop(bridge);
        std::fs::remove_dir_all(base).ok();
    }

    /// Project command centers, end to end (same gating; needs an LM with api 2 and `projects`).
    #[test]
    fn live_projects_plan_and_cross_domain_reads() {
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let base = std::env::temp_dir().join(format!("hivemind-bridge3-{}", std::process::id()));
        let (store, demo, other) = (base.join("store"), base.join("demo"), base.join("other"));
        let repo = demo.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let bridge = Bridge::new(Launch { program, args, script: script.into(), root: Some(store.clone()) });
        let call = |argv: &[&str], stdin: Option<&str>| bridge.call(&argv.iter().map(|s| s.to_string()).collect::<Vec<_>>(), stdin).unwrap();
        let ok = |r: Reply| { assert_eq!(r.exit_code, 0, "{:?}", r.error); r.result };

        let version = ok(call(&["version"], None));
        if version["api"].as_i64().unwrap_or(0) < 2 { eprintln!("skipping: LM api < 2"); return; }
        ok(call(&["bind", "demo", demo.to_str().unwrap()], None));
        ok(call(&["bind", "other", other.to_str().unwrap()], None));
        std::fs::write(store.join("tag_taxonomy.json"), r#"{"tags":["subject/project","concern/knowledge","concern/decision"]}"#).unwrap();

        // One plan: taxonomy tag, registry entry and charter note.
        let create = json!({"slug": "app", "name": "App", "repos": [repo.to_str().unwrap()],
            "charter": {"body": "## 📌 Executive Summary\nBuild the app.\n\n---\n\n## 📝 Key Details\n* **Agent guidance:** run tests first."}});
        let plan = ok(call(&["project-plan", "create"], Some(&create.to_string())));
        let inspected = ok(call(&["inspect-plan", plan["plan_id"].as_str().unwrap(), "--actor", "viewer"], None));
        assert_eq!(inspected["effects"].as_array().unwrap().len(), 3);
        ok(call(&["apply", plan["plan_id"].as_str().unwrap(), "--expected-plan-sha256", plan["digest"].as_str().unwrap()], None));
        let listed = ok(call(&["projects", "--actor", "viewer"], None));
        assert_eq!((listed["projects"][0]["slug"].as_str(), listed["projects"][0]["tag_registered"].as_bool()), (Some("app"), Some(true)));
        assert_eq!(call(&["project-plan", "archive", "--actor", "viewer"], Some(r#"{"slug":"app"}"#)).exit_code, 2);

        // A tagged plan in another domain, and an untagged note to triage.
        let rollout = ok(call(&["capture", "--domain", "other"], Some(
            r###"{"title":"Rollout","body":"## 📌 Executive Summary\nShip it.\n\n## 🟩 Action Items\n- [x] build\n- [ ] ship","tags":["subject/project","concern/decision","project/app"],"type":"plan"}"###)));
        let rollout = format!("other:{}", rollout["id"].as_str().unwrap());
        let loose = ok(call(&["capture", "--domain", "demo"], Some(
            r#"{"title":"App cache","body":"The app caches reads.","tags":["subject/project","concern/knowledge"]}"#)));
        let loose = format!("demo:{}", loose["id"].as_str().unwrap());

        let page = ok(call(&["list", "--all-domains", "--status", "any", "--tag", "project/app", "--with-summary", "--actor", "viewer"], None));
        assert_eq!(page["total"], 2);
        let plan_row = page["notes"].as_array().unwrap().iter().find(|n| n["ref"] == rollout.as_str()).unwrap();
        assert_eq!((plan_row["actions"]["open"].as_i64(), plan_row["actions"]["done"].as_i64()), (Some(1), Some(1)));
        assert_eq!(plan_row["summary"], "Ship it.");

        let open = ok(call(&["open", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None));
        assert_eq!((open["domain"].is_null(), open["count"].as_i64()), (true, Some(1)));
        ok(call(&["check", &rollout, "--index", "2"], None));
        assert_eq!(ok(call(&["open", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["count"], 0);
        assert_eq!(ok(call(&["review", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["domain"], Value::Null);

        // Triage: a tag-only update joins the project without bumping `updated`.
        let before = ok(call(&["read", &loose, "--actor", "viewer"], None));
        let payload = json!({"tags": ["concern/knowledge", "project/app", "subject/project"], "expected_revision": before["revision"]});
        ok(call(&["update", &loose], Some(&payload.to_string())));
        let after = ok(call(&["read", &loose, "--actor", "viewer"], None));
        assert_eq!(after["updated"], before["updated"]);
        assert_eq!(ok(call(&["list", "--all-domains", "--tag", "project/app", "--actor", "viewer"], None))["total"], 3);
        drop(bridge);
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn version_check_names_missing_commands() {
        let old = reply(json!({"api": 1, "commands": ["serve", "version"]}));
        let message = check_version(&old).unwrap_err();
        assert!(message.contains("list") && message.contains("domains"), "{message}");
        assert!(check_version(&reply(json!({"commands": REQUIRED}))).is_err());
    }
}
