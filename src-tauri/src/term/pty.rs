//! One program in a pseudo terminal: batched output, one exit event after the last output.
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

/// How long output is gathered before it is handed on as one message.
pub const BATCH: Duration = Duration::from_millis(8);
/// A batch is handed on early once it is this big.
pub const BATCH_BYTES: usize = 64 * 1024;
/// How long `close` waits for the program to leave by itself before it is killed.
pub const CLOSE_GRACE: Duration = Duration::from_secs(3);
/// Output has stopped for this long: a good moment to look at what changed on disk.
pub const QUIET: Duration = Duration::from_secs(2);
/// After the program has exited, how long the reader may take to reach the end of the output before `Exit` is sent anyway.
const DRAIN: Duration = Duration::from_secs(2);
/// How often the batcher looks at the clock when no output arrives.
const TICK: Duration = Duration::from_millis(100);

pub enum TermEvent {
    Data(Vec<u8>),
    /// No output for `QUIET` after some output. At most once per burst.
    Quiet,
    /// Always the last event, after all output.
    Exit(Option<u32>),
}

pub type Sink = Arc<dyn Fn(TermEvent) + Send + Sync>;

pub struct Spawn<'a> {
    pub program: &'a str,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
    pub env_remove: &'a [String],
    pub cols: u16,
    pub rows: u16,
}

