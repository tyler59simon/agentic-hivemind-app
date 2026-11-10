# Spike: a real terminal in Hivemind (PTY in Rust, xterm.js in the webview)

Date: 2026-11-10. Machine: Windows 11 Home 24H2, build 26100 (`cmd.exe` banner: 10.0.26100.9711), inbox `conhost.exe`.

**Result: feasible.** `portable-pty` 0.9.0 ran `powershell.exe`, `cmd.exe`, the `claude` TUI and the `codex` TUI in a ConPTY on this machine. The captured output of both TUIs renders correctly in `@xterm/xterm` 6.0.0 in headless Edge 157 (the engine WebView2 uses). There are a handful of Windows-specific traps; each has a fix below, and the fixes are in the tested `Session` code in section 4.

Statements marked **INFERRED** were not tested here.

## 1. Versions

| Thing | Version | Note |
|---|---|---|
| rustc / cargo | 1.99.1 / 1.99.1 | |
| `portable-pty` | 0.9.0 (published 2025-02-11) | Latest on crates.io. Declares no `rust-version`; built without errors. From the wezterm repo. |
| Claude Code | 2.1.322 | `%USERPROFILE%\.local\bin\claude.exe`, a native exe (346 MB) |
| Codex CLI | 0.166.0 (0.167.0 offered) | npm global install: shims in `%APPDATA%\npm`, native `codex.exe` underneath |
| node / npm | v26.13.0 / 9.3.1 | `C:\Program Files\nodejs\node.exe` |
| Tauri (app's `Cargo.lock`) | 2.12.5 | |
| WebView2 runtime / Edge | 157.0.4341.42 | |
| `@xterm/xterm` | 6.0.0 (published 2025-12-22) | beta tag: 6.1.0-beta.337 |

## 2. Per-program results

All runs: PTY opened at 120x30, resized to 100x40 mid-run, cwd = the scratch git repo `spike-pty\repo`. No prompt was submitted to either agent. "Orphans" = processes from the child's tree (taken with `Get-CimInstance Win32_Process` before shutdown) still alive after it.

| Program | `CommandBuilder` got | Started | Output | Input accepted | Resize | Clean exit | Orphans |
|---|---|---|---|---|---|---|---|
| PowerShell | `powershell.exe -NoLogo` | yes, 17 ms | prompt, `dir`, colours | text + Enter; `café ✓` came back intact; Ctrl+C (`\x03`) stopped `ping -t` and left the shell alive | `$Host.UI.RawUI.WindowSize.Width` printed 100 | `exit` -> code 0 in 31 ms | none |
| cmd | `cmd.exe` | yes, 16 ms | banner, `dir`, `mode con` | yes | yes | `exit` -> code 0 in 4 ms | none |
| cmd + `ping -t` under it | `cmd.exe` | yes | yes | yes | - | closing the pseudoconsole: both gone in 8 ms, code 0xC000013A | none |
| Claude Code | `claude` (found on PATH as `claude.exe`) | yes, 23 ms | trust prompt, then the full TUI (alternate screen) | Down + Enter on the trust prompt; typed text appeared in the input box; Ctrl+C | TUI re-laid out at 100x40 | Ctrl+C twice 300 ms apart -> code 0 after ~950 ms. Closing the pseudoconsole instead -> code 129 after ~960 ms | none |
| Codex | `codex` | **no** | - | - | - | - | - |
| Codex | `codex.cmd` | yes, 36 ms | TUI | - | - | `taskkill /T /F` | none (the tree kill took Codex's daemon with it) |
| Codex | `cmd.exe /d /c codex` | yes, 18 ms | update prompt, hooks prompt, TUI (alternate screen) | Esc on both prompts; typed text appeared; Ctrl+C | yes | Ctrl+C twice (first clears the typed text) -> code 0 in ~200 ms. Closing the pseudoconsole -> whole chain gone in 24 ms | none |
| Codex | `node <npm>\node_modules\@openai\codex\bin\codex.js` | yes, 21 ms | same | same | yes | (run ended by kill, see failures) | none |
| Codex | native `...\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe --no-alt-screen` | yes, 21 ms | trust prompt, hooks prompt, TUI in the normal screen | Enter on trust, Esc on hooks; typed text; Ctrl+C | yes | Ctrl+C twice -> code 0 in ~200 ms | none |

The verbatim failure for the bare name:

```
CreateProcessW `"%USERPROFILE%\\AppData\\Roaming\\npm\\codex\0"` in cwd `Some("...\\spike-pty\\repo\0")` failed: %1 is not a valid Win32 application. (os error 193)
```

### How the executables resolve

- `(Get-Command claude).Source` = `%USERPROFILE%\.local\bin\claude.exe`. A native exe; pass the path (or `claude`) directly. `%USERPROFILE%\.local\bin` is on the *machine* PATH here, so a GUI-launched app sees it. The app's existing `agent::claude::locate` (settings path, then `~\.local\bin\claude.exe`, then PATH) is the right resolver to reuse.
- `Get-Command codex -All` = `codex.ps1`, `codex.cmd`, and an extensionless `codex` (a POSIX shell script), all in `%USERPROFILE%\AppData\Roaming\npm`. `where.exe codex` lists the extensionless file first.
  - `codex.cmd` runs `node "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`; `codex.js` sets `CODEX_MANAGED_PACKAGE_ROOT` and `CODEX_MANAGED_BY_NPM=1` and spawns the native `codex.exe`. Process chain in a PTY: `cmd.exe -> node.exe -> codex.exe`.
  - **Bare `codex` fails** because `portable-pty`'s own PATH search tries the exact name before any PATHEXT extension, finds the shell script, and hands it to `CreateProcessW`.
  - What works: `codex.cmd` (Windows runs it through `cmd.exe` itself), `cmd.exe /d /c codex`, `node.exe` + the script path, or the native exe.
  - Recommended: resolve `codex.cmd` on PATH yourself, then launch `node.exe` with `<dir of codex.cmd>\node_modules\@openai\codex\bin\codex.js` when that file exists (no `cmd.exe` in the chain, arguments are passed as real arguments, the update hint stays correct); otherwise fall back to `cmd.exe /d /c codex`. Run natively, Codex loses the `CODEX_MANAGED_BY_NPM` marker: it showed a passive "Update available" box instead of the interactive update prompt. **INFERRED:** arguments passed through a `.cmd` are re-parsed by `cmd.exe`, so user-supplied arguments containing `& | % "` are unsafe on that path.

### First-run prompts (exact text, as rendered)

Claude Code, in a folder it has not seen:

```
Accessing workspace:
%USERPROFILE%\AppData\Local\Temp\claude\...\scratchpad\spike-pty\repo

Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
project, or work from your team). If not, take a moment to review what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

Security guide

❯ No, exit
  Yes, I trust this folder

Enter to confirm · Esc to cancel
```

The selection starts on **No, exit**. Esc (`\x1b`): exit code 0 after ~320 ms. Accept: Down (`\x1b[B`) then Enter (`\r`). The choice persisted: later runs went straight to the TUI.

Codex showed up to three prompts in a row.

1. When a newer version exists and it was started through the npm shim:
```
Update available · 0.166.0 → 0.167.0
Release notes: https://github.com/openai/codex/releases/latest
› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version
enter continue · esc skip
```
Esc skips it for this run.

2. In an untrusted folder:
```
Folder access
%USERPROFILE%\AppData\Local\Temp\claude\...\scratchpad\spike-pty\repo
Note: You're in a subdirectory of a Git project. Trusting will apply to the repository root:
<SCRATCH>\spike-pty\repo

Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings
can run code automatically, even without a model request. Continue only if you trust these files. Your trust
decision will be saved.

› 1. Trust and continue
  2. Back to Agent Command Center

enter continue · esc back
```
The selection starts on **Trust and continue**; Enter accepts and it persisted. Esc goes back without trusting (the prompt returned on the next run).

3. Because this user has Codex hooks configured:
```
Hooks need review
6 hooks are new or changed.
Hooks can run outside the sandbox after you trust them.
› 1. Review hooks
  2. Trust all and continue
  3. Continue without trusting (hooks won't run)
enter confirm · esc skip
```
Esc skips; it came back on every run. I did not trust the hooks.

### Quitting

- Claude Code: Ctrl+C clears the input and shows "Press Ctrl-C again to exit"; a second Ctrl+C within about a second exits (300 ms apart worked; 1.2 s apart did not).
- Codex: Ctrl+C on an empty input quits at once (~230 ms); with text typed, the first clears it and the second quits. It then prints "Disconnected from this task. Any running work continues. To reconnect, run: codex resume <id>". Ctrl+C twice did not leave the hooks-review dialog.

## 3. What matters to the emulator and the host

### Environment

- `CommandBuilder::new` starts from the app's own environment, so PATH is inherited; `env`/`env_remove` edit that copy.
- Neither CLI complained about anything. `TERM` and `COLORTERM` are not set in a normal Windows environment.
- Set `COLORTERM=truecolor` and `TERM=xterm-256color`. Without them Codex stopped using 24-bit colour (0 truecolour sequences against 21 with them); Claude Code used 24-bit colour either way.
- Remove `NO_COLOR` and every `CLAUDE*` variable if present. They are present when Hivemind itself is started from a Claude Code terminal (as `npm run tauri dev` often is), and the spike removed them for every run. **INFERRED:** left in, they change how a nested `claude` behaves; not tested.

### Modes and sequences seen (what reached the host, after ConPTY)

| | Claude Code 2.1.322 | Codex 0.166.0 | Codex `--no-alt-screen` |
|---|---|---|---|
| Alternate screen `?1049` | yes | yes | no |
| Mouse reporting | `?1000 ?1002 ?1003 ?1006` | `?1003 ?1006` | none |
| Bracketed paste `?2004` | yes | yes | yes |
| Focus events `?1004` | yes | yes | yes |
| Synchronized output `?2026` | no | yes, around every frame | yes |
| Colour-scheme reports `?2031` | yes | no | no |
| Title `OSC 0` | yes ("✳ Claude Code") | yes ("repo") | yes |
| Hyperlinks `OSC 8` | no | yes | yes |
| Cursor shape `CSI 0 SP q` | no | yes | yes |
| Kitty keyboard `CSI > 5 u` / `CSI < u`, `CSI > 4 ; 2 m` | only after the host answered `CSI ? u` | no | no |
| Queries that reached the host | `CSI > 0 q` (XTVERSION), `CSI ? u` (kitty keyboard), `OSC 7501 ; ?`, `CSI 16 t` | none | none |

- **The one query something waits on is ConPTY's own**: the very first bytes of every session are `ESC [ 6 n` (cursor position). Until the host answers, nothing else arrives and typed input is not delivered (gotcha 1).
- Claude Code does not wait on its own queries: with only the cursor query answered it reached the full TUI in the same first second. It only turns on kitty keyboard reporting when `CSI ? u` is answered.
- During replay `@xterm/xterm` 6.0.0 answered `ESC [ 6 n` (with `ESC [ 1 ; 1 R`) and sent focus reports; it did **not** answer XTVERSION, the kitty query, `OSC 7501` or `CSI 16 t`. So with xterm.js 6.0.0 both TUIs run in their plain-keyboard mode.
- ConPTY also turns on `?9001` (win32-input-mode) and `?1004` for itself at start. xterm.js 6.0.0 ignores `?9001` and sends ordinary VT input, which ConPTY translated correctly for everything tried (text, Enter, Esc, Down, Ctrl+C).

### ConPTY behaviour (all measured here)

- **Output is ConPTY's re-rendering, not the program's bytes.** Runs of text arrive split by cursor moves (`Trust ESC[1C this ESC[1C folder?`), so the stream cannot be searched for prompt text reliably. Unknown sequences and `OSC 8` are passed through.
- **Chunking:** many small reads. Idle TUIs: median read 8-24 bytes, largest 1.2-3 KB. A flood (`type` of a 4 MB file) produced 7.8 MB in 39,638 reads, about 11,000 reads a second, median 209 bytes, largest 3,198, about 2.3 MB/s; up to 216 reads inside one 16 ms window.
- **UTF-8:** output is always UTF-8 whatever the console code page (PowerShell reported `IBM437` and `café ✓` still came through as UTF-8). Input is UTF-8. No read ended in the middle of a character in any run, including the flood, but nothing guarantees that: pass bytes, never decode per chunk.
- **Exit is not visible on the reader.** After the child exited, the reader was still blocked 1.5 s later in every run. `child.wait()` on its own thread saw the exit within milliseconds.
- **The reader reaches EOF when the pseudoconsole is closed**, i.e. when the master is dropped (and the slave, which shares it, was dropped after the spawn). `drop(master)` returned in 0 ms every time and the reader ended 0-10 ms later, whether the child had exited, been killed, or was still running. With the child already gone, dropping only the writer also ended the reader; with anything still attached it did not. Dropping the master is the one rule that always worked.
- **Closing the pseudoconsole is also the graceful way to stop a session:** everything attached to it is told to close. `cmd`+`ping` and `cmd -> node -> codex` were gone in 8-24 ms (code 0xC000013A); `claude` shut itself down in ~960 ms (code 129).
- **Killing the direct child does not kill its children.** After `ChildKiller::kill` on `cmd.exe`, `ping`/`node`/`codex` stayed attached until the pseudoconsole was closed; then they went too. `taskkill /PID <pid> /T /F` (what `agent/mod.rs` does) took the whole tree at once.
- **`ChildKiller::kill` and `Child::kill` return `Err("The handle is invalid. (os error 6)")` when the kill succeeded** (the check in `portable-pty` 0.9.0 `src/win/mod.rs` is inverted). Ignore the result on Windows.
- **Final output is not lost** when the master is dropped as soon as the child exits: `cmd /c echo LAST-LINE-MARKER` delivered its line 20 times out of 20.
- **If the host dies without cleanup** (process killed), `conhost`, the shell and its child were all gone within 2 s.
- **Resize:** `master.resize(PtySize { rows, cols, .. })`. ConPTY then repaints the screen and emits `ESC [ 8 ; rows ; cols t`; the TUIs redrew (about 3 KB for Claude Code, 3-8 KB for Codex per resize).

### Output volume

| Scenario | Bytes | Reads | Busiest second |
|---|---|---|---|
| Claude Code: start to idle TUI | 1.7 KB | ~15 | 1.7 KB |
| Claude Code: trust prompt, TUI, typing, one resize, exit | 7.1 KB | 38 | 3.1 KB |
| Codex: prompts, TUI, typing, one resize, exit | 14-20 KB | ~145 | 3-8 KB |
| Flood through `cmd` | 7.8 MB | 39,638 | 2.4 MB |

No agent turn was run, so streaming-answer volume is **not measured**; the flood is the upper bound that was.

## 4. Threading, batching, and the tested shutdown pattern

Three plain threads per session, as `agent/mod.rs` already does with its pump thread:

- **reader**: blocking `read` into a 16 KB buffer, nothing else;
- **batcher**: takes reads from an `mpsc` channel, joins whole reads for up to 8 ms or 64 KB, hands one message on. A read cannot time out, which is why this is a second thread;
- **waiter**: owns the `Child`, calls `wait()`, then drops the master, joins the other two and sends the exit event, so exit is always the last event.

Measured with the code below: the 7.8 MB flood became 519 messages (122 a second, 15 KB average, 20.7 KB largest) instead of 39,638 reads. Idle TUI output is a few messages per redraw either way.

Backpressure: none is needed for these TUIs. **INFERRED:** if the webview cannot keep up with a multi-megabyte flood, messages queue in memory on the Rust side; a cap can be added then. xterm.js's own `write` callback is the hook if flow control is ever wanted.

Harness results on this machine (`target\release\session.exe`):

```
1. short-lived program x20: last line delivered 20/20, exit code 0 and Exit after all Data 20/20
2. flood: 7828426 bytes in 519 messages over 4252 ms (122 messages/s, 15083 bytes/message on average, largest 20710); starts with the cursor query false; valid UTF-8 true; exit Some(Some(0))
3. cmd + ping: resize -> Ok(()); under cmd before close: [PING.EXE(18848)]
   close(): kill needed false; Exit event true (Some(Some(3221225786))) 12 ms after close; ping.exe anywhere under cmd now: []; resize after close -> Ok(()); write after close -> false
4. claude: 4893 bytes in 13 messages (1689 bytes before resize); shows its banner true; starts with the cursor query false; close(): kill needed false; Exit true (Some(Some(129))) 965 ms after close
```

`src\bin\session.rs` (the proposed session without Tauri, plus its harness):

```rust
//! The session shape proposed for the app (open / write / resize / close, batched output, one
//! exit event after the last output), without Tauri, plus a harness that exercises it.
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

/// How long output is gathered before it is handed on as one message.
const BATCH: Duration = Duration::from_millis(8);
/// A batch is handed on early once it is this big.
const BATCH_BYTES: usize = 64 * 1024;
/// How long `close` waits for the program to leave by itself before it is killed.
const CLOSE_GRACE: Duration = Duration::from_secs(3);

pub enum TermEvent {
    Data(Vec<u8>),
    /// Always the last event of a session, after all of its output.
    Exit(Option<u32>),
}

pub type Sink = Arc<dyn Fn(TermEvent) + Send + Sync>;

pub struct Session {
    pid: Option<u32>,
    /// Dropping this closes the pseudoconsole: the reader then reaches EOF, and anything still
    /// attached to the console is told to close.
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    exited: Arc<AtomicBool>,
}

impl Session {
    pub fn open(program: &str, args: &[&str], cwd: &str, env: &[(&str, &str)], cols: u16, rows: u16, sink: Sink) -> Result<Session, String> {
        let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("{e:#}"))?;
        let mut command = CommandBuilder::new(program);
        command.args(args);
        command.cwd(cwd);
        for (key, value) in env {
            command.env(key, value);
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
        let answer = writer.clone();
        let reader_thread = std::thread::spawn(move || {
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
        let batches = sink.clone();
        let batch_thread = std::thread::spawn(move || {
            while let Ok(mut batch) = chunks_rx.recv() {
                let deadline = Instant::now() + BATCH;
                while batch.len() < BATCH_BYTES {
                    match chunks_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(more) => batch.extend_from_slice(&more),
                        Err(_) => break,
                    }
                }
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
            let _ = reader_thread.join();
            let _ = batch_thread.join();
            sink(TermEvent::Exit(code));
        });
        Ok(Session { pid, master, writer, killer, exited })
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        self.writer.lock().unwrap().write_all(data).map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match self.master.lock().unwrap().as_ref() {
            Some(master) => master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| format!("{e:#}")),
            None => Ok(()),
        }
    }

    /// Close the terminal: ask first (console close), kill the tree if that is not enough.
    /// Returns whether the kill was needed. The `Exit` event follows either way.
    pub fn close(&self) -> bool {
        drop(self.master.lock().unwrap().take());
        let asked = Instant::now();
        while !self.exited.load(Ordering::SeqCst) && asked.elapsed() < CLOSE_GRACE {
            std::thread::sleep(Duration::from_millis(20));
        }
        if self.exited.load(Ordering::SeqCst) {
            return false;
        }
        if let (true, Some(pid)) = (cfg!(windows), self.pid) {
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
        }
        // portable-pty 0.9.0 reports an error here on Windows when the kill worked; ignore it.
        let _ = self.killer.lock().unwrap().kill();
        true
    }
}

// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Got {
    messages: usize,
    bytes: Vec<u8>,
    exit: Option<Option<u32>>,
    data_after_exit: usize,
    exit_at: Option<Instant>,
    last_data_at: Option<Instant>,
    largest: usize,
}

fn collect() -> (Arc<Mutex<Got>>, Sink) {
    let got = Arc::new(Mutex::new(Got::default()));
    let into = got.clone();
    let sink: Sink = Arc::new(move |event| {
        let mut got = into.lock().unwrap();
        match event {
            TermEvent::Data(data) if got.exit.is_some() => got.data_after_exit += data.len(),
            TermEvent::Data(data) => {
                got.messages += 1;
                got.largest = got.largest.max(data.len());
                got.last_data_at = Some(Instant::now());
                got.bytes.extend_from_slice(&data);
            }
            TermEvent::Exit(code) => (got.exit, got.exit_at) = (Some(code), Some(Instant::now())),
        }
    });
    (got, sink)
}

fn wait_exit(got: &Arc<Mutex<Got>>, limit: Duration) -> bool {
    let started = Instant::now();
    while got.lock().unwrap().exit.is_none() && started.elapsed() < limit {
        std::thread::sleep(Duration::from_millis(10));
    }
    got.lock().unwrap().exit.is_some()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle.as_bytes())
}

fn alive(names: &[&str], parent: u32) -> String {
    let script = format!("Get-CimInstance Win32_Process | Where-Object {{ $_.ParentProcessId -eq {parent} }} | ForEach-Object {{ \"$($_.Name)($($_.ProcessId))\" }}");
    let out = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    let found: Vec<&str> = out.lines().map(str::trim).filter(|line| names.iter().any(|name| line.to_ascii_lowercase().starts_with(name))).collect();
    format!("[{}]", found.join(", "))
}

fn main() {
    // The harness is started from inside a Claude Code session; the app would not be.
    for (key, _) in std::env::vars() {
        if key.starts_with("CLAUDE") || ["NO_COLOR", "WT_SESSION", "WT_PROFILE_ID"].contains(&key.as_str()) {
            // SAFETY: nothing else is running yet.
            unsafe { std::env::remove_var(&key) };
        }
    }
    let args: Vec<String> = std::env::args().collect();
    let (cwd, repo) = (args[1].as_str(), args[2].as_str());
    let env = [("TERM", "xterm-256color"), ("COLORTERM", "truecolor")];

    // 1. A program that prints and exits at once: is its last line delivered, and is Exit last?
    let (mut delivered, mut ordered) = (0, 0);
    for _ in 0..20 {
        let (got, sink) = collect();
        let _session = Session::open("cmd.exe", &["/d", "/c", "echo LAST-LINE-MARKER"], cwd, &env, 120, 30, sink).unwrap();
        wait_exit(&got, Duration::from_secs(10));
        let got = got.lock().unwrap();
        delivered += contains(&got.bytes, "LAST-LINE-MARKER") as usize;
        ordered += (got.exit == Some(Some(0)) && got.data_after_exit == 0) as usize;
    }
    println!("1. short-lived program x20: last line delivered {delivered}/20, exit code 0 and Exit after all Data {ordered}/20");

    // 2. A flood: how many messages does batching make of it?
    let (got, sink) = collect();
    let session = Session::open("cmd.exe", &[], cwd, &env, 120, 30, sink).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    let started = Instant::now();
    session.write(b"chcp 65001 >nul & type big-utf8.txt & echo FLOOD-DONE-MARKER\r").unwrap();
    // Done when a lot has arrived and nothing more has for half a second.
    let finished = |got: &Got| got.bytes.len() > 1_000_000 && got.last_data_at.is_some_and(|at| at.elapsed() > Duration::from_millis(500));
    let before = got.lock().unwrap().messages;
    while !finished(&got.lock().unwrap()) && started.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let (took, messages) = {
        let got = got.lock().unwrap();
        (got.last_data_at.unwrap().duration_since(started), got.messages - before)
    };
    session.write(b"exit\r").unwrap();
    wait_exit(&got, Duration::from_secs(5));
    {
        let got = got.lock().unwrap();
        println!(
            "2. flood: {} bytes in {messages} messages over {} ms ({} messages/s, {} bytes/message on average, largest {}); starts with the cursor query {}; valid UTF-8 {}; exit {:?}",
            got.bytes.len(),
            took.as_millis(),
            messages as u128 * 1000 / took.as_millis().max(1),
            got.bytes.len() / messages.max(1),
            got.largest,
            got.bytes.starts_with(b"\x1b[6n"),
            std::str::from_utf8(&got.bytes).is_ok(),
            got.exit
        );
    }

    // 3. A shell with something running under it: resize, then close.
    let (got, sink) = collect();
    let session = Session::open("cmd.exe", &[], cwd, &env, 120, 30, sink).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    session.write(b"ping -t 127.0.0.1\r").unwrap();
    std::thread::sleep(Duration::from_millis(1500));
    println!("3. cmd + ping: resize -> {:?}; under cmd before close: {}", session.resize(100, 40), alive(&["ping"], session.pid.unwrap()));
    let closing = Instant::now();
    let killed = session.close();
    let exited = wait_exit(&got, Duration::from_secs(10));
    std::thread::sleep(Duration::from_millis(500));
    let (exit, exit_at) = {
        let got = got.lock().unwrap();
        (got.exit, got.exit_at)
    };
    println!(
        "   close(): kill needed {killed}; Exit event {exited} ({exit:?}) {} ms after close; ping.exe anywhere under cmd now: {}; resize after close -> {:?}; write after close -> {:?}",
        exit_at.map_or(0, |at| at.duration_since(closing).as_millis()),
        alive(&["ping"], session.pid.unwrap()),
        session.resize(90, 30),
        session.write(b"x").is_ok()
    );

    // 4. claude: start, resize, close without typing anything.
    let (got, sink) = collect();
    let session = Session::open("claude", &[], repo, &env, 120, 30, sink).unwrap();
    std::thread::sleep(Duration::from_secs(6));
    let before = got.lock().unwrap().bytes.len();
    session.resize(100, 40).unwrap();
    std::thread::sleep(Duration::from_secs(2));
    let closing = Instant::now();
    let killed = session.close();
    let exited = wait_exit(&got, Duration::from_secs(10));
    let got = got.lock().unwrap();
    println!(
        "4. claude: {} bytes in {} messages ({} bytes before resize); shows its banner {}; starts with the cursor query {}; close(): kill needed {killed}; Exit {exited} ({:?}) {} ms after close",
        got.bytes.len(),
        got.messages,
        before,
        contains(&got.bytes, "Claude"),
        got.bytes.starts_with(b"\x1b[6n"),
        got.exit,
        got.exit_at.map_or(0, |at| at.duration_since(closing).as_millis())
    );
}
```

## 5. Gotchas, each with its fix

1. **Nothing appears and input is ignored until the host answers `ESC [ 6 n`.** `portable-pty` opens ConPTY with `PSEUDOCONSOLE_INHERIT_CURSOR`, and it cannot be turned off. With no answer a PowerShell session showed 4 bytes in 11 s. Fix: in the reader, if the first read starts with `ESC [ 6 n`, write `ESC [ 1 ; 1 R` back and strip those four bytes (done in `Session::open`). Answering in Rust means a session does not depend on the terminal view being mounted; stripping stops xterm.js answering a second time.
2. **The reader blocks forever after the child exits.** Fix: detect exit with `child.wait()` on its own thread, then drop the master; drop the slave right after `spawn_command`. Order that worked every time: wait returns -> drop master -> reader gets EOF -> join reader and batcher -> send exit.
3. **`kill()` reports failure when it succeeded.** Fix: ignore its result on Windows.
4. **Killing the child leaves its children.** Fix: close the pseudoconsole first (graceful, reaches everything attached); only if the child is still alive after a grace period (3 s in the code; Claude Code needed about 1 s) run `taskkill /PID <pid> /T /F`, as `agent::kill` does.
5. **`codex` by bare name fails with os error 193.** Fix: resolve it yourself (section 2).
6. **The stream cannot be parsed for text.** Fix: do not try to detect prompts or state from PTY output; the terminal is for the person.
7. **A flood is ~11,000 tiny reads a second.** Fix: batch whole reads for 8-16 ms.
8. **Bytes, not strings.** Fix: send raw bytes to the webview and give xterm.js a `Uint8Array`; it decodes UTF-8 across writes itself.
9. **Codex keeps a background daemon.** The first Codex run started `codex.exe app-server --listen unix:// --managed-daemon` plus a `pid-update-loop` helper from `~\.codex\packages\app-server-daemon`. They are not attached to the console: they survived a clean quit and a pseudoconsole close, and later runs reused them. A tree kill took them down when they were still under the first run's tree. Fix: use the graceful close as the normal path, so a tab closing behaves like any other terminal closing. **INFERRED:** a `taskkill /T` (or a kill-on-close job object) on the tab that happened to start the daemon would cut off other Codex tabs using it; not tested. Also: quitting the Codex TUI does not stop a running turn ("Any running work continues").
10. **Both TUIs turn mouse reporting on** (Codex not with `--no-alt-screen`). In xterm.js that means a plain drag goes to the program; selecting text needs Shift+drag (**INFERRED** from xterm.js behaviour, not exercised).
11. **Shift+Enter cannot be told from Enter** with xterm.js 6.0.0, which has neither win32-input-mode nor the kitty keyboard protocol (both exist only in 6.1.0-beta, behind `vtExtensions`; checked in the beta package's typings). Fix (**INFERRED**, not tested): a custom key handler that sends `ESC CR` for Shift+Enter.
12. **Startup prompts differ per user and per run** (trust, update, hooks review). Fix: nothing to automate; show the terminal and let the person answer. Do not pre-answer trust prompts.
13. **Resize repaints everything.** Fix: debounce the fit (50-100 ms).
14. **The session outlives the webview's channel.** A page reload (dev HMR) drops the channel while the process keeps running. Fix (**INFERRED**): on `Channel::send` error stop forwarding but keep the session; offer `term_attach(id, channel)` and follow it with a resize to make ConPTY repaint. Simplest first version: close sessions whose channel is gone.
15. **Commands that can block must not be plain `fn` commands**, which run on the main thread. `term_close` can wait 3 s and `term_write` can block on a full pipe. Fix: `async fn` + the existing `blocking(...)` helper in `lib.rs`.

## 6. `portable-pty` build, and the plugin alternative

- Clean release build of the spike: **12.6 s**, 27 crates locked (among them `winapi`, `filedescriptor`, `shared_library`, `shell-words`, `anyhow`, `serial2`, `nix`, `libc`). No C compiler, no system libraries.
- It looks for `conpty.dll` + `OpenConsole.exe` next to the exe and prefers them over the inbox ConPTY (seen in `src/win/psuedocon.rs`; not tried).
- **`tauri-plugin-pty` 0.3.1** (crates.io 2026-07-08, by Tnze; npm side is `tauri-pty` 0.3.1, 28 KB; about 54,000 crate downloads in total): 237 lines over the same `portable-pty` 0.9.0. Not worth adopting:
  - output is pulled: the page calls a `read` command in a loop, 4 KB per call, each a blocking read inside an async command;
  - `kill` passes on `portable-pty`'s inverted result, so on Windows a successful kill is reported to JavaScript as an error; no tree kill, no close-on-app-exit;
  - it keeps the slave alive for the whole session and has no handling for the cursor query (it relies on the page answering);
  - the page chooses the program, arguments and environment, the opposite of how `lib.rs` treats agent sessions.

## 7. Frontend facts

### Packages (`npm view`)

| Package | Version | Unpacked | Minified ESM file | Needed? |
|---|---|---|---|---|
| `@xterm/xterm` | 6.0.0 | 5.9 MB (mostly source maps) | `xterm.mjs` 345 KB + `xterm.css` 7 KB | yes |
| `@xterm/addon-fit` | 0.11.0 | 21 KB | 2 KB | yes |
| `@xterm/addon-webgl` | 0.19.0 | 2.4 MB | 127 KB | optional: only if the DOM renderer proves slow |
| `@xterm/addon-web-links` | 0.12.0 | 47 KB | 3 KB | optional: plain-text URLs. Codex's `OSC 8` links work without it via `linkHandler` |
| `@xterm/addon-unicode11` | 0.9.0 | 551 KB | 31 KB | recommended: both TUIs draw with box, braille and emoji characters |

### CSS and CSP

- Under Vite: `import '@xterm/xterm/css/xterm.css'` next to `import { Terminal } from '@xterm/xterm'`. The package has no `exports` map, so the deep path resolves.
- xterm.js creates `<style>` elements at run time (three places in 6.0.0) and sets inline styles. That needs `'unsafe-inline'` in `style-src`, which the app's policy already has.
- Neither `xterm.mjs` nor `addon-webgl.mjs` contains `new Worker`, `blob:`, `createObjectURL`, `eval(` or `new Function`. **No CSP change is needed** for xterm.js or the WebGL addon.
- Checked: `replay.html` carries the app's policy (plus `font-src 'self' data:`, adapted for `file:`) and listens for `securitypolicyviolation`; none fired with the DOM renderer or the WebGL addon.
- The data path needs `connect-src ipc: http://ipc.localhost`, already present: channel messages of 1 KB or more are fetched over the IPC protocol.
- No capability change: the app's own commands and channels are covered by `core:default`.

### The data path in Tauri 2

- Tauri docs (https://v2.tauri.app/develop/calling-frontend/): "The event system is not designed for low latency or high throughput situations", "event payloads are always JSON strings making them not suitable for bigger messages", and "Channels are designed to be fast and deliver ordered data. They are used internally for streaming operations such as download progress, child process output and WebSocket messages."
- https://v2.tauri.app/develop/calling-rust/ calls channels "the recommended mechanism for streaming data".
- Encoding, from the `Channel` documentation in tauri 2.12.5 (`src/ipc/channel.rs`): "Any `serde::Serialize` value is sent as JSON. To stream binary data without the JSON overhead, send an `InvokeResponseBody::Raw` through a `Channel<InvokeResponseBody>` ... the payload is then received in JavaScript as an `ArrayBuffer`. Note that a `Channel<Vec<u8>>` does *not* do this - `Vec<u8>` is `Serialize`, so it is sent as a JSON array of numbers."
- So: **`Channel<InvokeResponseBody>` and `channel.send(InvokeResponseBody::Raw(batch))`**; in the page `term.write(new Uint8Array(message))`. No base64, no number arrays. Order is guaranteed by the channel. Raw messages under 1,024 bytes are delivered inline, larger ones through an IPC fetch.
- Exit and the session list are small and rare: ordinary `emit` events, like `agent-event` today.
- Input: `invoke('term_write', { id, data })` with the string from `term.onData` (and `term.onBinary` wired the same way).
- Resize: `ResizeObserver` on the container -> debounced `fitAddon.fit()` -> `term.onResize(({ cols, rows }) => invoke('term_resize', { id, cols, rows }))`. Skip `fit()` while the tab is hidden.

Not verified: this path inside the real app. The spike did not build a Tauri window.

### xterm.js in WebView2

Verified in headless Edge 157 by replaying the captured logs (screenshots in `spike-pty\web\shots`):

- Claude Code's trust prompt and TUI, Codex's TUI in both modes, and PowerShell render correctly with the DOM renderer, including the logo blocks, box drawing, 24-bit colour, underlined hyperlinks and the title.
- After the mid-log resize the 100x40 frames land correctly.
- The WebGL addon loaded and rendered in headless Edge (software GL).
- Terminal state after replay matched the capture: alternate buffer and mouse tracking "any" for Claude Code and Codex, normal buffer and no mouse tracking for `--no-alt-screen`, bracketed paste and focus events on.

**INFERRED**, from how xterm.js works, not exercised here:

- Renderer: start with the DOM renderer (the default). Add WebGL only if needed, and handle `onContextLoss` by disposing the addon.
- Fonts: xterm.js measures the cell when it opens. With a bundled web font such as JetBrains Mono Variable, wait for `document.fonts.load('13px "JetBrains Mono Variable"')` before `term.open()`, or re-set `fontFamily` and call `fit()` after it loads (and `clearTextureAtlas()` with WebGL). `font-src 'self' data:` covers a font Vite bundles.
- Set `windowsPty: { backend: 'conpty', buildNumber: <Windows build> }` on Windows; the option exists in 6.0.0.
- Ctrl+C: xterm.js sends `\x03`. For copy, use `attachCustomKeyEventHandler`: when `term.hasSelection()`, copy and return false; otherwise let it through.
- Ctrl+V: xterm.js sends `\x16` rather than pasting. Handle it in the same handler: read the clipboard and call `term.paste(text)`, which applies bracketed paste. Reading the clipboard from page script may prompt in WebView2; Tauri's clipboard plugin avoids that.
- IME: handled by xterm.js's hidden textarea; nothing to add.
- Focus: call `term.focus()` when a tab becomes active.
- Links: pass `linkHandler` (for `OSC 8`) and the web-links addon's handler through the existing opener plugin instead of `window.open`.

## 8. Recommended architecture

A `terminal` module beside `agent`, same shape: a cloneable `Manager` around `Arc<Inner>`, sessions in a `Mutex<HashMap<String, ...>>`, plain threads, a sink closure built in `setup`, `stop_all` on `RunEvent::Exit`.

```rust
// src-tauri/src/terminal/mod.rs
pub enum Kind { Claude, Codex, Shell }            // the webview names a kind, never a program

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSpec { pub kind: Kind, pub cwd: String, pub cols: u16, pub rows: u16 }

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo { pub id: String, pub kind: Kind, pub cwd: String, pub title: String, pub started_at: u64, pub exit_code: Option<u32>, pub running: bool }

pub enum Emit { Exit { id: String, code: Option<u32> }, SessionsChanged }
pub type Sink = Arc<dyn Fn(Emit) + Send + Sync>;

struct Inner { sink: Sink, sessions: Mutex<HashMap<String, Entry>> }
struct Entry { info: TermInfo, session: Arc<Session> }   // Session as in section 4
#[derive(Clone)] pub struct Manager { inner: Arc<Inner> }

impl Manager {
    pub fn new(sink: Sink) -> Manager;
    /// Works out program, arguments and environment for `spec.kind`, then starts the session.
    pub fn open(&self, spec: OpenSpec, saved: &Settings, output: Channel<InvokeResponseBody>) -> Result<TermInfo, String>;
    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String>;
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String>;
    pub fn close(&self, id: &str) -> Result<(), String>;   // graceful, then tree kill
    pub fn sessions(&self) -> Vec<TermInfo>;
    pub fn stop_all(&self);
}
```

- The session's sink maps `TermEvent::Data(batch)` to `output.send(InvokeResponseBody::Raw(batch))` and `TermEvent::Exit(code)` to `Emit::Exit` + `Emit::SessionsChanged`.
- Program per kind, decided in Rust: Claude through `agent::claude::available`; Codex as in section 2; Shell = `powershell.exe -NoLogo` on Windows, `$SHELL -l` elsewhere. Environment: inherited, plus `TERM=xterm-256color`, `COLORTERM=truecolor`, minus `NO_COLOR` and `CLAUDE*`. `cwd` should be checked against the folders the app knows, as agent sessions are scoped.

```rust
// src-tauri/src/lib.rs
struct AppState { /* ... */ terminals: terminal::Manager }

#[tauri::command]
async fn term_open(state: State<'_, AppState>, spec: terminal::OpenSpec, output: Channel<InvokeResponseBody>) -> Result<terminal::TermInfo, String> {
    let (terminals, path) = (state.terminals.clone(), state.settings_path.clone());
    blocking(move || terminals.open(spec, &settings::load(&path), output)).await
}
#[tauri::command]
async fn term_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let terminals = state.terminals.clone();
    blocking(move || terminals.write(&id, data.as_bytes())).await
}
#[tauri::command]
async fn term_resize(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> { /* same shape */ }
#[tauri::command]
async fn term_close(state: State<'_, AppState>, id: String) -> Result<(), String> { /* same shape */ }
#[tauri::command]
fn term_sessions(state: State<'_, AppState>) -> Vec<terminal::TermInfo> { state.terminals.sessions() }
```

Events: `term-exit` `{ id, code }` and `term-sessions-changed`, emitted from the sink like `agent-event`. In `run`, next to `state.agents.stop_all()`: `state.terminals.stop_all()`. `Cargo.toml`: add `portable-pty = "0.9"`.

```ts
// one terminal tab
const term = new Terminal({ fontFamily, fontSize: 13, scrollback: 5000, allowProposedApi: true,
                            windowsPty: isWindows ? { backend: 'conpty', buildNumber } : undefined });
const fit = new FitAddon(); term.loadAddon(fit);
term.open(container); fit.fit();
const output = new Channel<ArrayBuffer>();
output.onmessage = (bytes) => term.write(new Uint8Array(bytes));
const info = await invoke<TermInfo>('term_open', { spec: { kind, cwd, cols: term.cols, rows: term.rows }, output });
term.onData((data) => invoke('term_write', { id: info.id, data }));
term.onBinary((data) => invoke('term_write', { id: info.id, data }));
term.onResize(({ cols, rows }) => invoke('term_resize', { id: info.id, cols, rows }));
new ResizeObserver(debounce(() => container.offsetParent && fit.fit(), 80)).observe(container);
// on tab close: await invoke('term_close', { id: info.id }); term.dispose();
```

macOS and Linux (**INFERRED**, nothing run): the same `Session` code compiles against `portable-pty`'s Unix side; there is no cursor query to answer (the code only does it on Windows); the reader ends once the child exits and the slave is dropped; `close` should signal the process group rather than `taskkill`. A GUI-launched app on macOS does not get the login shell's PATH, so `claude` and `codex` need resolving through a login shell or known install paths.

## 9. Verified / not verified / failed

| Item | Status |
|---|---|
| `portable-pty` 0.9.0 builds on this machine (12.6 s clean) | Verified |
| PowerShell and cmd in a PTY: output, input, UTF-8, Ctrl+C, resize, exit code | Verified |
| `claude` TUI starts, takes keys, resizes, quits cleanly, no orphans | Verified |
| `codex` TUI starts (4 of 5 launch forms), takes keys, resizes, quits cleanly, with and without `--no-alt-screen` | Verified |
| Trust prompts: text, default, accept and decline keys (both CLIs) | Verified |
| Cursor query blocks all output until answered; answering from Rust fixes it | Verified |
| Reader does not end on child exit; ends when the master is dropped | Verified |
| Closing the pseudoconsole stops the whole attached tree | Verified (cmd+ping, claude, cmd->node->codex) |
| `Session` code: batching, exit after last output, close | Verified (harness output in section 4) |
| Host process killed: children do not survive | Verified (cmd+ping) |
| Captured Claude Code and Codex output renders in xterm.js 6.0.0, DOM and WebGL, under the app's CSP | Verified in headless Edge 157, not in a Tauri window |
| Raw channel encoding (`InvokeResponseBody::Raw` -> `ArrayBuffer`) | Read in tauri 2.12.5 source and docs; **not run** |
| The whole path inside Hivemind (Tauri command, channel, xterm.js mounted in React) | Not verified |
| Keyboard in a real webview: IME, Ctrl+C/Ctrl+V, Shift+Enter, mouse selection, focus | Not verified |
| JetBrains Mono Variable loading and cell measurement; WebGL on a real GPU | Not verified |
| Output volume while an agent is answering | Not verified (no prompt was submitted) |
| Two Codex tabs sharing the daemon when one is tree-killed | Not verified |
| A nested `claude` with `CLAUDE*` variables left in the environment | Not verified |
| macOS and Linux | Not verified |
| `run.ps1` modes `claude`, `codex`, `session`, `replay` | Not run through the script (`shells` was; the same commands were run by hand) |
| Bare `codex` as the program | Failed: os error 193 |
| `ChildKiller::kill` result on Windows | Failed: returns an error although the process is killed |
| Session with the cursor query unanswered | Failed: 4 bytes of output in 11 s, `exit` not delivered |
| Claude Code: second Ctrl+C 1.2 s after the first | Failed to exit (window had passed); 300 ms worked |
| Codex: Ctrl+C twice while the hooks-review dialog was open | Failed to exit; the run was ended by kill |
| Cleaning up Codex's daemon after the spike | Not done: the harness refused the kill; two daemon processes are still running |
| Fetching the xterm.js 6.0.0 release notes | Failed (fetch limit); xterm.js facts come from the installed package itself |

## 10. How to re-run

Everything is in `<SCRATCH>\spike-pty`:

- `Cargo.toml`, `src\main.rs` (the scripted probe), `src\bin\session.rs` (the proposed session + harness)
- `repo\` scratch git repo used as cwd for the agents; `big-utf8.txt` flood input
- `logs\*.bin` raw captures (a = PowerShell, b = cmd, c = Claude Code, d = Codex, e = flood, f = close while running, g = without TERM, h = host killed)
- `strip.py LOG` (rough plain text) and `dump.py LOG` (escapes visible)
- `web\replay.html` (`?log=c3-claude&stop=3410&renderer=webgl`), `web\replay.js`, `web\make-logs.py`, `web\shots\*.png`
- `review-tauri-plugin-pty\` and `review-xterm-beta\` (downloaded sources that were only read)
- `run.ps1`

```powershell
cd <that folder>
powershell -ExecutionPolicy Bypass -File run.ps1 shells    # PowerShell, cmd, cmd+ping close
powershell -ExecutionPolicy Bypass -File run.ps1 claude    # starts claude in .\repo, types, resizes, Ctrl+C twice
powershell -ExecutionPolicy Bypass -File run.ps1 codex     # both screen modes; Esc on update and hooks prompts
powershell -ExecutionPolicy Bypass -File run.ps1 session   # the section 4 harness (starts claude once)
powershell -ExecutionPolicy Bypass -File run.ps1 replay    # rebuild web\logs.js and screenshot the replay
```

One probe by hand:

```powershell
.\target\release\spike-pty.exe --name demo --reply --cwd .\repo --log .\logs\demo.bin --unset-prefix CLAUDE --unset NO_COLOR `
  --env TERM=xterm-256color --env COLORTERM=truecolor --step '7000:snap' --step '0:write:\x03' --step '300:write:\x03' --step '0:waitexit:8000' -- claude
```

`--cpr-only` answers only ConPTY's cursor query; leaving out both `--reply` and `--cpr-only` shows the blocked start.

## Appendix: the probe

`Cargo.toml`:

```toml
[package]
name = "spike-pty"
version = "0.1.0"
edition = "2024"

[dependencies]
portable-pty = "0.9.0"
```

`src\main.rs`:

```rust
//! PTY feasibility spike: run a program in a pseudo terminal, log its raw output, feed it input
//! on a timeline, resize it, then shut it down and report what was left running.
//!
//! spike-pty --name N --cwd DIR --log FILE [--env K=V]... [--unset K]... [--unset-prefix P]...
//!           [--reply | --cpr-only] [--master-first] [--step MS:KIND[:ARG]]... -- PROGRAM [ARGS...]
//!
//! Steps run in order, each after sleeping MS milliseconds:
//!   write:TEXT     send bytes (escapes: \r \n \t \e \\ \xNN)
//!   waitfor:TEXT   wait up to 20 s for TEXT to appear in the output after the previous match
//!   writeif:TEXT   like write, but only when the last waitfor matched
//!   resize:CxR     resize the PTY
//!   snap           print the child's process tree
//!   waitexit:MS    wait up to MS for the child to exit by itself
//!   kill           ChildKiller::kill (TerminateProcess on the direct child)
//!   taskkill       taskkill /PID <child> /T /F
//!   dropwriter     close the input pipe while the child may still be running
//!   dropmaster     close the pseudoconsole while the child may still be running
//!   mark:TEXT      print a marker with the byte count so far
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::process::Command;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn unescape(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let (mut out, mut i) = (Vec::new(), 0);
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            match bytes[i] {
                b'r' => out.push(b'\r'),
                b'n' => out.push(b'\n'),
                b't' => out.push(b'\t'),
                b'e' => out.push(0x1b),
                b'x' if i + 2 < bytes.len() => {
                    out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap_or(b'?'));
                    i += 2;
                }
                other => out.push(other),
            }
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    out
}

fn escape(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| match b {
            0x1b => "\\e".to_string(),
            b'\r' => "\\r".to_string(),
            b'\n' => "\\n".to_string(),
            0x20..=0x7e => (b as char).to_string(),
            other => format!("\\x{other:02x}"),
        })
        .collect()
}

/// (pid, parent pid, name) of every process, from the same source the task asks for.
fn processes() -> Vec<(u32, u32, String)> {
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.Name)\" }"])
        .output();
    let Ok(out) = out else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.trim().splitn(3, ',');
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.to_string()))
        })
        .collect()
}

/// `root` and everything below it, as (pid, name).
fn tree(all: &[(u32, u32, String)], root: u32) -> Vec<(u32, String)> {
    let mut found: Vec<(u32, String)> = all.iter().filter(|p| p.0 == root).map(|p| (p.0, p.2.clone())).collect();
    let mut seen: BTreeSet<u32> = [root].into();
    let mut grew = true;
    while grew {
        grew = false;
        for (pid, parent, name) in all {
            if seen.contains(parent) && !seen.contains(pid) {
                seen.insert(*pid);
                found.push((*pid, name.clone()));
                grew = true;
            }
        }
    }
    found
}

fn show(label: &str, list: &[(u32, String)]) {
    let text: Vec<String> = list.iter().map(|(pid, name)| format!("{name}({pid})")).collect();
    println!("  {label}: [{}]", text.join(", "));
}

/// What an emulator would have to do with this output: modes switched, queries asked, OSC used.
#[derive(Default)]
struct Seen {
    modes_set: BTreeMap<String, usize>,
    modes_reset: BTreeMap<String, usize>,
    queries: BTreeMap<String, usize>,
    osc: BTreeMap<String, usize>,
    other: BTreeMap<String, usize>,
}

fn bump(map: &mut BTreeMap<String, usize>, key: String) {
    *map.entry(key).or_default() += 1;
}

/// Walk the escape sequences in `data`. Returns the replies a real terminal would send.
fn scan(data: &[u8], seen: &mut Seen) -> Vec<u8> {
    let mut replies = Vec::new();
    let mut i = 0;
    while i < data.len() {
        if data[i] != 0x1b || i + 1 >= data.len() {
            i += 1;
            continue;
        }
        match data[i + 1] {
            b'[' => {
                let start = i + 2;
                let mut end = start;
                while end < data.len() && !(0x40..=0x7e).contains(&data[end]) {
                    end += 1;
                }
                if end >= data.len() {
                    break;
                }
                let params = String::from_utf8_lossy(&data[start..end]).to_string();
                let fin = data[end] as char;
                match (fin, params.as_str()) {
                    ('h', p) if p.starts_with('?') => p[1..].split(';').for_each(|m| bump(&mut seen.modes_set, format!("?{m}"))),
                    ('l', p) if p.starts_with('?') => p[1..].split(';').for_each(|m| bump(&mut seen.modes_reset, format!("?{m}"))),
                    ('c', "" | "0") => {
                        bump(&mut seen.queries, "DA1 CSI c".into());
                        replies.extend_from_slice(b"\x1b[?1;2c");
                    }
                    ('c', p) if p.starts_with('>') => {
                        bump(&mut seen.queries, "DA2 CSI > c".into());
                        replies.extend_from_slice(b"\x1b[>0;276;0c");
                    }
                    ('n', "6") => {
                        bump(&mut seen.queries, "CPR CSI 6n".into());
                        replies.extend_from_slice(b"\x1b[1;1R");
                    }
                    ('n', "5") => {
                        bump(&mut seen.queries, "DSR CSI 5n".into());
                        replies.extend_from_slice(b"\x1b[0n");
                    }
                    ('u', "?") => {
                        bump(&mut seen.queries, "kitty keyboard CSI ? u".into());
                        replies.extend_from_slice(b"\x1b[?0u");
                    }
                    ('u', p) if p.starts_with('>') || p.starts_with('<') || p.starts_with('=') => bump(&mut seen.other, format!("kitty keyboard CSI {p} u")),
                    ('q', p) if p.starts_with('>') => {
                        bump(&mut seen.queries, "XTVERSION CSI > q".into());
                        replies.extend_from_slice(b"\x1bP>|xterm.js(6.0.0)\x1b\\");
                    }
                    ('p', p) if p.ends_with('$') => {
                        bump(&mut seen.queries, format!("DECRQM CSI {p}p"));
                        let mode = p.trim_end_matches('$');
                        replies.extend_from_slice(format!("\x1b[{mode};2$y").as_bytes());
                    }
                    ('t', p) if matches!(p, "14" | "16" | "18" | "19") => {
                        bump(&mut seen.queries, format!("window report CSI {p}t"));
                    }
                    ('t', p) => bump(&mut seen.other, format!("window op CSI {p}t")),
                    ('m', p) if p.starts_with('>') => bump(&mut seen.other, format!("modifyOtherKeys CSI {p}m")),
                    ('q', p) if p.ends_with(' ') => bump(&mut seen.other, format!("cursor style CSI {p}q")),
                    ('r', _) => bump(&mut seen.other, "scroll region CSI r".into()),
                    _ => {}
                }
                i = end + 1;
            }
            b']' => {
                let start = i + 2;
                let mut end = start;
                while end < data.len() && data[end] != 0x07 && !(data[end] == 0x1b && data.get(end + 1) == Some(&b'\\')) {
                    end += 1;
                }
                let body = String::from_utf8_lossy(&data[start..end.min(data.len())]).to_string();
                let code = body.split(';').next().unwrap_or("").to_string();
                if body.ends_with(";?") || body.contains(";?;") {
                    bump(&mut seen.queries, format!("OSC {code} query"));
                    if code == "10" {
                        replies.extend_from_slice(b"\x1b]10;rgb:d0d0/d0d0/d0d0\x1b\\");
                    } else if code == "11" {
                        replies.extend_from_slice(b"\x1b]11;rgb:1010/1010/1010\x1b\\");
                    }
                } else {
                    bump(&mut seen.osc, format!("OSC {code}"));
                }
                i = end + 1;
            }
            b'P' => {
                bump(&mut seen.other, "DCS".into());
                i += 2;
            }
            b'7' | b'8' | b'=' | b'>' | b'M' => {
                bump(&mut seen.other, format!("ESC {}", data[i + 1] as char));
                i += 2;
            }
            _ => i += 2,
        }
    }
    replies
}

fn print_map(label: &str, map: &BTreeMap<String, usize>) {
    let text: Vec<String> = map.iter().map(|(key, count)| format!("{key} x{count}")).collect();
    println!("  {label}: {}", if text.is_empty() { "-".into() } else { text.join(", ") });
}

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mut name, mut cwd, mut log) = (String::from("run"), String::from("."), String::from("out.log"));
    let (mut env, mut unset, mut unset_prefix, mut steps) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut reply, mut cpr_only, mut master_first, mut program) = (false, false, false, Vec::new());
    let mut i = 0;
    while i < args.len() {
        let value = || args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--name" => name = value(),
            "--cwd" => cwd = value(),
            "--log" => log = value(),
            "--env" => env.push(value()),
            "--unset" => unset.push(value()),
            "--unset-prefix" => unset_prefix.push(value()),
            "--step" => steps.push(value()),
            "--reply" => {
                reply = true;
                i += 1;
                continue;
            }
            "--cpr-only" => {
                (reply, cpr_only) = (true, true);
                i += 1;
                continue;
            }
            "--master-first" => {
                master_first = true;
                i += 1;
                continue;
            }
            "--" => {
                program = args[i + 1..].to_vec();
                break;
            }
            other => return Err(format!("unknown argument {other}").into()),
        }
        i += 2;
    }
    if program.is_empty() {
        return Err("no program given after --".into());
    }
    println!("=== {name} ===");
    println!("  spawn: {program:?} in {cwd} (reply to queries: {reply})");

    let started = Instant::now();
    let pair = native_pty_system().openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })?;
    let mut command = CommandBuilder::new(&program[0]);
    command.args(&program[1..]);
    command.cwd(&cwd);
    // CommandBuilder::new starts from this process's environment; the rest is edits to that.
    let inherited: Vec<String> = std::env::vars().map(|(key, _)| key).collect();
    for key in &inherited {
        if unset.iter().any(|u| u.eq_ignore_ascii_case(key)) || unset_prefix.iter().any(|p| key.to_ascii_uppercase().starts_with(&p.to_ascii_uppercase())) {
            command.env_remove(key);
        }
    }
    for pair in &env {
        if let Some((key, value)) = pair.split_once('=') {
            command.env(key, value);
        }
    }
    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => {
            println!("  SPAWN FAILED: {error:#}");
            return Ok(());
        }
    };
    // The slave is only needed to spawn. On Windows it shares the pseudoconsole with the master,
    // so keeping it would keep the console (and the reader) open after the master is dropped.
    drop(pair.slave);
    let mut master = Some(pair.master);
    let pid = child.process_id().unwrap_or(0);
    println!("  spawned pid {pid} after {} ms", started.elapsed().as_millis());

    let mut reader = master.as_ref().unwrap().try_clone_reader()?;
    let writer = Arc::new(Mutex::new(Some(master.as_ref().unwrap().take_writer()?)));
    let mut killer = child.clone_killer();

    // Reader thread: blocking reads, raw bytes to the log, chunk sizes and times to the main thread.
    let (chunks_tx, chunks_rx) = mpsc::channel::<(u128, Vec<u8>)>();
    let (log_path, reply_writer) = (log.clone(), writer.clone());
    let reader_thread = std::thread::spawn(move || {
        let mut file = std::fs::File::create(&log_path).expect("log file");
        let mut seen = Seen::default();
        let mut buffer = [0u8; 65536];
        let (mut all, mut split_utf8) = (Vec::new(), 0usize);
        let end = loop {
            match reader.read(&mut buffer) {
                Ok(0) => break "EOF (read returned 0)".to_string(),
                Ok(n) => {
                    let _ = file.write_all(&buffer[..n]);
                    // Sequences split across reads are missed here; good enough for a census.
                    let mut replies = scan(&buffer[..n], &mut seen);
                    if cpr_only {
                        // The least a host must do: ConPTY itself asks for the cursor position at start.
                        replies = if buffer[..n].windows(4).any(|w| w == b"\x1b[6n") { b"\x1b[1;1R".to_vec() } else { Vec::new() };
                    }
                    if reply && !replies.is_empty() {
                        if let Some(writer) = reply_writer.lock().unwrap().as_mut() {
                            let _ = writer.write_all(&replies);
                            let _ = writer.flush();
                        }
                    }
                    if std::str::from_utf8(&buffer[..n]).is_err() {
                        split_utf8 += 1;
                    }
                    all.extend_from_slice(&buffer[..n]);
                    let _ = chunks_tx.send((started.elapsed().as_millis(), buffer[..n].to_vec()));
                }
                Err(error) => break format!("error: {error}"),
            }
        };
        (end, started.elapsed().as_millis(), seen, all, split_utf8)
    });

    // Waiter thread: the only owner of `child`, so exit is noticed whatever the reader is doing.
    let (exit_tx, exit_rx) = mpsc::channel::<(u128, String)>();
    std::thread::spawn(move || {
        let status = child.wait();
        let _ = exit_tx.send((started.elapsed().as_millis(), format!("{status:?}")));
    });

    let mut exited: Option<(u128, String)> = None;
    let mut before: Vec<(u32, String)> = Vec::new();
    // Everything read so far, for `waitfor`; `searched` is how far earlier waits have looked.
    let (mut output, mut searched, mut found) = (Vec::<u8>::new(), 0usize, false);
    let bytes_so_far = |rx: &mpsc::Receiver<(u128, Vec<u8>)>, stats: &mut Vec<(u128, usize)>, output: &mut Vec<u8>| {
        while let Ok((at, chunk)) = rx.try_recv() {
            stats.push((at, chunk.len()));
            output.extend_from_slice(&chunk);
        }
        stats.iter().map(|(_, n)| n).sum::<usize>()
    };
    let mut stats: Vec<(u128, usize)> = Vec::new();
    for step in &steps {
        let mut parts = step.splitn(3, ':');
        let delay: u64 = parts.next().unwrap_or("0").parse().unwrap_or(0);
        let (kind, arg) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        std::thread::sleep(Duration::from_millis(delay));
        if exited.is_none() {
            exited = exit_rx.try_recv().ok();
        }
        let at = started.elapsed().as_millis();
        let total = bytes_so_far(&chunks_rx, &mut stats, &mut output);
        match kind {
            "waitfor" => {
                let waiting = Instant::now();
                found = false;
                while !found && waiting.elapsed() < Duration::from_secs(20) {
                    bytes_so_far(&chunks_rx, &mut stats, &mut output);
                    if let Some(at) = output[searched..].windows(arg.len()).position(|w| w == arg.as_bytes()) {
                        (found, searched) = (true, searched + at + arg.len());
                    } else {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                }
                println!("  [{} ms, {} B out] waitfor {arg:?} -> {found}", started.elapsed().as_millis(), output.len());
            }
            "writeif" if !found => println!("  [{at} ms, {total} B out] writeif skipped (last waitfor did not match)"),
            "write" | "writeif" => {
                let bytes = unescape(arg);
                let result = match writer.lock().unwrap().as_mut() {
                    Some(writer) => writer.write_all(&bytes).and_then(|_| writer.flush()).map_err(|e| e.to_string()),
                    None => Err("writer already dropped".into()),
                };
                println!("  [{at} ms, {total} B out] write {:?} -> {result:?}", escape(&bytes));
            }
            "resize" => {
                let (cols, rows) = arg.split_once('x').unwrap_or(("100", "40"));
                let size = PtySize { rows: rows.parse()?, cols: cols.parse()?, pixel_width: 0, pixel_height: 0 };
                let master = master.as_ref().ok_or("master already dropped")?;
                let result = master.resize(size).map_err(|e| e.to_string());
                println!("  [{at} ms, {total} B out] resize {cols}x{rows} -> {result:?}, get_size now {:?}", master.get_size().map(|s| (s.cols, s.rows)).ok());
            }
            "snap" => {
                before = tree(&processes(), pid);
                println!("  [{at} ms, {total} B out] snapshot");
                show("child tree", &before);
                show("spike tree", &tree(&processes(), std::process::id()));
            }
            "waitexit" => {
                if exited.is_none() {
                    exited = exit_rx.recv_timeout(Duration::from_millis(arg.parse().unwrap_or(3000))).ok();
                }
                println!("  [{at} ms, {total} B out] waitexit -> {exited:?}");
            }
            "kill" => println!("  [{at} ms, {total} B out] ChildKiller::kill -> {:?}", killer.kill().map_err(|e| e.to_string())),
            "taskkill" => {
                let out = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output()?;
                println!("  [{at} ms, {total} B out] taskkill /T /F -> {} {}", String::from_utf8_lossy(&out.stdout).trim().replace("\r\n", " | "), String::from_utf8_lossy(&out.stderr).trim());
            }
            "dropmaster" => {
                let dropping = Instant::now();
                drop(master.take());
                println!("  [{at} ms, {total} B out] dropped the master (ClosePseudoConsole) in {} ms", dropping.elapsed().as_millis());
            }
            "dropwriter" => {
                drop(writer.lock().unwrap().take());
                println!("  [{at} ms, {total} B out] dropped the writer (input pipe closed)");
            }
            "mark" => println!("  [{at} ms, {total} B out] {arg}"),
            other => println!("  unknown step {other}"),
        }
    }

    // ---- Teardown, timed stage by stage ----
    println!("  -- teardown --");
    if exited.is_none() {
        exited = exit_rx.recv_timeout(Duration::from_millis(1500)).ok();
    }
    println!("  child exit seen by wait(): {exited:?}");
    if exited.is_none() {
        println!("  child still running; ChildKiller::kill -> {:?}", killer.kill().map_err(|e| e.to_string()));
        exited = exit_rx.recv_timeout(Duration::from_millis(3000)).ok();
        println!("  child exit after kill: {exited:?}");
    }
    // Does the reader see EOF just because the child is gone?
    std::thread::sleep(Duration::from_millis(1500));
    println!("  reader finished 1.5 s after child exit, master still open: {}", reader_thread.is_finished());
    let at = started.elapsed().as_millis();
    if master_first {
        let dropping = Instant::now();
        drop(master.take());
        println!("  drop(master) returned after {} ms (started at {at} ms)", dropping.elapsed().as_millis());
        std::thread::sleep(Duration::from_millis(300));
        println!("  reader finished after dropping the master, writer still open: {}", reader_thread.is_finished());
        drop(writer.lock().unwrap().take());
    } else {
        drop(writer.lock().unwrap().take());
        std::thread::sleep(Duration::from_millis(300));
        println!("  reader finished after dropping the writer, master still open: {}", reader_thread.is_finished());
        let dropping = Instant::now();
        drop(master.take());
        println!("  drop(master) returned after {} ms (started at {at} ms)", dropping.elapsed().as_millis());
    }
    let waiting = Instant::now();
    while !reader_thread.is_finished() && waiting.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    if !reader_thread.is_finished() {
        println!("  READER STILL BLOCKED 5 s after both were dropped");
        std::process::exit(2);
    }
    let (end, end_at, seen, all, split_utf8) = reader_thread.join().map_err(|_| "reader panicked")?;
    println!("  reader ended {} ms after both were dropped: {end} at {end_at} ms", waiting.elapsed().as_millis());

    let total = bytes_so_far(&chunks_rx, &mut stats, &mut output);
    let after = processes();
    let alive: HashMap<u32, &str> = after.iter().map(|p| (p.0, p.2.as_str())).collect();
    let orphans: Vec<(u32, String)> = before.iter().filter(|(pid, name)| alive.get(pid) == Some(&name.as_str())).cloned().collect();
    show("child tree before teardown", &before);
    show("ORPHANS still alive", &orphans);
    show("spike tree now", &tree(&after, std::process::id()));

    // ---- Output summary ----
    let sizes: Vec<usize> = stats.iter().map(|(_, n)| *n).collect();
    let mut per_window: BTreeMap<u128, (usize, usize)> = BTreeMap::new();
    for (at, n) in &stats {
        let slot = per_window.entry(at / 16).or_default();
        slot.0 += n;
        slot.1 += 1;
    }
    let mut per_second: BTreeMap<u128, usize> = BTreeMap::new();
    for (at, n) in &stats {
        *per_second.entry(at / 1000).or_default() += n;
    }
    println!("  -- output --");
    println!("  total {total} bytes in {} reads; largest read {}; median read {}", sizes.len(), sizes.iter().max().unwrap_or(&0), {
        let mut sorted = sizes.clone();
        sorted.sort();
        sorted.get(sorted.len() / 2).copied().unwrap_or(0)
    });
    println!("  first output at {:?} ms", stats.first().map(|s| s.0));
    println!(
        "  16 ms windows with output: {}; busiest window {} bytes / {} reads; busiest second {} bytes",
        per_window.len(),
        per_window.values().map(|w| w.0).max().unwrap_or(0),
        per_window.values().map(|w| w.1).max().unwrap_or(0),
        per_second.values().max().unwrap_or(&0)
    );
    println!("  bytes per second: {:?}", per_second.iter().map(|(s, n)| format!("{s}s:{n}")).collect::<Vec<_>>());
    println!("  valid UTF-8 overall: {}; reads that were not valid UTF-8 on their own (a character split across reads): {split_utf8}", std::str::from_utf8(&all).is_ok());
    println!("  first 400 bytes: {}", escape(&all[..all.len().min(400)]));
    print_map("modes set (CSI ? h)", &seen.modes_set);
    print_map("modes reset (CSI ? l)", &seen.modes_reset);
    print_map("queries", &seen.queries);
    print_map("OSC", &seen.osc);
    print_map("other", &seen.other);
    println!("  log: {log}");
    Ok(())
}
```

Both source files above are also on disk at `<SCRATCH>\spike-pty\src\main.rs` and `<SCRATCH>\spike-pty\src\bin\session.rs`, so the file copy is the authority if the inline text and disk ever differ.

Living Memory capture proposal (for the main agent to decide; I wrote nothing): one `research` note, "Hivemind embedded terminal: PTY spike result", covering the decision-relevant facts: `portable-pty` 0.9.0 works on Windows 11 24H2; answer and strip ConPTY's `ESC[6n` in Rust; exit via `child.wait()` then drop master; close the pseudoconsole as the graceful stop; `kill()` result is inverted; bare `codex` fails, use `node codex.js` or `cmd /d /c codex`; Codex keeps a detached daemon; use `Channel<InvokeResponseBody>` raw; no CSP change for xterm.js 6.0.0.