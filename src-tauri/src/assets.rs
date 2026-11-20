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

/// Opaque ids for folders the webview may load pictures from, rebuilt each run.
#[derive(Default)]
pub struct AssetGrants {
    roots: Mutex<HashMap<String, PathBuf>>,
}

impl AssetGrants {
    /// The grant for `root`, made on first use.
    pub fn grant(&self, root: &Path) -> String {
        let mut roots = self.roots.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((id, _)) = roots.iter().find(|(_, r)| r.as_path() == root) {
            return id.clone();
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        roots.insert(id.clone(), root.to_path_buf());
        id
    }

    /// Withdraw every grant whose root `keep` rejects.
    pub fn retain(&self, keep: impl Fn(&Path) -> bool) {
        self.roots.lock().unwrap_or_else(|e| e.into_inner()).retain(|_, r| keep(r));
    }

    fn root(&self, id: &str) -> Option<PathBuf> {
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
    let Some(root) = grants.root(grant) else { return status(StatusCode::NOT_FOUND) };
    let Some(rel) = decode(rel) else { return status(StatusCode::BAD_REQUEST) };
    let Ok(full) = contain::resolve_inside(&root, &rel, false) else { return status(StatusCode::FORBIDDEN) };
    if protected.check(&full).is_err() || contain::check_rel(&rel).map(|parts| parts.iter().any(|p| p.starts_with('.'))).unwrap_or(true) {
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
    let wanted = request.headers().get(header::RANGE).and_then(|r| r.to_str().ok());
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
