//! Bodies for Living Memory commands that carry one: a folder page proposal's merge (`proposals accept --edited`) and a query
//! view's spec (`views add --spec-file`). The webview sends them over `lm_body`; this module sends a large one through a
//! staging file, since the bridge's request line is bounded. Notebooks that kept their pages inside the store ("hosted"
//! notebooks, `lm:<domain>:<notebook>`) were retired by CON-18 (2026-11-24), and so were the page moves, attachments and
//! pictures this module once served.
use crate::bridge::{Bridge, Reply};
use std::path::{Path, PathBuf};

/// Bodies whose JSON-escaped form is larger go through a staging file (`--body-file`), well under the 2 MiB request
/// line Living Memory's `serve` accepts (phase doc, C2).
pub const STAGE_OVER: usize = 512 * 1024;

/// Whether a body is sent through a staging file.
pub fn needs_staging(body: &str) -> bool {
    serde_json::to_string(body).map(|s| s.len() > STAGE_OVER).unwrap_or(true)
}

/// A staging file, removed when it goes out of scope: after the reply, and on every early return, a failed or partial
/// write included (Codex review of 32fee20, B2).
struct Staged(PathBuf);

impl Drop for Staged {
    fn drop(&mut self) {
        // A scanner holding the file a moment longer is retried once; what is still left goes at the next start.
        if std::fs::remove_file(&self.0).is_err() && self.0.exists() {
            std::thread::sleep(std::time::Duration::from_millis(200));
            std::fs::remove_file(&self.0).ok();
        }
    }
}

/// `argv` with `extra` options inserted before the `--` that ends its options (at the end when it has none).
fn with_options(argv: &[String], extra: &[String]) -> Vec<String> {
    let at = argv.iter().position(|a| a == "--").unwrap_or(argv.len());
    argv[..at].iter().chain(extra).chain(&argv[at..]).cloned().collect()
}

/// Run a `doc` command that carries a page body: as the request's stdin, or through `staging/<uuid>.md` and
/// `--body-file` when it is large. The staging file is removed after the reply, whatever it says.
pub fn call_with_body(bridge: &Bridge, generation: Option<u64>, staging: &Path, argv: &[String], body: &str) -> Result<Reply, String> {
    call_with_file(bridge, generation, staging, argv, body, BODY_FILE)
}

/// The option a body goes through when it is a staged file: `--body-file` for a page, `--spec-file` for the query of a query
/// view (`views add` and `views update`, CON-13). Living Memory reads the spec from a file only, so it never goes as stdin.
pub const BODY_FILE: &str = "--body-file";
pub const SPEC_FILE: &str = "--spec-file";
/// Living Memory refuses a query spec over 64 KB; Hivemind holds it to 256 KiB before it stages one.
const JSON_MAX: usize = 256 * 1024;

/// `call_with_body` for either file option. The body is the page, or the JSON of the query.
pub fn call_with_file(bridge: &Bridge, generation: Option<u64>, staging: &Path, argv: &[String], body: &str, flag: &str) -> Result<Reply, String> {
    // `proposals accept --edited` carries the user's merge of a page proposal as its body; `views add` and `views update` carry a query.
    if !matches!(argv.first().map(String::as_str), Some("proposals" | "views")) {
        return Err("Only proposals and views commands carry a body".into());
    }
    if flag != BODY_FILE && flag != SPEC_FILE {
        return Err(format!("\"{flag}\" is not a file option Hivemind passes"));
    }
    if flag != BODY_FILE && body.len() > JSON_MAX {
        return Err("A query is larger than 256 KiB".into());
    }
    if flag == BODY_FILE && !needs_staging(body) {
        return bridge.call_at(generation, argv, Some(body));
    }
    std::fs::create_dir_all(staging).map_err(|e| format!("Could not create {}: {e}", staging.display()))?;
    let ext = if flag == BODY_FILE { "md" } else { "json" };
    let file = Staged(staging.join(format!("{}.{ext}", uuid::Uuid::new_v4().simple())));
    std::fs::write(&file.0, body.as_bytes()).map_err(|e| format!("Could not stage the page for Living Memory: {e}"))?;
    bridge.call_at(generation, &with_options(argv, &[flag.into(), file.0.display().to_string()]), None)
}

