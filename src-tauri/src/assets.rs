//! The `hmfile` scheme (NS-1B, README 5.5): pictures and PDFs beside a page, served to the main webview as
//! `http://hmfile.localhost/<grant>/<percent-encoded relative path>`. Scheme handlers are outside Tauri's capabilities,
//! so this handler is the only gate: the webview label, the exact origin, the method, an opaque grant that names a root
//! folder, containment inside that root, the protected places, an extension list and a size cap.
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::http::{header, Method, Request, Response, StatusCode};

use crate::files::{contain, guard::Protected};

pub const SCHEME: &str = "hmfile";
/// The largest file served.
const MAX_BYTES: u64 = 50 * 1024 * 1024;
/// The origins the app's pages load from: production, and the dev server.
pub const ORIGINS: &[&str] = &["http://tauri.localhost", "tauri://localhost", "http://localhost:1420"];

/// What a grant serves: any picture under a folder outside the store (a folder notebook, a loose file's folder), or
/// only the `assets/` folder of a Living Memory notebook, which lies inside the store (NS-2C).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scope {
    Folder,
    LmAssets,
}

/// Opaque ids for folders the webview may load pictures from, rebuilt each run.
#[derive(Default)]
pub struct AssetGrants {
    roots: Mutex<HashMap<String, (PathBuf, Scope)>>,
}

impl AssetGrants {
    /// The grant for `root`, made on first use.
    pub fn grant(&self, root: &Path) -> String {
        self.grant_scoped(root, Scope::Folder)
    }

    /// The grant for a Living Memory notebook folder: it serves files under its `assets/` folder only.
    pub fn grant_lm(&self, notebook: &Path) -> String {
        self.grant_scoped(notebook, Scope::LmAssets)
    }

    fn grant_scoped(&self, root: &Path, scope: Scope) -> String {
        let mut roots = self.roots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((id, _)) = roots.iter().find(|(_, (r, s))| r.as_path() == root && *s == scope) {
            return id.clone();
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        roots.insert(id.clone(), (root.to_path_buf(), scope));
        id
    }

    /// Withdraw every folder grant whose root `keep` rejects. Living Memory notebook grants stay: they serve only
    /// attachments, which Hivemind may show for any notebook it lists.
    pub fn retain(&self, keep: impl Fn(&Path) -> bool) {
        self.roots.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, (r, s)| *s == Scope::LmAssets || keep(r));
    }

    fn root(&self, id: &str) -> Option<(PathBuf, Scope)> {
        self.roots.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
    }
}

/// The URL prefix for files under `root`, ending in a slash.
pub fn base_url(grant: &str) -> String {
    format!("http://{SCHEME}.localhost/{grant}/")
}

fn content_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

/// Percent-decode once. Invalid escapes or bytes that are not UTF-8 refuse the request.
fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// One byte range of `len`, from a `Range: bytes=...` header. None for a range that cannot be served.
fn range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || len == 0 {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (len.saturating_sub(n), len - 1)
        }
        (s, "") => (s.parse().ok()?, len - 1),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(len - 1)),
    };
    (start <= end && start < len).then_some((start, end))
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).header(header::CACHE_CONTROL, "no-store").body(Vec::new()).unwrap_or_default()
}

