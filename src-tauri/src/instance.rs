//! One Hivemind per data folder (EXEC-7, EXEC-12). A launch first takes an exclusive lock on `instance.lock` in the app
//! data folder and keeps it for the life of the process; only the holder starts a window or a writer. The holder also
//! listens on a loopback port, published with its process id and a random token in `instance.port` (readable by its user
//! only). A launch that finds the lock taken sends the token there, the holder answers and comes to the front, and the
//! launch exits. The lock alone decides, so two launches at the same moment, or in two desktop sessions of the same user,
//! still leave one copy, and it is the one later launches reach.
//!
//! Protocol version 2 (Notes Studio NS-1B): after the token a launch may send a newline and a JSON request naming files
//! to open (`Knock`). The holder answers only after its callback has queued them, so a launch that got the answer knows
//! the files will open. A token alone still only brings the window to the front, so old and new builds interoperate: an
//! old holder refuses a request with files (it reads no more than the token), and the launch then knocks with the token
//! alone (`knock_open`).
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// A token is a simple UUID: 32 hex characters, sent as the whole request (the launch then closes its side).
const TOKEN_LEN: usize = 32;
/// The most a request may take to arrive.
const PATIENCE: Duration = Duration::from_secs(2);
/// The most knocks answered at once; more connections are closed unread.
const WORKERS: usize = 4;
/// The most a knock may carry: the token, a newline and the JSON request.
pub const MAX_KNOCK: usize = 64 * 1024;

/// What a launch asks of the holder. A knock with the token alone is `Knock::default()`: come to the front.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq)]
pub struct Knock {
    /// The request format, 1.
    pub v: u32,
    /// Chosen by the launch and kept when it resends, so the holder can drop a request it already queued.
    #[serde(default)]
    pub id: Option<String>,
    /// Absolute paths of files to open.
    #[serde(default)]
    pub open: Vec<String>,
    /// The launch's working folder.
    #[serde(default)]
    pub cwd: Option<String>,
}

/// How a launch with files to open reached the holder.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// The holder queued the files.
    Opened,
    /// The holder only came to the front: it is an older build that cannot take files.
    RaisedOnly,
    /// No holder answered.
    NoAnswer,
}

pub enum Claim {
    Owner(Owner),
    /// Another process holds the data folder.
    Taken,
}

/// The data folder's lock and the port later launches knock on.
pub struct Owner {
    lock: File,
    listener: TcpListener,
    token: String,
}

/// Take `dir/instance.lock`, then publish where later launches reach this copy.
pub fn claim(dir: &Path) -> Result<Claim, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join("instance.lock")).map_err(|e| e.to_string())?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Ok(Claim::Taken),
        Err(std::fs::TryLockError::Error(e)) => return Err(e.to_string()),
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();
    publish(&dir.join("instance.port"), &format!("{port} {} {token}", std::process::id())).map_err(|e| e.to_string())?;
    Ok(Claim::Owner(Owner { lock, listener, token }))
}

/// Write `text` to a fresh temporary file (its user's only, on Unix) and rename it into place.
fn publish(path: &Path, text: &str) -> std::io::Result<()> {
    let temp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&temp);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&temp)?.write_all(text.as_bytes())?;
    std::fs::rename(&temp, path)
}

impl Owner {
    /// Call `on_knock` for each later launch that knocks with the token, for the life of the process, and answer the launch
    /// once it returns. Each knock is answered on a worker of its own (WORKERS at most), so a slow or silent connection
    /// holds up no other.
    pub fn serve(self, on_knock: impl Fn(Knock) + Send + Sync + 'static) {
        let Owner { lock, listener, token } = self;
        // Held until the process exits, whatever happens to the listener (the OS releases it then).
        std::mem::forget(lock);
        let show: Arc<dyn Fn(Knock) + Send + Sync> = Arc::new(on_knock);
        let busy = Arc::new(AtomicUsize::new(0));
        let _ = std::thread::Builder::new().name("instance".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                if busy.fetch_add(1, Ordering::SeqCst) >= WORKERS {
                    busy.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let (token, show, worker_busy) = (token.clone(), show.clone(), busy.clone());
                let started = std::thread::Builder::new().spawn(move || {
                    answer(stream, &token, &*show);
                    worker_busy.fetch_sub(1, Ordering::SeqCst);
                });
                if started.is_err() {
                    busy.fetch_sub(1, Ordering::SeqCst);
                }
            }
        });
    }
}

