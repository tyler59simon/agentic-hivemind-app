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

/// The domain and notebook of a container id, checked the way Living Memory names them (`common.safe_domain`,
/// `docs.SLUG`) and the webview does (`parseLm`), so a notebook works everywhere or nowhere (Codex review of 32fee20,
/// C3): a domain starts with a letter, digit or `_` and goes on with those, `.` and `-` (a folder name, at most 255);
/// a notebook id is 2 to 40 lowercase letters, digits or hyphens, not starting with a hyphen.
pub fn parse(container: &str) -> Option<(String, String)> {
    let (domain, notebook) = container.strip_prefix(LM)?.split_once(':')?;
    let lead = |s: &str, ok: fn(char) -> bool| s.chars().next().is_some_and(ok);
    let domain_ok = domain.len() <= 255
        && lead(domain, |c| c.is_ascii_alphanumeric() || c == '_')
        && domain.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    let slug = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let notebook_ok = (2..=40).contains(&notebook.len()) && lead(notebook, slug) && notebook.chars().all(|c| slug(c) || c == '-');
    (domain_ok && notebook_ok).then(|| (domain.to_string(), notebook.to_string()))
}

/// A `doc` command's argv: options first, then `--` and the operands, so a page named `-Draft.md` is never read as an
/// option (Codex review of 32fee20, C4), as `src/lib/lm.ts` builds them.
fn doc_argv(action: &str, options: &[&str], operands: &[&str]) -> Vec<String> {
    ["doc", action].iter().chain(options).chain(&["--"]).chain(operands).map(|s| s.to_string()).collect()
}

fn parsed(container: &str) -> Result<(String, String), String> {
    parse(container).ok_or_else(|| format!("\"{container}\" is not a Living Memory notebook"))
}

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

/// The option a body goes through when it is a staged file: `--body-file` for a page, `--settings-file` for the settings
/// of a notebook (NS-7A), `--payload-file` for the query of `doc query` (NS-7B). Living Memory reads the settings and the
/// payload from a file only, so they never go as stdin.
pub const BODY_FILE: &str = "--body-file";
pub const SETTINGS_FILE: &str = "--settings-file";
pub const PAYLOAD_FILE: &str = "--payload-file";
/// Living Memory refuses a settings file over 256 KiB (`--settings-file is larger than 256 KiB`); a query payload is held to
/// the same bound.
const JSON_MAX: usize = 256 * 1024;

