//! Living Memory notebook pages in Notes Studio (NS-2C). The webview reads and writes pages through the `doc` commands
//! over the bridge; this module adds what the bridge alone cannot do: send a large page body through a staging file,
//! move pages together with their drafts, attach a file the user picks, and name the notebook folder for pictures.
//! A Living Memory notebook is named `lm:<domain>:<notebook>`, as `src/documents/adapters/lmdoc.ts` names it.
use crate::bridge::{Bridge, Reply};
use std::path::{Path, PathBuf};

pub const LM: &str = "lm:";
/// Bodies whose JSON-escaped form is larger go through a staging file (`--body-file`), well under the 2 MiB request
/// line Living Memory's `serve` accepts (phase doc, C2).
pub const STAGE_OVER: usize = 512 * 1024;

/// The domain and notebook of a container id, checked the way Living Memory names them: a domain is a folder name of
/// letters, digits, `_`, `-` and `.` (not leading), a notebook id 2 to 40 lowercase letters, digits or hyphens.
pub fn parse(container: &str) -> Option<(String, String)> {
    let (domain, notebook) = container.strip_prefix(LM)?.split_once(':')?;
    let domain_ok = !domain.is_empty()
        && domain.len() <= 120
        && !domain.starts_with('.')
        && domain.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    let notebook_ok = (2..=40).contains(&notebook.len()) && notebook.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    (domain_ok && notebook_ok).then(|| (domain.to_string(), notebook.to_string()))
}

fn parsed(container: &str) -> Result<(String, String), String> {
    parse(container).ok_or_else(|| format!("\"{container}\" is not a Living Memory notebook"))
}

/// Whether a body is sent through a staging file.
pub fn needs_staging(body: &str) -> bool {
    serde_json::to_string(body).map(|s| s.len() > STAGE_OVER).unwrap_or(true)
}

/// Run a `doc` command that carries a page body: as the request's stdin, or through `staging/<uuid>.md` and
/// `--body-file` when it is large. The staging file is removed after the reply, whatever it says.
pub fn call_with_body(bridge: &Bridge, staging: &Path, argv: &[String], body: &str) -> Result<Reply, String> {
    if argv.first().map(String::as_str) != Some("doc") {
        return Err("Only doc commands carry a page body".into());
    }
    if !needs_staging(body) {
        return bridge.call(argv, Some(body));
    }
    std::fs::create_dir_all(staging).map_err(|e| format!("Could not create {}: {e}", staging.display()))?;
    let file = staging.join(format!("{}.md", uuid::Uuid::new_v4().simple()));
    std::fs::write(&file, body.as_bytes()).map_err(|e| format!("Could not stage the page for Living Memory: {e}"))?;
    let mut args = argv.to_vec();
    args.push("--body-file".into());
    args.push(file.display().to_string());
    let reply = bridge.call(&args, None);
    std::fs::remove_file(&file).ok();
    reply
}