/// What the holder answers to `token`: the token reversed, so an unrelated program on a reused port cannot answer it.
fn reply(token: &str) -> Vec<u8> {
    token.bytes().rev().collect()
}

/// Read one request within PATIENCE: the token, then optionally a newline and a JSON `Knock`, then the end.
fn read_knock(stream: &mut TcpStream, token: &str) -> Option<Knock> {
    let deadline = Instant::now() + PATIENCE;
    let mut heard = Vec::with_capacity(TOKEN_LEN + 1);
    let mut chunk = [0u8; 4096];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Err(_) => return None,
            Ok(n) => heard.extend_from_slice(&chunk[..n]),
        }
        if heard.len() > MAX_KNOCK {
            return None;
        }
    }
    if heard.len() < TOKEN_LEN || &heard[..TOKEN_LEN] != token.as_bytes() {
        return None;
    }
    match &heard[TOKEN_LEN..] {
        [] => Some(Knock::default()),
        [b'\n', json @ ..] => serde_json::from_slice::<Knock>(json).ok().filter(|k| k.v == 1),
        _ => None, // more than the token, and not a request
    }
}

/// Answer one launch: hand its request to `deliver`, then reply, so the reply means the request was taken.
fn answer(mut stream: TcpStream, token: &str, deliver: &dyn Fn(Knock)) -> bool {
    let Some(knock) = read_knock(&mut stream, token) else { return false };
    deliver(knock);
    stream.write_all(&reply(token)).is_ok()
}

/// Ask the copy that holds `dir` to come to the front, retrying for up to `wait` while it is still starting or while the
/// published port answers wrongly (a stale file). True only once the holder has answered.
pub fn knock(dir: &Path, wait: Duration) -> bool {
    knock_with(dir, wait, &[])
}

/// Ask the holder to open files; if it does not take them within `wait` (an older build reads no more than the token),
/// knock with the token alone so it at least comes to the front.
pub fn knock_open(dir: &Path, request: &Knock, wait: Duration) -> Delivery {
    let payload = serde_json::to_vec(request).unwrap_or_default();
    if payload.len() + TOKEN_LEN + 1 > MAX_KNOCK {
        return if knock(dir, wait) { Delivery::RaisedOnly } else { Delivery::NoAnswer };
    }
    let mut body = vec![b'\n'];
    body.extend(payload);
    if knock_with(dir, wait, &body) {
        Delivery::Opened
    } else if knock(dir, Duration::from_secs(2)) {
        Delivery::RaisedOnly
    } else {
        Delivery::NoAnswer
    }
}

/// Send the token and `body`, retrying for up to `wait`. The same body is resent each time, so a holder that queued a
/// request whose answer was lost sees its id again and drops it.
fn knock_with(dir: &Path, wait: Duration, body: &[u8]) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        let published = std::fs::read_to_string(dir.join("instance.port")).unwrap_or_default();
        let mut fields = published.split_whitespace();
        let port = fields.next().and_then(|p| p.parse::<u16>().ok());
        let pid = fields.next().and_then(|p| p.parse::<u32>().ok());
        if let (Some(port), Some(pid), Some(token)) = (port, pid, fields.next()) {
            // Windows lets a background process take the foreground only when the one in front allows it.
            allow_foreground(pid);
            if answered(SocketAddr::from((Ipv4Addr::LOCALHOST, port)), token, body, deadline) {
                return true;
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        std::thread::sleep(left.min(Duration::from_millis(100)));
    }
}

/// Send the token (and `body`) and wait for the holder's reply, all before `deadline`.
fn answered(address: SocketAddr, token: &str, body: &[u8], deadline: Instant) -> bool {
    let left = || deadline.saturating_duration_since(Instant::now());
    if left().is_zero() {
        return false;
    }
    let Ok(mut stream) = TcpStream::connect_timeout(&address, left().min(Duration::from_millis(500))) else { return false };
    if stream.write_all(token.as_bytes()).is_err() || stream.write_all(body).is_err() || stream.shutdown(std::net::Shutdown::Write).is_err() {
        return false;
    }
    let mut heard = vec![0u8; TOKEN_LEN];
    left() > Duration::ZERO && stream.set_read_timeout(Some(left())).is_ok() && stream.read_exact(&mut heard).is_ok() && heard == reply(token)
}