/// Answer one request. `label` is the requesting webview; `protected` holds the store and managed vaults now.
pub fn serve(request: &Request<Vec<u8>>, label: &str, grants: &AssetGrants, protected: &Protected) -> Response<Vec<u8>> {
    let origin = request.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok());
    if label != "main" || origin.is_some_and(|o| !ORIGINS.contains(&o)) {
        return status(StatusCode::FORBIDDEN);
    }
    let cors = |b: tauri::http::response::Builder| match origin {
        Some(o) => b
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o)
            .header(header::VARY, "Origin")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Accept-Ranges, Content-Length"),
        None => b,
    };
    if request.method() == Method::OPTIONS {
        let b = cors(Response::builder().status(StatusCode::NO_CONTENT))
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range");
        return b.body(Vec::new()).unwrap_or_default();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let path = request.uri().path().trim_start_matches('/');
    let Some((grant, rel)) = path.split_once('/') else { return status(StatusCode::NOT_FOUND) };
    let Some((root, scope)) = grants.root(grant) else { return status(StatusCode::NOT_FOUND) };
    // The granted folder must still be the one granted: a junction put in its place leads elsewhere (Codex review of
    // 52051c8, A1).
    if !contain::unmoved(&root) {
        return status(StatusCode::NOT_FOUND);
    }
    let Some(rel) = decode(rel) else { return status(StatusCode::BAD_REQUEST) };
    let Ok(full) = contain::resolve_inside(&root, &rel, false) else { return status(StatusCode::FORBIDDEN) };
    // Hidden parts are refused in the path asked for and in the path it resolves to, so a visible alias of a hidden
    // folder serves nothing (Codex review of 52051c8, A2).
    let hidden = |rel: &str| contain::check_rel(rel).map(|parts| parts.iter().any(|p| p.starts_with('.'))).unwrap_or(true);
    let resolved = contain::resolved_rel(&root, &full);
    // A Living Memory notebook lies inside the store, which is otherwise never served: only its attachments are, judged
    // on the path they resolve to (NS-2C).
    let allowed = match scope {
        Scope::Folder => protected.check(&full).is_ok(),
        // `assets` exactly, as Living Memory names it: a distinct `Assets` in a case-sensitive folder is not served (Codex
        // review of 32fee20, P2).
        Scope::LmAssets => resolved.as_deref().is_some_and(|r| r.split('/').next() == Some("assets") && r.contains('/')),
    };
    if !allowed || hidden(&rel) || resolved.is_none_or(|r| hidden(&r)) {
        return status(StatusCode::FORBIDDEN);
    }
    let ext = full.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let Some(kind) = content_type(&ext) else { return status(StatusCode::FORBIDDEN) };
    let Ok(meta) = std::fs::metadata(&full) else { return status(StatusCode::NOT_FOUND) };
    if !meta.is_file() {
        return status(StatusCode::NOT_FOUND);
    }
    let len = meta.len();
    if len > MAX_BYTES {
        return status(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0);
    let etag = format!("\"{len:x}-{mtime:x}\"");
    let mut b = cors(Response::builder())
        .header(header::CONTENT_TYPE, kind)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ETAG, &etag)
        .header(header::CACHE_CONTROL, "no-cache");
    if ext == "svg" {
        b = b.header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'unsafe-inline'");
    }
    // Range applies to GET only; HEAD describes the whole file (RFC 9110 section 14.2; Codex review of 52051c8, A4).
    let wanted = (request.method() == Method::GET).then(|| request.headers().get(header::RANGE).and_then(|r| r.to_str().ok())).flatten();
    let (start, end, code) = match wanted {
        Some(value) => match range(value, len) {
            Some((s, e)) => (s, e, StatusCode::PARTIAL_CONTENT),
            None => {
                return cors(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .body(Vec::new())
                    .unwrap_or_default();
            }
        },
        None => (0, len.saturating_sub(1), StatusCode::OK),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    b = b.status(code).header(header::CONTENT_LENGTH, count);
    if code == StatusCode::PARTIAL_CONTENT {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    if request.method() == Method::HEAD {
        return b.body(Vec::new()).unwrap_or_default();
    }
    let mut body = vec![0u8; count as usize];
    let read = std::fs::File::open(&full).and_then(|mut f| {
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(&mut body)
    });
    match read {
        Ok(()) => b.body(body).unwrap_or_default(),
        Err(_) => status(StatusCode::NOT_FOUND),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-assets-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("img")).unwrap();
        std::fs::write(dir.join("img").join("a b.png"), b"0123456789").unwrap();
        std::fs::write(dir.join("pic.svg"), b"<svg/>").unwrap();
        std::fs::write(dir.join("notes.md"), b"# no").unwrap();
        dir.canonicalize().unwrap()
    }

    fn get(url: &str, headers: &[(&str, &str)]) -> Request<Vec<u8>> {
        let mut b = Request::builder().method(Method::GET).uri(url);
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        b.body(Vec::new()).unwrap()
    }

    #[test]
    fn serves_a_picture_with_headers_and_ranges() {
        let dir = scratch();
        let grants = AssetGrants::default();
        let g = grants.grant(&dir);
        let none = Protected::new(None);
        let ok = serve(&get(&format!("{}img/a%20b.png", base_url(&g)), &[("Origin", "http://tauri.localhost")]), "main", &grants, &none);
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.body(), b"0123456789");
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "http://tauri.localhost");
        assert_eq!(ok.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        let part = serve(&get(&format!("{}img/a%20b.png", base_url(&g)), &[("Range", "bytes=2-4")]), "main", &grants, &none);
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.body(), b"234");
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        let tail = serve(&get(&format!("{}img/a%20b.png", base_url(&g)), &[("Range", "bytes=-3")]), "main", &grants, &none);
        assert_eq!(tail.body(), b"789");
        let bad = serve(&get(&format!("{}img/a%20b.png", base_url(&g)), &[("Range", "bytes=20-")]), "main", &grants, &none);
        assert_eq!(bad.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(bad.headers()[header::CONTENT_RANGE], "bytes */10");
        let svg = serve(&get(&format!("{}pic.svg", base_url(&g)), &[]), "main", &grants, &none);
        assert!(svg.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().starts_with("default-src 'none'"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_moved_root_or_a_visible_alias_of_a_hidden_folder_serves_nothing() {   // Codex review of 52051c8, A1 and A2
        let junction = |link: &Path, target: &Path| {
            let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target).output().unwrap();
            assert!(made.status.success(), "mklink /J needs no admin rights: {}", String::from_utf8_lossy(&made.stderr));
        };
        let dir = scratch();
        std::fs::create_dir_all(dir.join(".private")).unwrap();
        std::fs::write(dir.join(".private/scan.png"), b"secret").unwrap();
        junction(&dir.join("pics"), &dir.join(".private"));
        let grants = AssetGrants::default();
        let g = grants.grant(&dir);
        let none = Protected::new(None);
        let ask = |rel: &str| serve(&get(&format!("{}{rel}", base_url(&g)), &[]), "main", &grants, &none).status();
        assert_eq!(ask("img/a%20b.png"), StatusCode::OK);
        assert_eq!(ask("pics/scan.png"), StatusCode::FORBIDDEN, "a visible alias of a hidden folder");
        // The granted folder moved away and a junction to another folder put in its place.
        let other = scratch();
        std::fs::remove_dir(dir.join("pics")).unwrap();
        let moved = dir.with_file_name(format!("{}-moved", dir.file_name().unwrap().to_string_lossy()));
        std::fs::rename(&dir, &moved).unwrap();
        junction(&dir, &other);
        assert_eq!(ask("img/a%20b.png"), StatusCode::NOT_FOUND, "the grant does not follow the junction");
        std::fs::remove_dir(&dir).unwrap();
        for d in [moved, other] {
            std::fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn head_ignores_range() {   // Codex review of 52051c8, A4
        let dir = scratch();
        let grants = AssetGrants::default();
        let g = grants.grant(&dir);
        let none = Protected::new(None);
        for range in ["bytes=0-0", "bytes=20-"] {
            let req = Request::builder().method(Method::HEAD).uri(format!("{}img/a%20b.png", base_url(&g))).header("Range", range).body(Vec::new()).unwrap();
            let res = serve(&req, "main", &grants, &none);
            assert_eq!(res.status(), StatusCode::OK, "{range}");
            assert_eq!(res.headers()[header::CONTENT_LENGTH], "10");
            assert!(res.body().is_empty());
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn every_refusal() {
        let dir = scratch();
        let grants = AssetGrants::default();
        let g = grants.grant(&dir);
        let none = Protected::new(None);
        let url = |rel: &str| format!("{}{rel}", base_url(&g));
        let code = |req: Request<Vec<u8>>, label: &str| serve(&req, label, &grants, &none).status();
        assert_eq!(code(get(&url("img/a%20b.png"), &[]), "capture"), StatusCode::FORBIDDEN, "another webview");
        assert_eq!(code(get(&url("img/a%20b.png"), &[("Origin", "https://evil.example")]), "main"), StatusCode::FORBIDDEN);
        let post = Request::builder().method(Method::POST).uri(url("img/a%20b.png")).body(Vec::new()).unwrap();
        assert_eq!(code(post, "main"), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(code(get(&format!("{}img/a%20b.png", base_url("0123")), &[]), "main"), StatusCode::NOT_FOUND, "unknown grant");
        for rel in ["..%2Fsecret.png", "%2e%2e/secret.png", "img%5c..%5c..%5csecret.png", "C:%2Fx.png", ".hivemind/x.png", "img/%zz.png"] {
            let c = code(get(&url(rel), &[]), "main");
            assert!(c == StatusCode::FORBIDDEN || c == StatusCode::BAD_REQUEST, "{rel}: {c}");
        }
        assert_eq!(code(get(&url("notes.md"), &[]), "main"), StatusCode::FORBIDDEN, "not a picture");
        assert_eq!(code(get(&url("img/missing.png"), &[]), "main"), StatusCode::NOT_FOUND);
        grants.retain(|root| root != dir);
        assert_eq!(code(get(&url("img/a%20b.png"), &[]), "main"), StatusCode::NOT_FOUND, "a revoked grant");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_store_inside_a_grant_is_refused() {
        let dir = scratch();
        let store = dir.join("img");
        let grants = AssetGrants::default();
        let g = grants.grant(&dir);
        let r = serve(&get(&format!("{}img/a%20b.png", base_url(&g)), &[]), "main", &grants, &Protected::new(Some(&store)));
        assert_eq!(r.status(), StatusCode::FORBIDDEN);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// NS-2C: a Living Memory notebook lies inside the store; its grant serves its attachments and nothing else.
    #[test]
    fn a_living_memory_grant_serves_only_attachments() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets").join("1a2b3c4d-pic.png"), b"png").unwrap();
        let grants = AssetGrants::default();
        let g = grants.grant_lm(&dir);
        let store = Protected::new(Some(&dir));
        let code = |rel: &str| serve(&get(&format!("{}{rel}", base_url(&g)), &[]), "main", &grants, &store).status();
        assert_eq!(code("assets/1a2b3c4d-pic.png"), StatusCode::OK);
        if cfg!(windows) {
            assert_eq!(code("ASSETS/1a2b3c4d-pic.png"), StatusCode::OK, "Windows matches the folder in any case");
        }
        assert_eq!(code("img/a%20b.png"), StatusCode::FORBIDDEN, "a picture outside assets/");
        assert_eq!(code("assets/../img/a%20b.png"), StatusCode::FORBIDDEN);
        assert_eq!(code("notes.md"), StatusCode::FORBIDDEN);
        // A folder grant of the same folder is still refused inside the store, and pruning keeps the notebook grant.
        let folder = grants.grant(&dir);
        assert_ne!(folder, g);
        assert_eq!(serve(&get(&format!("{}assets/1a2b3c4d-pic.png", base_url(&folder)), &[]), "main", &grants, &store).status(), StatusCode::FORBIDDEN);
        grants.retain(|_| false);
        assert_eq!(code("assets/1a2b3c4d-pic.png"), StatusCode::OK);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Codex review of 32fee20, P2: a folder named `Assets` on disk is not Living Memory's `assets` and serves nothing.
    #[test]
    fn a_folder_named_otherwise_than_assets_is_not_served() {
        let dir = scratch();
        std::fs::create_dir_all(dir.join("Assets")).unwrap();
        std::fs::write(dir.join("Assets").join("pic.png"), b"png").unwrap();
        let grants = AssetGrants::default();
        let g = grants.grant_lm(&dir);
        let store = Protected::new(Some(&dir));
        let code = |rel: &str| serve(&get(&format!("{}{rel}", base_url(&g)), &[]), "main", &grants, &store).status();
        assert_eq!(code("Assets/pic.png"), StatusCode::FORBIDDEN);
        assert_eq!(code("assets/pic.png"), StatusCode::FORBIDDEN, "found in any case, but named Assets");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_out_of_the_grant_is_refused() {
        let dir = scratch();
        let outside = std::env::temp_dir().join(format!("hm-assets-out-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("x.png"), b"x").unwrap();
        let made = std::process::Command::new("cmd").args(["/C", "mklink", "/J"]).arg(dir.join("link")).arg(&outside).output();
        if made.map(|o| o.status.success()).unwrap_or(false) {
            let grants = AssetGrants::default();
            let g = grants.grant(&dir);
            let r = serve(&get(&format!("{}link/x.png", base_url(&g)), &[]), "main", &grants, &Protected::new(None));
            assert_eq!(r.status(), StatusCode::FORBIDDEN);
        }
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