pub struct Session {
    pid: Option<u32>,
    /// Dropping this closes the pseudoconsole: the reader then reaches EOF, and anything still
    /// attached to the console is told to close.
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exited: Arc<AtomicBool>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

impl Session {
    pub fn open(spawn: Spawn, sink: Sink) -> Result<Session, String> {
        let pair = native_pty_system().openpty(size(spawn.cols, spawn.rows)).map_err(|e| format!("{e:#}"))?;
        let mut command = CommandBuilder::new(spawn.program);
        command.args(spawn.args);
        command.cwd(spawn.cwd);
        for (key, value) in spawn.env {
            command.env(key, value);
        }
        for name in spawn.env_remove {
            command.env_remove(name);
        }
        let mut child = pair.slave.spawn_command(command).map_err(|e| format!("{e:#}"))?;
        // On Windows the slave shares the pseudoconsole with the master; it must not outlive the spawn.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| format!("{e:#}"))?;
        let writer: Arc<Mutex<Box<dyn Write + Send>>> = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| format!("{e:#}"))?));
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let (pid, killer, exited) = (child.process_id(), Mutex::new(child.clone_killer()), Arc::new(AtomicBool::new(false)));

        // Reader: blocking reads, nothing else. A read cannot time out, so batching is its own thread.
        let (chunks_tx, chunks_rx) = mpsc::channel::<Vec<u8>>();
        // Dropped when the reader ends, which the waiter waits for (up to DRAIN).
        let (reader_done, reader_ended) = mpsc::channel::<()>();
        let answer = writer.clone();
        let reader_thread = std::thread::spawn(move || {
            let _done = reader_done;
            let mut buffer = [0u8; 16 * 1024];
            let mut first = true;
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let mut chunk = &buffer[..n];
                // ConPTY (as portable-pty opens it) asks where the cursor is and shows nothing
                // until it is told. Answer here so a session does not depend on the UI being up,
                // and keep the question from the UI's terminal so it is not answered twice.
                if std::mem::take(&mut first) && cfg!(windows) && chunk.starts_with(b"\x1b[6n") {
                    let _ = answer.lock().unwrap().write_all(b"\x1b[1;1R");
                    chunk = &chunk[4..];
                }
                if !chunk.is_empty() && chunks_tx.send(chunk.to_vec()).is_err() {
                    break;
                }
            }
        });

        // Batcher: whole reads joined for up to BATCH, so a flood is tens of messages a second.
        // It also stops when the waiter sets `stop`, after sending what has arrived.
        let batches = sink.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let batch_thread = std::thread::spawn(move || {
            // When the last output of the current burst arrived; None once its `Quiet` was sent.
            let mut last: Option<Instant> = None;
            loop {
                let mut batch = match chunks_rx.recv_timeout(TICK) {
                    Ok(chunk) => chunk,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if last.is_some_and(|at| at.elapsed() >= QUIET) {
                            last = None;
                            batches(TermEvent::Quiet);
                        }
                        if stopping.load(Ordering::SeqCst) {
                            let rest: Vec<u8> = chunks_rx.try_iter().flatten().collect();
                            if !rest.is_empty() {
                                batches(TermEvent::Data(rest));
                            }
                            break;
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let deadline = Instant::now() + BATCH;
                while batch.len() < BATCH_BYTES {
                    match chunks_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(more) => batch.extend_from_slice(&more),
                        Err(_) => break,
                    }
                }
                last = Some(Instant::now());
                batches(TermEvent::Data(batch));
            }
        });

        // Waiter: the only owner of the child. Exit is known from here, never from the reader,
        // which stays blocked until the pseudoconsole is closed.
        let (closing, flag) = (master.clone(), exited.clone());
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code());
            flag.store(true, Ordering::SeqCst);
            drop(closing.lock().unwrap().take());
            // Closing the pseudoconsole normally ends the reader. It does not when another process holds the output
            // pipe: CreatePseudoConsole makes its pipe handles inheritable for a moment, so a process started by any
            // thread at that moment keeps a copy. Then the reader stays blocked until that process ends; send `Exit`
            // after DRAIN anyway and leave the reader to finish on its own.
            let _ = reader_ended.recv_timeout(DRAIN);
            stop.store(true, Ordering::SeqCst);
            let _ = batch_thread.join();
            drop(reader_thread);
            sink(TermEvent::Exit(code));
        });
        Ok(Session { pid, master, writer, killer, exited })
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.writer.lock().unwrap().write_all(data).map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match self.master.lock().unwrap().as_ref() {
            Some(master) => master.resize(size(cols, rows)).map_err(|e| format!("{e:#}")),
            None => Ok(()),
        }
    }

    /// Close the terminal: ask first (console close), kill the tree if that is not enough.
    /// The `Exit` event follows either way.
    pub fn close(&self) {
        drop(self.master.lock().unwrap().take());
        let asked = Instant::now();
        while !self.exited.load(Ordering::SeqCst) && asked.elapsed() < CLOSE_GRACE {
            std::thread::sleep(Duration::from_millis(20));
        }
        if self.exited.load(Ordering::SeqCst) {
            return;
        }
        if let Some(pid) = self.pid {
            let mut command;
            if cfg!(windows) {
                command = Command::new("taskkill");
                command.args(["/PID", &pid.to_string(), "/T", "/F"]);
            } else {
                // The child leads its own session, so its process group id is its pid.
                command = Command::new("kill");
                command.args(["-9", &format!("-{pid}")]);
            }
            let _ = crate::git::run_with_timeout(command, Duration::from_secs(10));
        }
        // portable-pty 0.9.0 reports an error here on Windows when the kill worked; ignore it.
        let _ = self.killer.lock().unwrap().kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Events = Arc<Mutex<Vec<TermEvent>>>;

    fn collect() -> (Events, Sink) {
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let into = events.clone();
        (events, Arc::new(move |event| into.lock().unwrap().push(event)))
    }

    fn shell(line: &str) -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            ("cmd.exe", vec!["/d".into(), "/c".into(), line.into()])
        } else {
            ("sh", vec!["-c".into(), line.into()])
        }
    }

    fn open(line: &str, env: &[(String, String)], env_remove: &[String], sink: Sink) -> Session {
        let (program, args) = shell(line);
        let cwd = std::env::temp_dir();
        Session::open(Spawn { program, args: &args, cwd: &cwd, env, env_remove, cols: 120, rows: 30 }, sink).unwrap()
    }

    fn wait_exit(events: &Events, limit: Duration) -> bool {
        let started = Instant::now();
        let exited = |events: &Events| events.lock().unwrap().iter().any(|e| matches!(e, TermEvent::Exit(_)));
        while !exited(events) && started.elapsed() < limit {
            std::thread::sleep(Duration::from_millis(10));
        }
        exited(events)
    }

    fn joined(events: &Events) -> Vec<u8> {
        let mut bytes = Vec::new();
        for event in events.lock().unwrap().iter() {
            if let TermEvent::Data(data) = event {
                bytes.extend_from_slice(data);
            }
        }
        bytes
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    fn long_wait(seconds: u32) -> String {
        if cfg!(windows) { format!("ping -n {} 127.0.0.1", seconds + 1) } else { format!("sleep {seconds}") }
    }

    #[test]
    fn a_short_program_delivers_its_last_line_then_exits() {
        let (events, sink) = collect();
        let _session = open("echo LAST-LINE-MARKER", &[], &[], sink);
        assert!(wait_exit(&events, Duration::from_secs(10)));
        let bytes = joined(&events);
        assert!(contains(&bytes, "LAST-LINE-MARKER"));
        assert!(!bytes.starts_with(b"\x1b[6n"));
        let events = events.lock().unwrap();
        assert!(matches!(events.last(), Some(TermEvent::Exit(Some(0)))));
        assert_eq!(events.iter().filter(|e| matches!(e, TermEvent::Exit(_))).count(), 1);
    }

    #[test]
    fn quiet_follows_a_burst_once() {
        let (events, sink) = collect();
        let line = if cfg!(windows) { "echo hi & ping -n 5 127.0.0.1 >nul" } else { "echo hi; sleep 4" };
        let _session = open(line, &[], &[], sink);
        assert!(wait_exit(&events, Duration::from_secs(15)));
        let events = events.lock().unwrap();
        let quiets: Vec<usize> = events.iter().enumerate().filter(|(_, e)| matches!(e, TermEvent::Quiet)).map(|(i, _)| i).collect();
        assert_eq!(quiets.len(), 1);
        let first_data = events.iter().position(|e| matches!(e, TermEvent::Data(_))).unwrap();
        let exit = events.iter().position(|e| matches!(e, TermEvent::Exit(_))).unwrap();
        assert!(first_data < quiets[0] && quiets[0] < exit);
    }

    #[test]
    fn close_stops_a_running_program() {
        let (events, sink) = collect();
        let session = open(&long_wait(60), &[], &[], sink);
        std::thread::sleep(Duration::from_millis(500));
        let started = Instant::now();
        session.close();
        assert!(started.elapsed() < Duration::from_secs(6));
        assert!(wait_exit(&events, Duration::from_secs(10)));
        assert!(session.write(b"x").is_err());
        assert!(session.resize(90, 30).is_ok());
    }

    #[test]
    fn resize_is_accepted_while_running() {
        let (events, sink) = collect();
        let session = open(&long_wait(60), &[], &[], sink);
        std::thread::sleep(Duration::from_millis(500));
        assert!(session.resize(100, 40).is_ok());
        session.close();
        assert!(wait_exit(&events, Duration::from_secs(10)));
    }

    #[test]
    fn environment_is_set_and_removed() {
        // SAFETY: only this test reads or writes this variable.
        unsafe { std::env::set_var("HIVEMIND_TERM_TEST", "1") };
        let (events, sink) = collect();
        let line = if cfg!(windows) { "echo %TERM%-%HIVEMIND_TERM_TEST%" } else { "echo $TERM-$HIVEMIND_TERM_TEST" };
        let _session = open(line, &[("TERM".into(), "xterm-256color".into())], &["HIVEMIND_TERM_TEST".into()], sink);
        assert!(wait_exit(&events, Duration::from_secs(10)));
        let bytes = joined(&events);
        assert!(contains(&bytes, "xterm-256color-"));
        assert!(!contains(&bytes, "xterm-256color-1"));
    }
}