/// `call_with_body` for any of the three file options. The body is the page, or the JSON of the settings or the query.
pub fn call_with_file(bridge: &Bridge, generation: Option<u64>, staging: &Path, argv: &[String], body: &str, flag: &str) -> Result<Reply, String> {
    if argv.first().map(String::as_str) != Some("doc") {
        return Err("Only doc commands carry a page body".into());
    }
    if flag != BODY_FILE && flag != SETTINGS_FILE && flag != PAYLOAD_FILE {
        return Err(format!("\"{flag}\" is not a file option Hivemind passes"));
    }
    if flag != BODY_FILE && body.len() > JSON_MAX {
        return Err(if flag == SETTINGS_FILE { "Notebook settings are larger than 256 KiB" } else { "A query is larger than 256 KiB" }.into());
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

/// Remove staging files (page bodies and pictures) an earlier run left behind (it stopped between writing one and the
/// reply).
pub fn clear_staging(staging: &Path) {
    let Ok(read) = std::fs::read_dir(staging) else { return };
    for entry in read.flatten() {
        if entry.path().extension().is_some_and(|e| e == "md" || e == "bin" || e == "json") {
            std::fs::remove_file(entry.path()).ok();
        }
    }
}

/// The message of a failed reply.
fn failure(reply: &Reply) -> String {
    reply.error.get("message").and_then(|m| m.as_str()).map(str::to_string).unwrap_or_else(|| format!("Living Memory exited with {}", reply.exit_code))
}

/// How a move ended, as far as Hivemind can tell.
#[derive(Debug, PartialEq)]
enum Moved {
    Yes,
    No(String),
    /// The reply was lost and the store could not be asked either.
    Unknown(String),
}

/// The outcome of a `doc move`. A reply settles it; a lost one (the bridge failed after sending, so the move may have
/// happened) is settled by what the notebook lists now (Codex review of 32fee20, D4).
fn settle_move(outcome: Result<Reply, String>, from: &str, to: &str, list: impl FnOnce() -> Result<Vec<String>, String>) -> Moved {
    let lost = match outcome {
        Ok(reply) if reply.exit_code == 0 => return Moved::Yes,
        Ok(reply) => return Moved::No(failure(&reply)),
        // Refused before it was sent: nothing moved (Codex review of dd4c1b0, R3-D6).
        Err(e) if e == crate::bridge::STORE_CHANGED => return Moved::No(e),
        Err(e) => e,
    };
    // `list` gives files only: a section's folder can stay behind, empty, after its pages moved (Codex re-review of
    // 75ce884, R2-D4). Files on both sides, or on neither, settle nothing.
    let under = |paths: &[String], at: &str| paths.iter().any(|p| p == at || p.starts_with(&format!("{at}/")));
    match list() {
        Ok(paths) if under(&paths, to) && !under(&paths, from) => Moved::Yes,
        Ok(paths) if under(&paths, from) && !under(&paths, to) => Moved::No(lost),
        Ok(_) | Err(_) => Moved::Unknown(lost),
    }
}

/// The paths of a notebook's files (pages and attachments), without its folders.
fn listed(bridge: &Bridge, generation: Option<u64>, domain: &str, notebook: &str) -> Result<Vec<String>, String> {
    let reply = bridge.call_at(generation, &doc_argv("list", &["--include-private"], &[domain, notebook]), None)?;
    if reply.exit_code != 0 {
        return Err(failure(&reply));
    }
    file_paths(&reply.result)
}

/// The paths of the files in a `doc list` result, its folders left out.
fn file_paths(result: &serde_json::Value) -> Result<Vec<String>, String> {
    let entries = result.get("entries").and_then(|e| e.as_array()).ok_or("Living Memory listed no entries")?;
    let file = |e: &&serde_json::Value| e.get("kind").and_then(|k| k.as_str()) != Some("folder");
    Ok(entries.iter().filter(file).filter_map(|e| e.get("path").and_then(|p| p.as_str()).map(str::to_string)).collect())
}

/// Move a page or section, and the drafts of its pages with it: copied to their new keys first, the old ones removed
/// once Living Memory moved the pages, and put back when it refused (as `studio::rename_in` does for folders). When
/// the reply is lost and the store cannot say where the pages are, both copies stay, and the error says so.
/// `store` is the store Hivemind is connected to: drafts written in another store stay where they are (R2-D7).
pub fn move_with_drafts(bridge: &Bridge, generation: Option<u64>, drafts_dir: &Path, store: Option<&Path>, container: &str, from: &str, to: &str) -> Result<(), String> {
    let (domain, notebook) = parsed(container)?;
    if from == to {
        return Ok(());
    }
    if to.starts_with(&format!("{from}/")) {
        return Err("A section cannot move into itself".into());
    }
    // Every store's drafts count here: a draft at the destination has the key the moved one would take, so moving would
    // replace it (Codex review of dd4c1b0, R3-D3).
    if crate::drafts::any_under(drafts_dir, None, container, to) {
        return Err(format!("{to} has unsaved edits kept as a draft, in this or another Living Memory store; open it there and save or discard them first"));
    }
    let moves = crate::drafts::moving(drafts_dir, store, container, from, to);
    crate::drafts::copy_moved(drafts_dir, &moves)?;
    let outcome = bridge.call_at(generation, &doc_argv("move", &["--include-private"], &[&domain, &notebook, from, to]), None);
    match settle_move(outcome, from, to, || listed(bridge, generation, &domain, &notebook)) {
        Moved::Yes => {
            crate::drafts::finish_moved(drafts_dir, &moves);
            Ok(())
        }
        Moved::No(e) => {
            crate::drafts::undo_moved(drafts_dir, &moves);
            Err(e)
        }
        Moved::Unknown(e) => Err(format!("{e}. Hivemind could not tell whether {from} moved, so its unsaved edits are kept under both names")),
    }
}

/// Copy `file` into the notebook's `assets/`; returns the attachment's path in the notebook.
pub fn attach(bridge: &Bridge, generation: Option<u64>, container: &str, file: &Path) -> Result<String, String> {
    let (domain, notebook) = parsed(container)?;
    let reply = bridge.call_at(generation, &doc_argv("attach", &["--from-file", &file.display().to_string(), "--include-private"], &[&domain, &notebook]), None)?;
    if reply.exit_code != 0 {
        return Err(failure(&reply));
    }
    reply.result.get("path").and_then(|p| p.as_str()).map(str::to_string).ok_or_else(|| "Living Memory did not say where it put the file".into())
}

/// The files in a notebook's `assets` folder as `assets/<name>`, sorted, links and folders left out, at most 10,000.
/// A missing folder has none, and so has an `assets` that is a link: it would list another folder (Codex re-review of
/// 87a0a1f).
pub fn asset_names(assets: &Path) -> Vec<String> {
    if crate::files::contain::is_link(assets) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(assets) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()) && !crate::files::contain::is_link(&e.path()))
        .filter_map(|e| e.file_name().to_str().map(|n| format!("assets/{n}")))
        .take(10_000)
        .collect();
    names.sort();
    names
}

/// The `doc attach` argv for a staged file, its options given as `--opt=value`.
fn attach_argv(from: &str, name: &str, domain: &str, notebook: &str) -> Vec<String> {
    doc_argv("attach", &[from, name, "--include-private"], &[domain, notebook])
}

/// Attach bytes the webview sent (a pasted or dropped picture, NS-3A) under `name`: Living Memory reads them from a
/// staging file, removed after the reply, and names the asset `<sha8>-<name>`. Returns its path in the notebook.
pub fn attach_bytes(bridge: &Bridge, generation: Option<u64>, staging: &Path, container: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    let (domain, notebook) = parsed(container)?;
    std::fs::create_dir_all(staging).map_err(|e| format!("Could not create {}: {e}", staging.display()))?;
    let file = Staged(staging.join(format!("{}.bin", uuid::Uuid::new_v4().simple())));
    std::fs::write(&file.0, bytes).map_err(|e| format!("Could not stage the picture for Living Memory: {e}"))?;
    // `--opt=value`: a name such as `-draft.png` is then never read as an option (Codex review of 398b956, P3).
    let (from, name) = (format!("--from-file={}", file.0.display()), format!("--name={name}"));
    let argv = attach_argv(&from, &name, &domain, &notebook);
    let reply = bridge.call_at(generation, &argv, None)?;
    if reply.exit_code != 0 {
        return Err(failure(&reply));
    }
    reply.result.get("path").and_then(|p| p.as_str()).map(str::to_string).ok_or_else(|| "Living Memory did not say where it put the file".into())
}

