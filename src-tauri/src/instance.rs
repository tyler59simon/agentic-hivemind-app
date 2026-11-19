//! One Hivemind per data folder (EXEC-7, EXEC-12). A launch first takes an exclusive lock on `instance.lock` in the app
//! data folder and keeps it for the life of the process; only the holder starts a window or a writer. The holder also
//! listens on a loopback port, written with a random token to `instance.port`. A launch that finds the lock taken sends
//! the token there, so the running copy comes to the front, and exits. The lock alone decides, so two launches at the same
//! moment, or in two desktop sessions of the same user, still leave one copy, and it is the one later launches reach.
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::time::{Duration, Instant};

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
    let path = dir.join("instance.port");
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, format!("{port} {token}")).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    Ok(Claim::Owner(Owner { lock, listener, token }))
}

impl Owner {
    /// Call `show` for each later launch that knocks with the token, on a thread of its own that also keeps the lock for the
    /// life of the process.
    pub fn serve(self, show: impl Fn() + Send + 'static) {
        std::thread::spawn(move || {
            let Owner { lock: _lock, listener, token } = self;
            for stream in listener.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                let mut heard = Vec::new();
                let _ = stream.take(64).read_to_end(&mut heard);
                if heard == token.as_bytes() {
                    show();
                }
            }
        });
    }
}

/// Ask the copy that holds `dir` to come to the front, retrying for up to `wait` while it is still starting. False when
/// it could not be reached.
pub fn knock(dir: &Path, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        let published = std::fs::read_to_string(dir.join("instance.port")).ok();
        if let Some((port, token)) = published.as_deref().and_then(|t| t.trim().split_once(' ')) {
            let address = port.parse().ok().map(|port: u16| SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
            if let Some(Ok(mut stream)) = address.map(|a| TcpStream::connect_timeout(&a, Duration::from_millis(500)))
                && stream.write_all(token.as_bytes()).is_ok()
            {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("hivemind-instance-{}", uuid::Uuid::new_v4().simple()))
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
    fn a_later_launch_reaches_the_owner_and_a_wrong_token_does_not() {   // the macOS limit of 99fb13d
        let dir = scratch();
        let Claim::Owner(owner) = claim(&dir).unwrap() else { panic!("not the owner") };
        let shown = Arc::new(AtomicUsize::new(0));
        let seen = shown.clone();
        owner.serve(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        assert!(knock(&dir, Duration::from_secs(5)));
        let port = std::fs::read_to_string(dir.join("instance.port")).unwrap();
        let port: u16 = port.split(' ').next().unwrap().parse().unwrap();
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap().write_all(b"not the token").unwrap();
        assert!(knock(&dir, Duration::from_secs(5)));
        let start = Instant::now();
        while shown.load(Ordering::SeqCst) < 2 && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(shown.load(Ordering::SeqCst), 2, "two knocks with the token, one stranger");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_knock_with_no_owner_gives_up() {
        let dir = scratch();
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!knock(&dir, Duration::from_millis(300)));
        std::fs::remove_dir_all(&dir).ok();
    }
}