/// Remove staging files an earlier run left behind (it stopped between writing one and the reply). `.bin` is what pictures
/// attached to a hosted notebook were staged as, which an older version may have left.
pub fn clear_staging(staging: &Path) {
    let Ok(read) = std::fs::read_dir(staging) else { return };
    for entry in read.flatten() {
        if entry.path().extension().is_some_and(|e| e == "md" || e == "bin" || e == "json") {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    /// `--body-file` and the other file options go before the `--` that ends a command's options.
    #[test]
    fn options_go_before_the_operands() {
        let argv: Vec<String> = ["proposals", "accept", "0123456789ab", "--edited", "--"].iter().map(|s| s.to_string()).collect();
        let staged = with_options(&argv, &["--body-file".into(), "x.md".into()]);
        assert_eq!(staged, ["proposals", "accept", "0123456789ab", "--edited", "--body-file", "x.md", "--"]);
        assert_eq!(with_options(&["proposals".into(), "accept".into()], &["--x".into()]), ["proposals", "accept", "--x"]);
    }

    /// Codex review of 32fee20, B2: the staging file goes on every path out, a failed write included.
    #[test]
    fn a_staging_file_goes_whatever_happens() {
        let dir = std::env::temp_dir().join(format!("hm-staged-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.md");
        let stage = |fail: bool| -> Result<(), String> {
            let staged = Staged(file.clone());
            std::fs::write(&staged.0, "x").unwrap();
            if fail { Err("the write failed halfway".into()) } else { Ok(()) }
        };
        assert!(stage(true).is_err());
        assert!(!file.exists());
        stage(false).unwrap();
        assert!(!file.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// CON-13 and CON-18: only the two file options pass, a query is bounded, and only `proposals` and `views` commands carry a
    /// body (the `doc` commands that took one, write and create, are gone).
    #[test]
    fn only_the_two_file_options_pass_and_a_query_is_bounded() {
        let bridge = Bridge::new(crate::settings::Launch { program: "py".into(), args: vec![], script: "no-such.py".into(), root: None });
        let staging = std::env::temp_dir().join(format!("hm-flag-{}", uuid::Uuid::new_v4().simple()));
        let views = ["views".to_string(), "add".to_string()];
        for bad in ["--order-file", "--settings-file", "--payload-file", "--body-file=x", "-x", ""] {
            assert!(call_with_file(&bridge, None, &staging, &views, "{}", bad).unwrap_err().contains("not a file option"), "{bad}");
        }
        let big = format!("{{\"a\":\"{}\"}}", "x".repeat(JSON_MAX));
        // A query view's spec passes as a `--spec-file` of a `views` command (the size check is the proof it got past the options).
        assert!(call_with_file(&bridge, None, &staging, &views, &big, SPEC_FILE).unwrap_err().contains("256 KiB"));
        assert!(call_with_file(&bridge, None, &staging, &views, "{}", "--spec-file=x").unwrap_err().contains("not a file option"));
        for argv in [&["list"][..], &["doc", "write"][..], &["doc", "create"][..], &[][..]] {
            let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
            assert!(call_with_file(&bridge, None, &staging, &argv, "{}", SPEC_FILE).unwrap_err().contains("Only proposals and views"), "{argv:?}");
        }
        assert!(!staging.exists(), "nothing is staged for a refused call");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("x.json"), "{}").unwrap();
        clear_staging(&staging);
        assert!(!staging.join("x.json").exists());
        std::fs::remove_dir_all(&staging).ok();
    }

    #[test]
    fn large_bodies_are_staged() {
        assert!(!needs_staging("short page"));
        assert!(!needs_staging(&"a".repeat(STAGE_OVER - 10)));
        assert!(needs_staging(&"a".repeat(STAGE_OVER + 1)));
        // Escaping counts: control characters take six bytes each in JSON.
        assert!(needs_staging(&"\u{1}".repeat(STAGE_OVER / 6 + 10)));
    }

    #[test]
    fn leftover_staging_files_are_cleared() {
        let dir = std::env::temp_dir().join(format!("hm-stage-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("keep.txt"), "x").unwrap();
        clear_staging(&dir);
        assert!(!dir.join("a.md").exists() && dir.join("keep.txt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// End to end against a real Living Memory in a temporary store, for what is left of the `doc` and `proposals` commands: a
    /// folder notebook registered with `doc folder set`, a page read by its file path, an agent's proposal accepted, a merge
    /// sent small and through a staging file (`--edited`), a query view saved through `--spec-file`, the removed commands refused,
    /// and the stale-bridge check. Runs only when HIVEMIND_TEST_LM_SCRIPT points at a living_memory.py of Living Memory api 4 or
    /// later (optionally HIVEMIND_TEST_PYTHON).
    #[test]
    fn live_folder_pages_through_the_bridge() {
        use crate::bridge::Bridge;
        use crate::settings::Launch;
        use serde_json::Value;
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let base = std::env::temp_dir().join(format!("hivemind-lmdoc-{}", uuid::Uuid::new_v4().simple()));
        let (store, project, notebook, staging) = (base.join("store"), base.join("project"), base.join("wiki"), base.join("staging"));
        for dir in [&store, &project, &notebook] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(store.join("bindings.json"), "{}").unwrap();
        std::fs::write(notebook.join("Mon.md"), "# Monday\r\n").unwrap();
        let (program, args) = match std::env::var("HIVEMIND_TEST_PYTHON") {
            Ok(p) => (p, vec![]),
            Err(_) if cfg!(windows) => ("py".to_string(), vec!["-3".to_string()]),
            Err(_) => ("python3".to_string(), vec![]),
        };
        let bridge = Bridge::new(Launch { program, args, script: script.into(), root: Some(store.clone()) });
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let ok = |r: Reply| -> Value {
            assert_eq!(r.exit_code, 0, "{:?}", r.error);
            r.result
        };
        let (file, wiki) = (notebook.join("Mon.md").display().to_string(), notebook.display().to_string());

        let version = ok(bridge.call(&argv(&["version"]), None).unwrap());
        assert!(version["api"].as_i64().unwrap() >= 4, "this test needs a Living Memory without hosted notebooks: {version}");
        let docs = &version["capabilities"]["docs"];
        assert!(docs["folder_proposals"].as_i64().unwrap() >= 1 && docs["accept_edited"] == true && docs["folder_policy"].as_i64().unwrap() >= 2, "{docs}");
        for gone in ["max_asset_bytes", "notebook_only_domains", "search"] {
            assert!(docs.get(gone).is_none(), "{gone} was removed with hosted notebooks");
        }
        let commands = version["commands"].as_array().unwrap();
        assert!(commands.iter().any(|c| c == "doc") && !commands.iter().any(|c| c == "domain"), "{commands:?}");

        // The registry and a read by file path, which is what Hivemind uses for a folder it has no notebook for.
        ok(bridge.call(&argv(&["bind", "demo", project.to_str().unwrap()]), None).unwrap());
        ok(bridge.call(&argv(&["doc", "folder", "set", "--domain", "demo", "--", &wiki]), None).unwrap());
        let read = |path: &str| ok(bridge.call(&argv(&["doc", "read", &format!("--file={path}"), "--include-private", "--actor", "viewer"]), None).unwrap());
        let page = read(&file);
        assert_eq!((page["text"].as_str(), page["origin"].as_str()), (Some("# Monday\r\n"), Some("folder")));
        let rev1 = page["revision"].as_str().unwrap().to_string();

        // An agent proposes an edit against the revision it read; accepting writes it.
        let body = base.join("proposal.md");
        std::fs::write(&body, "# Monday\nproposed\n").unwrap();
        let propose = |rev: &str| ok(bridge.call(&argv(&["doc", "propose", &format!("--file={file}"), "--base-revision", rev, "--body-file", body.to_str().unwrap(), "--include-private"]), None).unwrap());
        let id = propose(&rev1)["id"].as_str().unwrap().to_string();
        let listed = ok(bridge.call(&argv(&["proposals", "list", "--kind", "page", "--include-private", "--actor", "viewer"]), None).unwrap());
        assert_eq!(listed["proposals"][0]["id"], id.as_str());
        assert_eq!(listed["proposals"][0]["folder"].as_str().map(|f| f.replace('\\', "/").to_lowercase()), Some(wiki.replace('\\', "/").to_lowercase()));
        let shown = ok(bridge.call(&argv(&["proposals", "show", &id, "--include-private", "--actor", "viewer"]), None).unwrap());
        assert_eq!(shown["proposal"]["body"], "# Monday\nproposed\n");
        ok(bridge.call(&argv(&["proposals", "accept", &id, "--include-private"]), None).unwrap());
        assert_eq!(read(&file)["text"], "# Monday\nproposed\n");
        let rev2 = read(&file)["revision"].as_str().unwrap().to_string();

        // A merge is written and settled in one step: small as the request's stdin, large through a staging file that is gone after.
        let id = propose(&rev2)["id"].as_str().unwrap().to_string();
        let merge = |id: &str, rev: &str| argv(&["proposals", "accept", id, "--edited", "--expected-revision", rev, "--include-private"]);
        ok(call_with_body(&bridge, None, &staging, &merge(&id, &rev2), "merged\n").unwrap());
        assert_eq!(read(&file)["text"], "merged\n");
        let rev3 = read(&file)["revision"].as_str().unwrap().to_string();
        let id = propose(&rev3)["id"].as_str().unwrap().to_string();
        let big = format!("# Monday\n{}\n", "x".repeat(STAGE_OVER + 10));
        ok(call_with_body(&bridge, None, &staging, &merge(&id, &rev3), &big).unwrap());
        assert_eq!(read(&file)["text"].as_str().unwrap().len(), big.len());
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0, "the staged body is removed");
        // A merge made against a revision the page has left is refused as stale, and writes nothing.
        let rev4 = read(&file)["revision"].as_str().unwrap().to_string();
        let id = propose(&rev4)["id"].as_str().unwrap().to_string();
        let stale = call_with_body(&bridge, None, &staging, &merge(&id, &rev3), "again").unwrap();
        assert_eq!((stale.exit_code, stale.error["code"].as_str()), (6, Some("stale")), "{:?}", stale.error);
        assert_eq!(read(&file)["revision"], rev4.as_str());
        assert!(call_with_body(&bridge, None, &staging, &argv(&["list"]), "x").is_err(), "only proposals and views commands carry a body");

        // A query view goes through a staged `--spec-file`.
        let spec = r#"{"version":1,"from":{"notebooks":[]},"where":[{"prop":"status","op":"eq","value":"open"}],"sort":[],"view":"table","columns":[],"groupBy":null,"limit":500}"#;
        let added = ok(call_with_file(&bridge, None, &staging, &argv(&["views", "add", "--title", "Open pages"]), spec, SPEC_FILE).unwrap());
        assert_eq!(added["kind"], "query");
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0, "the staged spec is removed");

        // The commands CON-18 removed are unknown commands, with no alias; `doc folder unset` still works.
        for gone in [
            &["doc", "notebooks", "--all-domains"][..], &["doc", "list", "demo", "plans"][..], &["doc", "tasks", "--all-domains"][..], &["doc", "query", "--all-domains"][..],
            &["doc", "create", "demo", "plans", "A.md"][..], &["doc", "notebook", "create", "demo", "plans"][..], &["domain", "create", "jot", "--notebook-only"][..],
        ] {
            let reply = bridge.call(&argv(gone), None).unwrap();
            assert_ne!(reply.exit_code, 0, "{gone:?} still works");
        }
        let pages = bridge.call(&argv(&["search", "--pages", "--all-domains", "--include-private", "--actor", "viewer", "--", "monday"]), None).unwrap();
        assert_ne!(pages.exit_code, 0, "--include-private is no longer accepted by search");
        ok(bridge.call(&argv(&["doc", "folder", "unset", "--", &wiki]), None).unwrap());

        // R2-D1: a request made before the bridge switched stores is refused, one made after runs.
        let before = bridge.generation();
        bridge.reconfigure(bridge.launch());
        assert_eq!(bridge.call_at(Some(before), &argv(&["version"]), None).unwrap_err(), crate::bridge::STORE_CHANGED);
        ok(bridge.call_at(Some(bridge.generation()), &argv(&["version"]), None).unwrap());

        drop(bridge);
        std::fs::remove_dir_all(&base).ok();
    }
}
