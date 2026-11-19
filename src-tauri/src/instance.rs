//! One Hivemind per data folder (EXEC-7, EXEC-12). A launch first takes an exclusive lock on `instance.lock` in the app
//! data folder and keeps it for the life of the process; only the holder starts a window or a writer. The holder also
//! listens on a loopback port, published with its process id and a random token in `instance.port` (readable by its user
//! only). A launch that finds the lock taken sends the token there, the holder answers and comes to the front, and the
//! launch exits. The lock alone decides, so two launches at the same moment, or in two desktop sessions of the same user,
//! still leave one copy, and it is the one later launches reach.
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A token is a simple UUID: 32 hex characters, sent as the whole request.
const TOKEN_LEN: usize = 32;
/// The holder's answer to a valid token.
const ANSWER: &[u8] = b"ok";
/// The most a request may take to arrive, and the most a launch waits for the answer.
const PATIENCE: Duration = Duration::from_secs(2);

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
    /// Call `show` for each later launch that knocks with the token, for the life of the process. Each knock is answered on
    /// a thread of its own, so a slow or silent connection holds up no other.
    pub fn serve(self, show: impl Fn() + Send + Sync + 'static) {
        let show: Arc<dyn Fn() + Send + Sync> = Arc::new(show);
        std::thread::spawn(move || {
            let Owner { lock: _lock, listener, token } = self;
            for stream in listener.incoming().flatten() {
                let (token, show) = (token.clone(), show.clone());
                std::thread::spawn(move || {
                    if answer(stream, &token) {
                        show();
                    }
                });
            }
        });
    }
}

/// Read one request within PATIENCE and answer it if it is the token.
fn answer(mut stream: TcpStream, token: &str) -> bool {
    let deadline = Instant::now() + PATIENCE;
    let mut heard = [0u8; TOKEN_LEN];
    let mut filled = 0;
    while filled < TOKEN_LEN {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            return false;
        }
        match stream.read(&mut heard[filled..]) {
            Ok(0) | Err(_) => return false,
            Ok(n) => filled += n,
        }
    }
    heard == token.as_bytes() && stream.write_all(ANSWER).is_ok()
}

/// Ask the copy that holds `dir` to come to the front, retrying for up to `wait` while it is still starting or while the
/// published port answers wrongly (a stale file). True only once the holder has answered.
pub fn knock(dir: &Path, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        let published = std::fs::read_to_string(dir.join("instance.port")).unwrap_or_default();
        let mut fields = published.split_whitespace();
        let port = fields.next().and_then(|p| p.parse::<u16>().ok());
        let pid = fields.next().and_then(|p| p.parse::<u32>().ok());
        if let (Some(port), Some(pid), Some(token)) = (port, pid, fields.next()) {
            // Windows lets a background process take the foreground only when the one in front allows it.
            allow_foreground(pid);
            if answered(SocketAddr::from((Ipv4Addr::LOCALHOST, port)), token) {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn answered(address: SocketAddr, token: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else { return false };
    if stream.write_all(token.as_bytes()).is_err() || stream.set_read_timeout(Some(PATIENCE)).is_err() {
        return false;
    }
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).is_ok() && reply == ANSWER
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
    use std::sync::atomic::{AtomicUsize, Ordering};

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
        owner.serve(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        let port = published_port(&dir);
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap().write_all(&[b'x'; TOKEN_LEN]).unwrap();
        // A client that connects and says nothing holds up no one (Codex review of e27c774).
        let _silent = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        let start = Instant::now();
        assert!(knock(&dir, Duration::from_secs(5)));
        assert!(knock(&dir, Duration::from_secs(5)));
        assert!(start.elapsed() < Duration::from_secs(1), "the silent client did not delay the knocks");
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(shown.load(Ordering::SeqCst), 2, "two knocks with the token, no stranger");
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
        assert!(!knock(&dir, Duration::from_millis(300)));
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