/// The notebook's folder in the store, for its pictures grant: `domains/<domain>/notebooks/<notebook>` itself, with no
/// link or junction anywhere below the store, as Living Memory opens it. A folder that resolves anywhere else, even
/// inside the store, is refused (Codex review of 32fee20, P2).
pub fn folder(store: &Path, container: &str) -> Result<PathBuf, String> {
    let (domain, notebook) = parsed(container)?;
    let store = std::fs::canonicalize(store).map_err(|e| format!("The Living Memory store {} is missing ({e})", store.display()))?;
    let expected = store.join("domains").join(&domain).join("notebooks").join(&notebook);
    // A link below the store is refused before anything is compared: in a case-sensitive folder, a link named `plans`
    // could lead to a sibling `PLANS` that the comparison below cannot tell apart (Codex re-review of 75ce884, R2-P3).
    let linked = expected.ancestors().take_while(|p| *p != store.as_path()).any(crate::files::contain::is_link);
    let folder = std::fs::canonicalize(&expected).map_err(|_| format!("The notebook {notebook} of {domain} is missing"))?;
    if linked {
        return Err(format!("The notebook {notebook} of {domain} leads somewhere else, so Hivemind does not show its attachments"));
    }
    // Compared without letter case: Windows names a folder in any case, and only a link changes where it leads.
    let same = |a: &Path, b: &Path| a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase();
    if !same(&folder, &expected) {
        return Err(format!("The notebook {notebook} of {domain} leads somewhere else, so Hivemind does not show its attachments"));
    }
    Ok(folder)
}

/// Kinds of attachment Hivemind opens in another program: documents, pictures and media, never anything that runs. SVG
/// is left out: it can hold script, and outside Hivemind's preview nothing restricts it (Codex re-review of 75ce884, R2-P4).
const OPENABLE: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "txt", "csv", "md", "json", "docx", "xlsx", "pptx", "odt", "ods",
    "odp", "rtf", "mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov",
];

/// The attachment at `path` (`assets/<file>` in the notebook) that Hivemind may open: inside the notebook's `assets`
/// folder after links resolve, a file, and of a kind in OPENABLE.
pub fn attachment(store: &Path, container: &str, path: &str) -> Result<PathBuf, String> {
    let root = folder(store, container)?;
    let full = crate::files::contain::resolve_inside(&root, path, false).map_err(|_| format!("{path} is not an attachment of this notebook"))?;
    let rel = crate::files::contain::resolved_rel(&root, &full).ok_or_else(|| format!("{path} is not an attachment of this notebook"))?;
    let mut parts = rel.split('/');
    if parts.next() != Some("assets") || parts.next().is_none() || !full.is_file() {
        return Err(format!("{path} is not an attachment of this notebook"));
    }
    let ext = full.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !OPENABLE.contains(&ext.as_str()) {
        return Err(format!("Hivemind does not open .{ext} attachments; they could run code"));
    }
    Ok(full)
}

/// A read-only copy of an attachment in the temporary folder, named as the user attached it (without the hash prefix
/// Living Memory adds), for another program to open: the store keeps Living Memory as its only writer.
pub fn copy_to_open(full: &Path) -> Result<PathBuf, String> {
    let name = full.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let shown = match name.split_once('-') {
        Some((hash, rest)) if hash.len() == 8 && hash.chars().all(|c| c.is_ascii_hexdigit()) && !rest.is_empty() => rest.to_string(),
        _ => name,
    };
    let dir = open_copies().join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let copy = dir.join(shown);
    std::fs::copy(full, &copy).map_err(|e| format!("Could not copy the attachment: {e}"))?;
    let mut perms = std::fs::metadata(&copy).map_err(|e| e.to_string())?.permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&copy, perms).ok();
    Ok(copy)
}

/// Where `copy_to_open` puts its copies.
fn open_copies() -> PathBuf {
    std::env::temp_dir().join("hivemind-attachments")
}

/// Remove an opened copy and its folder (they are read-only, so the flag is cleared first).
pub fn remove_copy(copy: &Path) {
    if let Ok(meta) = std::fs::metadata(copy) {
        let mut perms = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(copy, perms).ok();
    }
    std::fs::remove_file(copy).ok();
    if let Some(dir) = copy.parent() {
        std::fs::remove_dir(dir).ok();
    }
}

/// Remove the copies an earlier session opened: an attachment of a private notebook should not stay in the temporary
/// folder, where Living Memory's private-read rules do not reach (Codex re-review of 75ce884, R2-P2). A copy another
/// program still holds open stays until the next start.
pub fn clear_open_copies() {
    clear_copies_in(&open_copies());
}