#[cfg(windows)]
fn allow_foreground(pid: u32) {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn AllowSetForegroundWindow(process: u32) -> i32;
    }
    // SAFETY: the call takes a plain process id and only changes which process may take the foreground.
    unsafe {
        AllowSetForegroundWindow(pid);
    }
}

#[cfg(not(windows))]
fn allow_foreground(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("hivemind-instance-{}", uuid::Uuid::new_v4().simple()))
    }

    fn published_port(dir: &Path) -> u16 {
        std::fs::read_to_string(dir.join("instance.port")).unwrap().split(' ').next().unwrap().parse().unwrap()
    }

    #[test]
    fn only_one_process_claims_the_data_folder() {
        let dir = scratch();
        let first = claim(&dir).unwrap();
        assert!(matches!(first, Claim::Owner(_)));
        assert!(matches!(claim(&dir).unwrap(), Claim::Taken), "a second claim is refused while the first is held");
        drop(first);
        assert!(matches!(claim(&dir).unwrap(), Claim::Owner(_)), "the claim ends with its holder");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn launches_at_the_same_moment_leave_one_owner() {
        let dir = scratch();
        let claims: Vec<Claim> = std::thread::scope(|s| {
            let racers: Vec<_> = (0..8).map(|_| s.spawn(|| claim(&dir).unwrap())).collect();
            racers.into_iter().map(|r| r.join().unwrap()).collect()
        });
        assert_eq!(claims.iter().filter(|c| matches!(c, Claim::Owner(_))).count(), 1);
        drop(claims);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_later_launch_reaches_the_owner_and_a_wrong_or_silent_client_does_not() {   // the macOS limit of 99fb13d
        let dir = scratch();
        let Claim::Owner(owner) = claim(&dir).unwrap() else { panic!("not the owner") };
        let shown = Arc::new(AtomicUsize::new(0));
        let seen = shown.clone();
        owner.serve(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        let port = published_port(&dir);
        let token = std::fs::read_to_string(dir.join("instance.port")).unwrap().split(' ').nth(2).unwrap().to_string();
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap().write_all(&[b'x'; TOKEN_LEN]).unwrap();
        // The token with more after it is not a knock (Codex re-review of 2efc229).
        let mut longer = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        longer.write_all(format!("{token}!").as_bytes()).unwrap();
        longer.shutdown(std::net::Shutdown::Write).unwrap();
        // A client that connects and says nothing holds up no one (Codex review of e27c774).
        let _silent = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        let start = Instant::now();
        assert!(knock(&dir, Duration::from_secs(5)));
        assert!(knock(&dir, Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_secs(1), "the silent client did not delay the knocks");
        while shown.load(Ordering::SeqCst) < 2 && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(300)); // room for a wrongly accepted knock to show up
        assert_eq!(shown.load(Ordering::SeqCst), 2, "two knocks with the token, no stranger");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_flood_of_silent_connections_is_capped_and_the_lock_stays() {   // Codex re-review of 2efc229
        let dir = scratch();
        let Claim::Owner(owner) = claim(&dir).unwrap() else { panic!("not the owner") };
        owner.serve(|_| {});
        let port = published_port(&dir);
        let _flood: Vec<TcpStream> = (0..50).map(|_| TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap()).collect();
        assert!(matches!(claim(&dir).unwrap(), Claim::Taken), "the data folder is still held");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_port_that_does_not_answer_is_not_a_success() {   // Codex review of e27c774
        let dir = scratch();
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!knock(&dir, Duration::from_millis(300)), "no file");
        // A stale file whose port now belongs to something else: it accepts, but never answers.
        let stranger = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = stranger.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in stranger.incoming().flatten() {
                std::thread::sleep(Duration::from_secs(3));
                drop(stream);
            }
        });
        publish(&dir.join("instance.port"), &format!("{port} 1 {}", "y".repeat(TOKEN_LEN))).unwrap();
        let start = Instant::now();
        assert!(!knock(&dir, Duration::from_millis(300)));
        assert!(start.elapsed() < Duration::from_millis(900), "the knock keeps to its wait (Codex re-review of 2efc229)");
        // One that answers "ok" to anything is not the holder either.
        let echo = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for mut stream in echo.incoming().flatten() {
                let _ = stream.write_all(&b"ok".repeat(TOKEN_LEN));
            }
        });
        publish(&dir.join("instance.port"), &format!("{echo_port} 1 {}", "y".repeat(TOKEN_LEN))).unwrap();
        assert!(!knock(&dir, Duration::from_millis(300)));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn owner_with(dir: &Path) -> Arc<std::sync::Mutex<Vec<Knock>>> {
        let Claim::Owner(owner) = claim(dir).unwrap() else { panic!("not the owner") };
        let got = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = got.clone();
        owner.serve(move |k| {
            std::thread::sleep(Duration::from_millis(150)); // queueing takes a moment; the answer must wait for it
            sink.lock().unwrap().push(k);
        });
        got
    }

    fn request(paths: &[&str]) -> Knock {
        Knock { v: 1, id: Some("req-1".into()), open: paths.iter().map(|p| p.to_string()).collect(), cwd: Some(r"C:\work".into()) }
    }

    #[test]
    fn a_knock_with_files_is_answered_after_they_are_delivered() {
        let dir = scratch();
        let got = owner_with(&dir);
        assert_eq!(knock_open(&dir, &request(&[r"C:\a.md", r"C:\b.log"]), Duration::from_secs(5)), Delivery::Opened);
        // The answer came after delivery, so the request is already there.
        assert_eq!(got.lock().unwrap().as_slice(), &[request(&[r"C:\a.md", r"C:\b.log"])]);
        assert!(knock(&dir, Duration::from_secs(5)));
        assert_eq!(got.lock().unwrap()[1], Knock::default(), "a token alone (an old launch) only raises");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_or_malformed_requests_are_refused() {
        let dir = scratch();
        let got = owner_with(&dir);
        let port = published_port(&dir);
        let token = std::fs::read_to_string(dir.join("instance.port")).unwrap().split(' ').nth(2).unwrap().to_string();
        let send = |body: Vec<u8>| {
            let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            let mut all = token.clone().into_bytes();
            all.extend(body);
            let _ = s.write_all(&all);
            let _ = s.shutdown(std::net::Shutdown::Write);
            let mut back = Vec::new();
            let _ = s.read_to_end(&mut back);
            back
        };
        assert!(send(b"\nnot json".to_vec()).is_empty());
        assert!(send(b"\n{\"v\":2,\"open\":[]}".to_vec()).is_empty(), "an unknown version");
        let mut huge = b"\n{\"v\":1,\"open\":[\"".to_vec();
        huge.extend(std::iter::repeat_n(b'a', MAX_KNOCK));
        huge.extend(b"\"]}");
        assert!(send(huge).is_empty());
        std::thread::sleep(Duration::from_millis(300));
        assert!(got.lock().unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_old_holder_that_takes_only_the_token_still_comes_to_the_front() {
        // An old build: reads at most the token plus one byte, answers only the bare token.
        let dir = scratch();
        std::fs::create_dir_all(&dir).unwrap();
        let old = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = old.local_addr().unwrap().port();
        let token = "t".repeat(TOKEN_LEN);
        let raised = Arc::new(AtomicUsize::new(0));
        let (t2, r2) = (token.clone(), raised.clone());
        std::thread::spawn(move || {
            for mut stream in old.incoming().flatten() {
                let mut heard = [0u8; TOKEN_LEN + 1];
                let mut filled = 0;
                stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                while let Ok(n) = stream.read(&mut heard[filled..]) {
                    if n == 0 { break; }
                    filled += n;
                    if filled > TOKEN_LEN { break; }
                }
                if filled == TOKEN_LEN && heard[..TOKEN_LEN] == *t2.as_bytes() {
                    r2.fetch_add(1, Ordering::SeqCst);
                    let _ = stream.write_all(&reply(&t2));
                }
            }
        });
        publish(&dir.join("instance.port"), &format!("{port} 1 {token}")).unwrap();
        assert_eq!(knock_open(&dir, &request(&[r"C:\a.md"]), Duration::from_millis(600)), Delivery::RaisedOnly);
        assert_eq!(raised.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn the_token_file_is_its_users_only() {   // Codex review of e27c774
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        let _owner = claim(&dir).unwrap();
        let mode = std::fs::metadata(dir.join("instance.port")).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}