/// Remove staging files an earlier run left behind (it stopped between writing one and the reply).
pub fn clear_staging(staging: &Path) {
    let Ok(read) = std::fs::read_dir(staging) else { return };
    for entry in read.flatten() {
        if entry.path().extension().is_some_and(|e| e == "md") {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

/// The message of a failed reply.
fn failure(reply: &Reply) -> String {
    reply.error.get("message").and_then(|m| m.as_str()).map(str::to_string).unwrap_or_else(|| format!("Living Memory exited with {}", reply.exit_code))
}

/// Move a page or section, and the drafts of its pages with it: copied to their new keys first, the old ones removed
/// once Living Memory moved the pages, and put back when it refused (as `studio::rename_in` does for folders).
pub fn move_with_drafts(bridge: &Bridge, drafts_dir: &Path, container: &str, from: &str, to: &str) -> Result<(), String> {
    let (domain, notebook) = parsed(container)?;
    if from == to {
        return Ok(());
    }
    if to.starts_with(&format!("{from}/")) {
        return Err("A section cannot move into itself".into());
    }
    if crate::drafts::any_under(drafts_dir, container, to) {
        return Err(format!("{to} has unsaved edits kept as a draft; open it and save or discard them first"));
    }
    let moves = crate::drafts::moving(drafts_dir, container, from, to);
    crate::drafts::copy_moved(drafts_dir, &moves)?;
    let argv: Vec<String> = ["doc", "move", &domain, &notebook, from, to, "--include-private"].iter().map(|s| s.to_string()).collect();
    let outcome = bridge.call(&argv, None).and_then(|reply| if reply.exit_code == 0 { Ok(()) } else { Err(failure(&reply)) });
    match outcome {
        Ok(()) => {
            crate::drafts::finish_moved(drafts_dir, &moves);
            Ok(())
        }
        Err(e) => {
            crate::drafts::undo_moved(drafts_dir, &moves);
            Err(e)
        }
    }
}

/// Copy `file` into the notebook's `assets/`; returns the attachment's path in the notebook.
pub fn attach(bridge: &Bridge, container: &str, file: &Path) -> Result<String, String> {
    let (domain, notebook) = parsed(container)?;
    let argv: Vec<String> =
        ["doc", "attach", &domain, &notebook, "--from-file", &file.display().to_string(), "--include-private"].iter().map(|s| s.to_string()).collect();
    let reply = bridge.call(&argv, None)?;
    if reply.exit_code != 0 {
        return Err(failure(&reply));
    }
    reply.result.get("path").and_then(|p| p.as_str()).map(str::to_string).ok_or_else(|| "Living Memory did not say where it put the file".into())
}

/// The notebook's folder in the store, for its pictures grant: it must exist and lie inside the store once links are
/// followed.
pub fn folder(store: &Path, container: &str) -> Result<PathBuf, String> {
    let (domain, notebook) = parsed(container)?;
    let store = std::fs::canonicalize(store).map_err(|e| format!("The Living Memory store {} is missing ({e})", store.display()))?;
    let folder = std::fs::canonicalize(store.join("domains").join(&domain).join("notebooks").join(&notebook))
        .map_err(|_| format!("The notebook {notebook} of {domain} is missing"))?;
    if !folder.starts_with(&store) {
        return Err(format!("The notebook {notebook} of {domain} leads outside the store"));
    }
    Ok(folder)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_ids_parse_only_living_memory_names() {
        assert_eq!(parse("lm:demo:plans"), Some(("demo".into(), "plans".into())));
        assert_eq!(parse("lm:_global:my-notes-2"), Some(("_global".into(), "my-notes-2".into())));
        for bad in ["nb-1234", "@abc", "lm:", "lm:demo", "lm:demo:", "lm::plans", "lm:../x:plans", "lm:.hidden:plans", "lm:demo:Plans", "lm:demo:a", "lm:demo:a/b", "lm:de mo:plans"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
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

    /// End to end against a real Living Memory in a temporary store: a notebook-only domain and notebook, a small and a
    /// staged body, a stale write, a move that carries a draft, an attachment, and an agent's proposal accepted. Runs
    /// only when HIVEMIND_TEST_LM_SCRIPT points at a living_memory.py with `doc` (optionally HIVEMIND_TEST_PYTHON).
    #[test]
    fn live_pages_through_the_bridge() {
        use crate::bridge::Bridge;
        use crate::settings::Launch;
        use serde_json::Value;
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let base = std::env::temp_dir().join(format!("hivemind-lmdoc-{}", uuid::Uuid::new_v4().simple()));
        let (store, staging, drafts) = (base.join("store"), base.join("staging"), base.join("drafts"));
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(&drafts).unwrap();
        std::fs::write(store.join("bindings.json"), "{}").unwrap();
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
        let read = |path: &str| ok(bridge.call(&argv(&["doc", "read", "jot", "daily", path, "--include-private"]), None).unwrap());

        ok(bridge.call(&argv(&["domain", "create", "jot", "--notebook-only"]), None).unwrap());
        ok(bridge.call(&argv(&["doc", "notebook", "create", "jot", "daily", "--title", "Daily"]), None).unwrap());
        let created = ok(call_with_body(&bridge, &staging, &argv(&["doc", "create", "jot", "daily", "Mon.md", "--include-private"]), "# Monday\r\n").unwrap());
        let rev1 = created["revision"].as_str().unwrap().to_string();
        assert_eq!(read("Mon.md")["text"], "# Monday\r\n");

        // A body larger than the staging threshold goes through a file, which is gone after the reply.
        let big = format!("# Monday\n{}\n", "x".repeat(STAGE_OVER + 10));
        let write = argv(&["doc", "write", "jot", "daily", "Mon.md", "--expected-revision", &rev1, "--include-private"]);
        let rev2 = ok(call_with_body(&bridge, &staging, &write, &big).unwrap())["revision"].as_str().unwrap().to_string();
        assert_eq!(read("Mon.md")["text"].as_str().unwrap().len(), big.len());
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
        let stale = call_with_body(&bridge, &staging, &write, "again").unwrap();
        assert_eq!((stale.exit_code, stale.error["code"].as_str()), (6, Some("stale")));
        assert!(call_with_body(&bridge, &staging, &argv(&["list"]), "x").is_err(), "only doc commands carry a body");

        // A move carries the page's draft to its new key.
        let container = "lm:jot:daily";
        crate::drafts::put(&drafts, &crate::drafts::file_key(container, "Mon.md"),
            &serde_json::json!({ "key": crate::drafts::file_key(container, "Mon.md"), "kind": "file", "target": { "notebook": container, "path": "Mon.md" }, "text": "unsaved" })).unwrap();
        move_with_drafts(&bridge, &drafts, container, "Mon.md", "Week/Mon.md").unwrap();
        assert_eq!(read("Week/Mon.md")["revision"], rev2.as_str());
        assert!(crate::drafts::get(&drafts, &crate::drafts::file_key(container, "Mon.md")).unwrap().is_none());
        assert_eq!(crate::drafts::get(&drafts, &crate::drafts::file_key(container, "Week/Mon.md")).unwrap().unwrap()["text"], "unsaved");
        // A move Living Memory refuses (nothing there) leaves the draft where it was.
        assert!(move_with_drafts(&bridge, &drafts, container, "Nope.md", "Week/Nope.md").is_err());
        assert!(move_with_drafts(&bridge, &drafts, container, "Week", "Week/Inner").is_err());

        // An attachment lands in assets/, inside the folder the pictures grant names.
        let picked = base.join("pic.png");
        std::fs::write(&picked, b"\x89PNG\r\n\x1a\n").unwrap();
        let asset = attach(&bridge, container, &picked).unwrap();
        assert!(asset.starts_with("assets/") && asset.ends_with("pic.png"), "{asset}");
        assert!(folder(&store, container).unwrap().join(&asset).is_file());

        // An agent proposes an edit against the revision it read; accepting writes it.
        let body = base.join("proposal.md");
        std::fs::write(&body, "# Monday\nproposed\n").unwrap();
        let proposal = ok(bridge.call(&argv(&["doc", "propose", "jot", "daily", "Week/Mon.md", "--base-revision", &rev2, "--body-file", body.to_str().unwrap(), "--include-private"]), None).unwrap());
        let id = proposal["id"].as_str().unwrap().to_string();
        ok(bridge.call(&argv(&["doc", "accept", &id, "--include-private"]), None).unwrap());
        assert_eq!(read("Week/Mon.md")["text"], "# Monday\nproposed\n");

        drop(bridge);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn the_notebook_folder_must_be_inside_the_store() {
        let base = std::env::temp_dir().join(format!("hm-lmdoc-{}", uuid::Uuid::new_v4().simple()));
        let nb = base.join("store").join("domains").join("demo").join("notebooks").join("plans");
        std::fs::create_dir_all(&nb).unwrap();
        assert_eq!(folder(&base.join("store"), "lm:demo:plans").unwrap(), std::fs::canonicalize(&nb).unwrap());
        assert!(folder(&base.join("store"), "lm:demo:other").is_err());
        assert!(folder(&base.join("store"), "nb-1234").is_err());
        std::fs::remove_dir_all(&base).ok();
    }
}