/// Only plain files in plain folders are touched: a link or junction, at the top or inside, is left alone and never
/// followed, so cleanup cannot reach files outside the copies (Codex review of dd4c1b0, R3-P2).
fn clear_copies_in(dir: &Path) {
    let plain_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink());
    if !plain_dir(dir) {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for sub in read.flatten() {
        if !plain_dir(&sub.path()) {
            continue;
        }
        if let Ok(files) = std::fs::read_dir(sub.path()) {
            for file in files.flatten() {
                if std::fs::symlink_metadata(file.path()).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) {
                    remove_copy(&file.path());
                }
            }
        }
        std::fs::remove_dir(sub.path()).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_names_list_the_files_of_the_assets_folder() {
        let dir = std::env::temp_dir().join(format!("hm-assets-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("1a2b3c4d-pic.png"), b"x").unwrap();
        std::fs::write(dir.join("00aa11bb-a.png"), b"x").unwrap();
        assert_eq!(asset_names(&dir), ["assets/00aa11bb-a.png", "assets/1a2b3c4d-pic.png"]);
        assert!(asset_names(&dir.join("missing")).is_empty());
        // An `assets` folder that is a junction lists nothing (Codex re-review of 87a0a1f).
        if cfg!(windows) {
            let link = dir.join("linked");
            let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(&link).arg(&dir).output().unwrap();
            assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
            assert!(asset_names(&link).is_empty());
            std::fs::remove_dir(&link).ok();
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn container_ids_parse_only_living_memory_names() {
        assert_eq!(parse("lm:demo:plans"), Some(("demo".into(), "plans".into())));
        assert_eq!(parse("lm:_global:my-notes-2"), Some(("_global".into(), "my-notes-2".into())));
        for bad in ["nb-1234", "@abc", "lm:", "lm:demo", "lm:demo:", "lm::plans", "lm:../x:plans", "lm:.hidden:plans", "lm:demo:Plans", "lm:demo:a", "lm:demo:a/b", "lm:de mo:plans"] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    /// Codex review of 32fee20, C3: the same names as Living Memory and the webview's `parseLm`.
    #[test]
    fn container_ids_follow_living_memory_names() {
        let long = format!("lm:{}:plans", "d".repeat(121));
        assert!(parse(&long).is_some(), "a long domain Living Memory accepts");
        for bad in ["lm:-demo:plans", "lm:demo:-plans", "lm:demo:p_q", &format!("lm:{}:plans", "d".repeat(256))] {
            assert_eq!(parse(bad), None, "{bad}");
        }
    }

    /// Codex review of 32fee20, C4: operands come after `--`, and `--body-file` goes before it.
    #[test]
    fn options_go_before_the_operands() {
        let argv = doc_argv("move", &["--include-private"], &["jot", "daily", "-Draft.md", "-Old.md"]);
        assert_eq!(argv, ["doc", "move", "--include-private", "--", "jot", "daily", "-Draft.md", "-Old.md"]);
        let staged = with_options(&argv, &["--body-file".into(), "x.md".into()]);
        assert_eq!(staged, ["doc", "move", "--include-private", "--body-file", "x.md", "--", "jot", "daily", "-Draft.md", "-Old.md"]);
        assert_eq!(with_options(&["doc".into(), "write".into()], &["--x".into()]), ["doc", "write", "--x"]);
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

    /// Codex review of 32fee20, D4: a lost reply is settled by what the notebook lists; when that fails too, neither side
    /// is taken as true.
    #[test]
    fn a_move_whose_reply_was_lost_is_settled_by_the_notebook() {
        let reply = |code: i64| Ok(Reply { exit_code: code, result: serde_json::json!({}), error: serde_json::json!({ "message": "refused" }) });
        let lost = || Err::<Reply, String>("Living Memory stopped".into());
        let list = |paths: &[&str]| { let v: Vec<String> = paths.iter().map(|s| s.to_string()).collect(); move || Ok(v) };
        assert_eq!(settle_move(reply(0), "A.md", "B.md", || unreachable!()), Moved::Yes);
        assert_eq!(settle_move(reply(2), "A.md", "B.md", || unreachable!()), Moved::No("refused".into()));
        assert_eq!(settle_move(lost(), "S", "T/S", list(&["T", "T/S", "T/S/a.md"])), Moved::Yes);
        assert_eq!(settle_move(lost(), "S", "T/S", list(&["S", "S/a.md"])), Moved::No("Living Memory stopped".into()));
        assert_eq!(settle_move(lost(), "A.md", "B.md", || Err("still down".into())), Moved::Unknown("Living Memory stopped".into()));
        assert_eq!(settle_move(lost(), "A.md", "B.md", list(&["C.md"])), Moved::Unknown("Living Memory stopped".into()));
        // Codex review of dd4c1b0, R3-D6: refused at the bridge before it was sent, so nothing moved.
        let refused = Err::<Reply, String>(crate::bridge::STORE_CHANGED.into());
        assert_eq!(settle_move(refused, "A.md", "B.md", || unreachable!()), Moved::No(crate::bridge::STORE_CHANGED.into()));
    }

    /// Codex re-review of 75ce884, R2-D4: the move committed and its reply was lost before the empty source folder was
    /// removed. `listed` gives files only, so that folder does not make the move look undone; files on both sides settle
    /// nothing.
    #[test]
    fn an_empty_source_folder_does_not_undo_a_move() {
        let lost = || Err::<Reply, String>("Living Memory stopped".into());
        let list = |paths: &[&str]| { let v: Vec<String> = paths.iter().map(|s| s.to_string()).collect(); move || Ok(v) };
        assert_eq!(settle_move(lost(), "S", "T/S", list(&["T/S/a.md"])), Moved::Yes);
        assert_eq!(settle_move(lost(), "S", "T/S", list(&["S/a.md", "T/S/a.md"])), Moved::Unknown("Living Memory stopped".into()));
        // What `doc list` gives right after such a move: the empty source folder is not a file.
        let result = serde_json::json!({ "entries": [{ "path": "S", "kind": "folder" }, { "path": "T", "kind": "folder" }, { "path": "T/S", "kind": "folder" }, { "path": "T/S/a.md", "kind": "page" }] });
        let files = file_paths(&result).unwrap();
        assert_eq!(files, ["T/S/a.md"]);
        assert_eq!(settle_move(lost(), "S", "T/S", move || Ok(files)), Moved::Yes);
    }

    /// Codex re-review of 75ce884, R2-P2: a copy left by an earlier session goes at the next start, read-only or not.
    #[test]
    fn opened_copies_are_cleared() {
        let dir = std::env::temp_dir().join(format!("hm-open-{}", uuid::Uuid::new_v4().simple()));
        let one = dir.join("a1").join("plan.pdf");
        std::fs::create_dir_all(one.parent().unwrap()).unwrap();
        std::fs::write(&one, "x").unwrap();
        let mut perms = std::fs::metadata(&one).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&one, perms).unwrap();
        clear_copies_in(&dir);
        assert!(!one.exists() && !dir.join("a1").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Codex review of dd4c1b0, R3-P2: a junction in the copies folder leads outside it; cleanup neither follows it nor
    /// changes the file behind it.
    #[cfg(windows)]
    #[test]
    fn cleanup_does_not_follow_a_junction() {
        let base = std::env::temp_dir().join(format!("hm-open-link-{}", uuid::Uuid::new_v4().simple()));
        let (copies, outside) = (base.join("copies"), base.join("outside"));
        std::fs::create_dir_all(&copies).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let precious = outside.join("keep.txt");
        std::fs::write(&precious, "x").unwrap();
        let mut perms = std::fs::metadata(&precious).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&precious, perms).unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(copies.join("j1")).arg(&outside).output().unwrap();
        assert!(made.status.success(), "{made:?}");
        clear_copies_in(&copies);
        assert!(precious.exists());
        assert!(std::fs::metadata(&precious).unwrap().permissions().readonly());
        std::fs::remove_dir(copies.join("j1")).ok();
        let mut perms = std::fs::metadata(&precious).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&precious, perms).ok();
        std::fs::remove_dir_all(&base).ok();
    }

    /// Codex review of dd4c1b0, R3-D3: store A keeps a draft for B.md; in store B, moving A.md to B.md would give B's
    /// draft that key. The move is refused before anything is copied, and A's draft keeps its bytes.
    #[test]
    fn a_move_onto_another_stores_draft_is_refused() {
        let dir = std::env::temp_dir().join(format!("hm-move-onto-{}", uuid::Uuid::new_v4().simple()));
        let nb = "lm:demo:plans";
        let draft = |path: &str, store: &str| serde_json::json!({ "key": crate::drafts::file_key(nb, path), "kind": "file", "target": { "notebook": nb, "path": path }, "mine": store, "store": store });
        crate::drafts::put(&dir, &crate::drafts::file_key(nb, "B.md"), &draft("B.md", "C:/stores/a")).unwrap();
        crate::drafts::put(&dir, &crate::drafts::file_key(nb, "A.md"), &draft("A.md", "C:/stores/b")).unwrap();
        let bridge = Bridge::new(crate::settings::Launch { program: "py".into(), args: vec![], script: "no-such.py".into(), root: None });
        let err = move_with_drafts(&bridge, None, &dir, Some(Path::new("C:/stores/b")), nb, "A.md", "B.md").unwrap_err();
        assert!(err.contains("another Living Memory store"), "{err}");
        assert_eq!(crate::drafts::get(&dir, &crate::drafts::file_key(nb, "B.md")).unwrap().unwrap()["mine"], "C:/stores/a");
        assert_eq!(crate::drafts::get(&dir, &crate::drafts::file_key(nb, "A.md")).unwrap().unwrap()["mine"], "C:/stores/b");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Codex re-review of 75ce884, R2-P4: SVG can hold script, so it is not opened in another program.
    #[test]
    fn svg_attachments_are_not_opened_outside() {
        assert!(!OPENABLE.contains(&"svg"));
    }

    /// NS-7A and NS-7B: only the three file options pass, the settings and the query are bounded, and the staged file is a
    /// `.json` that a leftover sweep removes.
    #[test]
    fn only_the_three_file_options_pass_and_settings_and_queries_are_bounded() {
        let bridge = Bridge::new(crate::settings::Launch { program: "py".into(), args: vec![], script: "no-such.py".into(), root: None });
        let staging = std::env::temp_dir().join(format!("hm-flag-{}", uuid::Uuid::new_v4().simple()));
        let argv = doc_argv("update", &[], &["jot", "daily"]);
        for bad in ["--order-file", "--icons-file", "--body-file=x", "--payload-file=x", "-x", ""] {
            assert!(call_with_file(&bridge, None, &staging, &argv, "{}", bad).unwrap_err().contains("not a file option"), "{bad}");
        }
        let big = format!("{{\"a\":\"{}\"}}", "x".repeat(JSON_MAX));
        assert!(call_with_file(&bridge, None, &staging, &argv, &big, SETTINGS_FILE).unwrap_err().contains("256 KiB"));
        assert!(call_with_file(&bridge, None, &staging, &doc_argv("query", &[], &[]), &big, PAYLOAD_FILE).unwrap_err().contains("256 KiB"));
        assert!(call_with_file(&bridge, None, &staging, &["list".to_string()], "{}", SETTINGS_FILE).is_err(), "only doc commands");
        assert!(!staging.exists(), "nothing is staged for a refused call");
        // A query goes through its own option, before any `--`, and the argv keeps the operands after it.
        assert_eq!(with_options(&doc_argv("query", &["--all-domains"], &[]), &["--payload-file".into(), "q.json".into()]), ["doc", "query", "--all-domains", "--payload-file", "q.json", "--"]);
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
        let read = |path: &str| ok(bridge.call(&doc_argv("read", &["--include-private"], &["jot", "daily", path]), None).unwrap());

        ok(bridge.call(&argv(&["domain", "create", "jot", "--notebook-only"]), None).unwrap());
        ok(bridge.call(&argv(&["doc", "notebook", "create", "jot", "daily", "--title", "Daily"]), None).unwrap());
        let created = ok(call_with_body(&bridge, None, &staging, &doc_argv("create", &["--include-private"], &["jot", "daily", "Mon.md"]), "# Monday\r\n").unwrap());
        let rev1 = created["revision"].as_str().unwrap().to_string();
        assert_eq!(read("Mon.md")["text"], "# Monday\r\n");

        // A body larger than the staging threshold goes through a file, which is gone after the reply.
        let big = format!("# Monday\n{}\n", "x".repeat(STAGE_OVER + 10));
        let write = doc_argv("write", &["--expected-revision", &rev1, "--include-private"], &["jot", "daily", "Mon.md"]);
        let rev2 = ok(call_with_body(&bridge, None, &staging, &write, &big).unwrap())["revision"].as_str().unwrap().to_string();
        assert_eq!(read("Mon.md")["text"].as_str().unwrap().len(), big.len());
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0);
        let stale = call_with_body(&bridge, None, &staging, &write, "again").unwrap();
        assert_eq!((stale.exit_code, stale.error["code"].as_str()), (6, Some("stale")));
        assert!(call_with_body(&bridge, None, &staging, &argv(&["list"]), "x").is_err(), "only doc commands carry a body");

        // A move carries the page's draft to its new key.
        let container = "lm:jot:daily";
        crate::drafts::put(&drafts, &crate::drafts::file_key(container, "Mon.md"),
            &serde_json::json!({ "key": crate::drafts::file_key(container, "Mon.md"), "kind": "file", "target": { "notebook": container, "path": "Mon.md" }, "text": "unsaved" })).unwrap();
        move_with_drafts(&bridge, None, &drafts, None, container, "Mon.md", "Week/Mon.md").unwrap();
        assert_eq!(read("Week/Mon.md")["revision"], rev2.as_str());
        assert!(crate::drafts::get(&drafts, &crate::drafts::file_key(container, "Mon.md")).unwrap().is_none());
        assert_eq!(crate::drafts::get(&drafts, &crate::drafts::file_key(container, "Week/Mon.md")).unwrap().unwrap()["text"], "unsaved");
        // A move Living Memory refuses (nothing there) leaves the draft where it was.
        assert!(move_with_drafts(&bridge, None, &drafts, None, container, "Nope.md", "Week/Nope.md").is_err());
        assert!(move_with_drafts(&bridge, None, &drafts, None, container, "Week", "Week/Inner").is_err());

        // An attachment lands in assets/, inside the folder the pictures grant names.
        let picked = base.join("pic.png");
        std::fs::write(&picked, b"\x89PNG\r\n\x1a\n").unwrap();
        let asset = attach(&bridge, None, container, &picked).unwrap();
        assert!(asset.starts_with("assets/") && asset.ends_with("pic.png"), "{asset}");
        assert!(folder(&store, container).unwrap().join(&asset).is_file());
        // Pasted bytes go the same way; a name that starts with a dash is not read as an option (Codex review of 398b956).
        let pasted = attach_bytes(&bridge, None, &staging, container, "-draft.png", b"\x89PNG\r\n\x1a\nx").unwrap();
        assert!(pasted.starts_with("assets/") && pasted.ends_with("--draft.png"), "{pasted}");
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0, "the staged picture is removed");

        // An agent proposes an edit against the revision it read; accepting writes it.
        let body = base.join("proposal.md");
        std::fs::write(&body, "# Monday\nproposed\n").unwrap();
        let proposal = ok(bridge.call(&argv(&["doc", "propose", "jot", "daily", "Week/Mon.md", "--base-revision", &rev2, "--body-file", body.to_str().unwrap(), "--include-private"]), None).unwrap());
        let id = proposal["id"].as_str().unwrap().to_string();
        ok(bridge.call(&argv(&["doc", "accept", &id, "--include-private"]), None).unwrap());
        assert_eq!(read("Week/Mon.md")["text"], "# Monday\nproposed\n");

        // A page named like an option opens, saves and moves (C4); a merge is written and settled in one step (D3).
        let dash = ok(call_with_body(&bridge, None, &staging, &doc_argv("create", &["--include-private"], &["jot", "daily", "-Draft.md"]), "a\n").unwrap());
        assert_eq!(read("-Draft.md")["text"], "a\n");
        move_with_drafts(&bridge, None, &drafts, None, container, "-Draft.md", "-Other.md").unwrap();
        let rev = dash["revision"].as_str().unwrap();
        let propose = doc_argv("propose", &["--base-revision", rev, "--body-file", body.to_str().unwrap(), "--include-private"], &["jot", "daily", "-Other.md"]);
        let proposal = ok(bridge.call(&propose, None).unwrap());
        let merged = doc_argv("accept", &["--edited", "--expected-revision", rev, "--include-private"], &[proposal["id"].as_str().unwrap()]);
        ok(call_with_body(&bridge, None, &staging, &merged, "merged\n").unwrap());
        assert_eq!(read("-Other.md")["text"], "merged\n");

        // Codex re-review of 75ce884, R2-T2: the argv the webview sends, through the real parser. `doc notebooks` takes no
        // operands, so it has no `--` (R2-C1); a write to a page named like an option goes after `--`.
        let rev = read("-Other.md")["revision"].as_str().unwrap().to_string();
        let write = doc_argv("write", &["--expected-revision", &rev, "--include-private"], &["jot", "daily", "-Other.md"]);
        ok(call_with_body(&bridge, None, &staging, &write, "saved\n").unwrap());
        assert_eq!(read("-Other.md")["text"], "saved\n");
        let notebooks = ok(bridge.call(&argv(&["doc", "notebooks", "--all-domains", "--include-hidden", "--include-private", "--actor", "viewer"]), None).unwrap());
        assert!(notebooks["notebooks"].as_array().unwrap().iter().any(|n| n["notebook"] == "daily"), "{notebooks}");

        // NS-7A: a notebook's settings go through a staged `--settings-file` before the `--`, and `doc notebooks` reports them.
        let list = |bridge: &Bridge| ok(bridge.call(&argv(&["doc", "notebooks", "--all-domains", "--include-hidden", "--include-private", "--actor", "viewer"]), None).unwrap());
        let row = |l: &Value| l["notebooks"].as_array().unwrap().iter().find(|n| n["notebook"] == "daily").cloned().unwrap();
        assert_eq!(row(&list(&bridge))["settings"], serde_json::json!({}), "no settings reads as an empty object");
        let update = doc_argv("notebook", &["update", "--include-private"], &["jot", "daily"]);
        ok(call_with_file(&bridge, None, &staging, &update, r#"{"daily":{"folder":"Days","format":"YYYY-MM-DD"}}"#, SETTINGS_FILE).unwrap());
        ok(call_with_file(&bridge, None, &staging, &update, r#"{"inbox":"Inbox.md"}"#, SETTINGS_FILE).unwrap());
        assert_eq!(row(&list(&bridge))["settings"], serde_json::json!({ "daily": { "folder": "Days", "format": "YYYY-MM-DD" }, "inbox": "Inbox.md" }));
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0, "the staged settings are removed");

        // NS-7B: `doc tasks` lists the task lines of the pages, and `doc query` takes its payload through a staged
        // `--payload-file` (a command without operands, so the file option goes after the others).
        let tasked = call_with_body(&bridge, None, &staging, &doc_argv("create", &["--include-private"], &["jot", "daily", "Tasks.md"]), "---
status: open
priority: 3
---
# Tasks
- [ ] first 📅 2026-12-01
- [x] second
").unwrap();
        ok(tasked);
        let listed = ok(bridge.call(&argv(&["doc", "tasks", "--all-domains", "--include-private", "--actor", "viewer"]), None).unwrap());
        let rows = listed["tasks"].as_array().unwrap();
        assert_eq!(rows.iter().filter(|t| t["path"] == "Tasks.md").map(|t| (t["line"].as_i64().unwrap(), t["done"].as_bool().unwrap(), t["text"].as_str().unwrap().to_string(), t["due"].as_str().map(str::to_string))).collect::<Vec<_>>(),
            [(6, false, "first 📅 2026-12-01".to_string(), Some("2026-12-01".to_string())), (7, true, "second".to_string(), None)]);
        let open = ok(bridge.call(&argv(&["doc", "tasks", "--all-domains", "--open", "--include-private", "--actor", "viewer"]), None).unwrap());
        assert!(open["tasks"].as_array().unwrap().iter().all(|t| t["done"] == false));
        let query = |payload: &str| {
            let reply = call_with_file(&bridge, None, &staging, &argv(&["doc", "query", "--all-domains", "--include-private", "--actor", "viewer"]), payload, PAYLOAD_FILE).unwrap();
            ok(reply)["pages"].as_array().unwrap().iter().map(|p| p["path"].as_str().unwrap().to_string()).collect::<Vec<_>>()
        };
        assert_eq!(query(r#"{"where":[{"key":"status","op":"=","value":"OPEN"},{"key":"priority","op":">","value":2}],"sort":[{"key":"title","order":"asc"}],"notebook":"daily"}"#), ["Tasks.md"]);
        assert!(query(r#"{"where":[{"key":"status","op":"=","value":"closed"}]}"#).is_empty());
        let bad = call_with_file(&bridge, None, &staging, &argv(&["doc", "query", "--all-domains", "--include-private", "--actor", "viewer"]), r#"{"where":[{"key":"a","op":"like","value":"b"}]}"#, PAYLOAD_FILE).unwrap();
        assert_ne!(bad.exit_code, 0, "a condition Living Memory does not know is refused");
        assert_eq!(std::fs::read_dir(&staging).unwrap().count(), 0, "the staged payloads are removed");

        // R2-D1: a request made before the bridge switched stores is refused, one made after runs.
        let before = bridge.generation();
        bridge.reconfigure(bridge.launch());
        assert_eq!(bridge.call_at(Some(before), &argv(&["version"]), None).unwrap_err(), crate::bridge::STORE_CHANGED);
        ok(bridge.call_at(Some(bridge.generation()), &argv(&["version"]), None).unwrap());

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

    /// Codex re-review of 75ce884, R2-P3: in a case-sensitive folder, a junction `plans` to its sibling `PLANS` resolves to
    /// a path equal to the expected one but for letter case; it is refused because it is a link. Skipped where Windows
    /// does not let this user make a folder case-sensitive.
    #[cfg(windows)]
    #[test]
    fn a_link_to_a_sibling_differing_only_in_case_is_refused() {
        let base = std::env::temp_dir().join(format!("hm-lmdoc-{}", uuid::Uuid::new_v4().simple()));
        let (store, notebooks) = (base.join("store"), base.join("store").join("domains").join("demo").join("notebooks"));
        std::fs::create_dir_all(&notebooks).unwrap();
        let sensitive = std::process::Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&notebooks).arg("enable").output();
        if !sensitive.is_ok_and(|out| out.status.success()) {
            std::fs::remove_dir_all(&base).ok();
            return;
        }
        std::fs::create_dir_all(notebooks.join("PLANS").join("assets")).unwrap();
        std::fs::write(notebooks.join("PLANS").join("assets").join("0123abcd-plan.pdf"), b"%PDF").unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(notebooks.join("plans")).arg(notebooks.join("PLANS")).output().unwrap();
        assert!(made.status.success(), "{made:?}");
        assert!(folder(&store, "lm:demo:plans").is_err());
        assert!(attachment(&store, "lm:demo:plans", "assets/0123abcd-plan.pdf").is_err());
        std::fs::remove_dir(notebooks.join("plans")).ok();
        std::fs::remove_dir_all(&base).ok();
    }

    /// Codex review of 32fee20, P2: a notebook folder that is a junction to another folder in the store gets no grant,
    /// and only attachments of kinds that do not run open.
    #[cfg(windows)]
    #[test]
    fn a_notebook_that_leads_elsewhere_in_the_store_is_refused() {
        let base = std::env::temp_dir().join(format!("hm-lmdoc-{}", uuid::Uuid::new_v4().simple()));
        let store = base.join("store");
        let real = store.join("domains").join("other").join("notebooks").join("secret");
        std::fs::create_dir_all(real.join("assets")).unwrap();
        std::fs::write(real.join("assets").join("0123abcd-plan.pdf"), b"%PDF").unwrap();
        std::fs::write(real.join("assets").join("0123abcd-run.exe"), b"MZ").unwrap();
        std::fs::write(real.join("Page.md"), b"x").unwrap();
        let notebooks = store.join("domains").join("demo").join("notebooks");
        std::fs::create_dir_all(&notebooks).unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(notebooks.join("plans")).arg(&real).output().unwrap();
        assert!(made.status.success(), "{made:?}");
        assert!(folder(&store, "lm:demo:plans").is_err(), "a junction to another notebook");
        assert!(attachment(&store, "lm:demo:plans", "assets/0123abcd-plan.pdf").is_err());
        assert!(folder(&store, "lm:other:secret").is_ok());
        assert!(attachment(&store, "lm:other:secret", "assets/0123abcd-plan.pdf").is_ok());
        assert!(attachment(&store, "lm:other:secret", "assets/0123abcd-run.exe").is_err());
        assert!(attachment(&store, "lm:other:secret", "Page.md").is_err());
        assert!(attachment(&store, "lm:other:secret", "assets/../Page.md").is_err());
        let copy = copy_to_open(&attachment(&store, "lm:other:secret", "assets/0123abcd-plan.pdf").unwrap()).unwrap();
        assert_eq!(copy.file_name().unwrap(), "plan.pdf");
        assert!(std::fs::metadata(&copy).unwrap().permissions().readonly());
        std::fs::remove_dir(notebooks.join("plans")).ok();
        std::fs::remove_dir_all(&base).ok();
        let mut perms = std::fs::metadata(&copy).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&copy, perms).ok();
        std::fs::remove_dir_all(copy.parent().unwrap()).ok();
    }
}
