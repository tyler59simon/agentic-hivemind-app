//! The large file viewer (NS-6B): files over 64 MB, binary files and the hex view. A viewer is a handle, held in Rust,
//! on one file. It never loads the file: a sparse line index (the byte offset of every 1024th line) is built on a
//! background thread, and lines, searches and bytes are read from the file on demand through that index.
//!
//! The file is opened with read, write and delete sharing, so a program that writes a log, rotates it or deletes it is
//! never blocked by the viewer. Following (`tail -f`) is a 500 ms poll of the file at its path: growth is indexed, and a
//! file that was truncated or replaced is indexed again from its start.
use crate::files::encoding;
use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Every this many lines the index keeps the byte offset of the line's start.
const MARK_EVERY: u64 = 1024;
/// Bytes read at a time while indexing, and while reading lines.
const SCAN_CHUNK: usize = 4 * 1024 * 1024;
const LINE_CHUNK: usize = 1024 * 1024;
/// Bytes of a line shown; the rest of a longer line is cut (`Line::cut`). Search sees up to `SEARCH_LINE` bytes of a line.
const DISPLAY_LINE: usize = 32 * 1024;
const SEARCH_LINE: usize = 1024 * 1024;
/// Bytes read to decide the encoding.
const SNIFF: usize = 256 * 1024;
/// Bytes of the file's start that tell a replaced file from the one that was being followed.
const FINGERPRINT: usize = 4096;
/// The window of one search of bytes (and the most one `bigfile_bytes` call returns).
pub const BYTE_CHUNK: usize = 4 * 1024 * 1024;
pub const MAX_BYTES: u64 = 64 * 1024;
const MAX_LINES: u64 = 500;
const POLL: Duration = Duration::from_millis(500);
const PROGRESS_EVERY: Duration = Duration::from_millis(100);
const MAX_VIEWERS: usize = 32;

/// How the file's bytes are read: its encoding, where the text starts (after a byte order mark) and whether the bytes are
/// really text.
#[derive(Clone, Copy)]
struct Format {
    encoding: &'static Encoding,
    base: u64,
    bom: bool,
    binary: bool,
}

impl Format {
    /// `Some(big_endian)` for UTF-16, whose line breaks are two bytes.
    fn utf16(&self) -> Option<bool> {
        (self.encoding == UTF_16BE).then_some(true).or_else(|| (self.encoding == UTF_16LE).then_some(false))
    }

    fn unit(&self) -> usize {
        if self.utf16().is_some() { 2 } else { 1 }
    }
}

/// The format of a file from its first bytes. `size` is the whole file's size, so a head cut in the middle of a
/// character is not mistaken for invalid UTF-8.
fn detect(head: &[u8], size: u64) -> Format {
    let mut head = head;
    if size > head.len() as u64
        && let Err(e) = std::str::from_utf8(head)
        && e.error_len().is_none()
    {
        head = &head[..e.valid_up_to()];
    }
    let bom_len = Encoding::for_bom(head).map(|(_, len)| len).unwrap_or(0);
    // UTF-16 text without a byte order mark is told first, on an even number of bytes.
    let even = encoding::decode(&head[..head.len() & !1]);
    let d = if even.encoding.starts_with("UTF-16") { even } else { encoding::decode(head) };
    let found = Encoding::for_label(d.encoding.as_bytes()).unwrap_or(UTF_8);
    // A binary file is shown as UTF-8 text with its control bytes replaced.
    let encoding = if d.binary { UTF_8 } else { found };
    Format { encoding, base: if d.bom { bom_len as u64 } else { 0 }, bom: d.bom, binary: d.binary }
}

/// Where the file's line breaks are in `chunk`: the index of the first byte of the next break at or after `from`.
fn find_nl(chunk: &[u8], from: usize, utf16: Option<bool>) -> Option<usize> {
    match utf16 {
        None => chunk[from..].iter().position(|b| *b == b'\n').map(|i| i + from),
        Some(big) => {
            let (lo, hi) = if big { (0u8, b'\n') } else { (b'\n', 0u8) };
            (from..chunk.len().saturating_sub(1)).step_by(2).find(|i| chunk[*i] == lo && chunk[i + 1] == hi)
        }
    }
}

fn count_nl(chunk: &[u8], utf16: Option<bool>) -> u64 {
    match utf16 {
        None => chunk.iter().filter(|b| **b == b'\n').count() as u64,
        Some(big) => {
            let (lo, hi) = if big { (0u8, b'\n') } else { (b'\n', 0u8) };
            chunk.as_chunks::<2>().0.iter().filter(|p| p[0] == lo && p[1] == hi).count() as u64
        }
    }
}

/// The index of the first byte after the last line break in `chunk`.
fn after_last_nl(chunk: &[u8], utf16: Option<bool>) -> Option<usize> {
    match utf16 {
        None => chunk.iter().rposition(|b| *b == b'\n').map(|i| i + 1),
        Some(big) => {
            let (lo, hi) = if big { (0u8, b'\n') } else { (b'\n', 0u8) };
            chunk.as_chunks::<2>().0.iter().rposition(|p| p[0] == lo && p[1] == hi).map(|i| i * 2 + 2)
        }
    }
}

#[cfg(windows)]
fn open_shared(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE};
    // Other programs may write, rename and delete the file while the viewer holds it.
    std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).open(path)
}

#[cfg(not(windows))]
fn open_shared(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

/// One read at `offset` that does not move any cursor, so threads share one handle.
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    #[cfg(windows)]
    {
        std::os::windows::fs::FileExt::seek_read(file, buf, offset)
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::FileExt::read_at(file, buf, offset)
    }
}

/// Up to `len` bytes from `offset` (fewer at the end of the file).
fn read_range(file: &File, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    let mut out = vec![0u8; len];
    let mut filled = 0;
    while filled < len {
        let n = read_at(file, &mut out[filled..], offset + filled as u64)?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    out.truncate(filled);
    Ok(out)
}

/// What the index knows. Line `n` starts at `marks[n / 1024]` plus the lines between.
struct Index {
    marks: Vec<u64>,
    /// Line breaks seen so far.
    newlines: u64,
    /// Bytes indexed: the file is known up to here.
    scanned: u64,
    /// Where the line after the last break starts.
    last_start: u64,
    /// The file's size as last seen.
    size: u64,
    done: bool,
}

impl Index {
    fn new(base: u64, size: u64) -> Self {
        Index { marks: vec![base], newlines: 0, scanned: base, last_start: base, size, done: false }
    }

    /// Lines known: every break, plus the text after the last one.
    fn lines(&self) -> u64 {
        self.newlines + u64::from(self.scanned > self.last_start)
    }
}

/// A line as read: its bytes (cut at the limit asked for) and whether it was cut.
struct RawLine {
    bytes: Vec<u8>,
    cut: bool,
}

/// Reads lines one after the other from `pos` to `end`, a window at a time. A line longer than `max_line` bytes is cut
/// and its rest skipped, so no line can make a window larger than the limit.
struct LineReader<'a> {
    file: &'a File,
    fmt: Format,
    buf: Vec<u8>,
    /// File offset of `buf[0]`.
    buf_off: u64,
    at: usize,
    end: u64,
    max_line: usize,
}

impl<'a> LineReader<'a> {
    fn new(file: &'a File, fmt: Format, pos: u64, end: u64, max_line: usize) -> Self {
        LineReader { file, fmt, buf: Vec::new(), buf_off: pos, at: 0, end, max_line }
    }

    /// Read more after what is buffered; false at the end.
    fn refill(&mut self) -> bool {
        self.buf.drain(..self.at);
        self.buf_off += self.at as u64;
        self.at = 0;
        let from = self.buf_off + self.buf.len() as u64;
        if from >= self.end {
            return false;
        }
        let mut want = LINE_CHUNK.min((self.end - from) as usize);
        if self.fmt.unit() == 2 {
            want &= !1;
        }
        match read_range(self.file, from, want) {
            Ok(more) if !more.is_empty() => {
                self.buf.extend_from_slice(&more);
                true
            }
            _ => false,
        }
    }

    fn next(&mut self) -> Option<RawLine> {
        let unit = self.fmt.unit();
        let start = self.buf_off + self.at as u64;
        let mut head: Vec<u8> = Vec::new();
        let mut cut = false;
        let keep = |head: &mut Vec<u8>, cut: &mut bool, part: &[u8], max: usize| {
            let room = max.saturating_sub(head.len());
            if part.len() > room {
                *cut = true;
            }
            head.extend_from_slice(&part[..part.len().min(room)]);
        };
        loop {
            match find_nl(&self.buf, self.at, self.fmt.utf16()) {
                Some(nl) => {
                    keep(&mut head, &mut cut, &self.buf[self.at..nl], self.max_line);
                    self.at = nl + unit;
                    return Some(RawLine { bytes: head, cut });
                }
                None => {
                    // An odd byte left in UTF-16 waits for the byte that completes it.
                    let usable = self.buf.len() - (self.buf.len() - self.at) % unit;
                    keep(&mut head, &mut cut, &self.buf[self.at..usable], self.max_line);
                    self.at = usable;
                    if !self.refill() {
                        return (self.buf_off + self.at as u64 > start).then_some(RawLine { bytes: head, cut });
                    }
                }
            }
        }
    }
}

/// Decode a line for the webview: no trailing carriage return; for a binary file, control bytes shown as a dot.
fn text_of(line: &[u8], fmt: Format) -> String {
    let (text, _) = fmt.encoding.decode_without_bom_handling(line);
    let text = text.strip_suffix('\r').unwrap_or(&text);
    if fmt.binary { text.chars().map(|c| if c.is_control() && c != '\t' { '\u{b7}' } else { c }).collect() } else { text.to_string() }
}

/// One line of the file. `number` counts from 0.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Line {
    pub number: u64,
    pub text: String,
    /// The line is longer than what is shown.
    pub cut: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Lines {
    pub first: u64,
    pub lines: Vec<Line>,
    /// Lines the index knows so far (all of them once `indexed`).
    pub total: u64,
    pub indexed: bool,
    pub size: u64,
}

/// A match: its line, and its start and end in UTF-16 units of the text shown for that line.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Hit {
    pub line: u64,
    pub start: u64,
    pub end: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub hit: Option<Hit>,
    /// The search ran past the end (or the start) and went on from the other end.
    pub wrapped: bool,
    /// A newer search took this one's place.
    pub cancelled: bool,
}

/// What the viewer tells the webview as it indexes and follows.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub handle: String,
    pub scanned: u64,
    pub size: u64,
    pub lines: u64,
    pub done: bool,
    /// The file was truncated or replaced and indexed again.
    pub reset: bool,
}

pub type Emit = Arc<dyn Fn(&'static str, Progress) + Send + Sync>;
/// The file this viewer is on, resolved again each time it is needed, through the same containment as when it opened.
pub type Resolve = Arc<dyn Fn() -> Result<PathBuf, String> + Send + Sync>;

pub struct Viewer {
    pub handle: String,
    owner: String,
    file: Mutex<Arc<File>>,
    fmt: Format,
    index: Mutex<Index>,
    /// The first bytes of the file, to tell a replaced file from the same one.
    head: Mutex<Vec<u8>>,
    created: Mutex<Option<std::time::SystemTime>>,
    resolve: Resolve,
    emit: Emit,
    closed: AtomicBool,
    /// The number of the newest search; an older one stops.
    searches: AtomicU64,
}

impl Viewer {
    /// Open the file `resolve` names and start indexing it. The first lines can be read at once.
    pub fn open(handle: String, owner: String, resolve: Resolve, emit: Emit) -> Result<Arc<Viewer>, String> {
        let path = resolve()?;
        let meta = std::fs::metadata(&path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
        if !meta.is_file() {
            return Err(format!("{} is not a file", path.display()));
        }
        let file = open_shared(&path).map_err(|e| format!("Could not open {}: {e}", path.display()))?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(meta.len());
        let sniffed = read_range(&file, 0, SNIFF).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
        let fmt = detect(&sniffed, size);
        let viewer = Arc::new(Viewer {
            handle,
            owner,
            file: Mutex::new(Arc::new(file)),
            fmt,
            index: Mutex::new(Index::new(fmt.base, size)),
            head: Mutex::new(sniffed[..sniffed.len().min(FINGERPRINT)].to_vec()),
            created: Mutex::new(meta.created().ok()),
            resolve,
            emit,
            closed: AtomicBool::new(false),
            searches: AtomicU64::new(0),
        });
        let work = viewer.clone();
        std::thread::spawn(move || work.run());
        Ok(viewer)
    }

    fn file(&self) -> Arc<File> {
        self.file.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.searches.fetch_add(1, Ordering::Relaxed);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn send(&self, name: &'static str, reset: bool) {
        let idx = self.lock();
        (self.emit)(name, Progress { handle: self.handle.clone(), scanned: idx.scanned, size: idx.size, lines: idx.lines(), done: idx.done, reset });
    }

    /// Index the file, then follow it until the viewer closes.
    fn run(self: Arc<Self>) {
        self.scan();
        while !self.is_closed() {
            // Sleeping in short steps lets a closed viewer stop at once.
            let until = Instant::now() + POLL;
            while Instant::now() < until && !self.is_closed() {
                std::thread::sleep(Duration::from_millis(25));
            }
            if !self.is_closed() {
                self.poll();
            }
        }
    }

    /// Index from where the index stopped to the end of the file.
    fn scan(&self) {
        let file = self.file();
        let utf16 = self.fmt.utf16();
        let mut chunk = vec![0u8; SCAN_CHUNK];
        let mut told = Instant::now();
        loop {
            if self.is_closed() {
                return;
            }
            let pos = self.lock().scanned;
            let size = file.metadata().map(|m| m.len()).unwrap_or(0);
            if pos >= size {
                let mut idx = self.lock();
                idx.size = size.max(idx.scanned);
                idx.done = true;
                drop(idx);
                self.send("bigfile-progress", false);
                return;
            }
            let want = SCAN_CHUNK.min((size - pos) as usize) & if utf16.is_some() { !1 } else { !0 };
            let n = if want == 0 { 0 } else { read_at(&file, &mut chunk[..want], pos).unwrap_or(0) };
            let n = if utf16.is_some() { n & !1 } else { n };
            if n == 0 {
                // A single odd byte at the end of a UTF-16 file, or a read that failed: nothing more to index.
                let mut idx = self.lock();
                idx.size = size;
                idx.done = true;
                drop(idx);
                self.send("bigfile-progress", false);
                return;
            }
            let mut idx = self.lock();
            idx.size = size;
            let chunk = &chunk[..n];
            let mut from = 0usize;
            loop {
                let rest = &chunk[from..];
                let threshold = idx.marks.len() as u64 * MARK_EVERY;
                let need = threshold - idx.newlines;
                if count_nl(rest, utf16) < need {
                    let here = count_nl(rest, utf16);
                    if here > 0 {
                        idx.newlines += here;
                        idx.last_start = pos + (from + after_last_nl(rest, utf16).unwrap_or(0)) as u64;
                    }
                    break;
                }
                // The break that makes the next mark: find it, and go on after it.
                let mut at = from;
                for _ in 0..need {
                    at = find_nl(chunk, at, utf16).unwrap_or(chunk.len().saturating_sub(1)) + self.fmt.unit();
                }
                idx.newlines = threshold;
                idx.last_start = pos + at as u64;
                idx.marks.push(pos + at as u64);
                from = at;
            }
            idx.scanned = pos + n as u64;
            drop(idx);
            if told.elapsed() >= PROGRESS_EVERY {
                told = Instant::now();
                self.send("bigfile-progress", false);
            }
        }
    }

    /// The 500 ms check: the file at the path grew, was truncated or was replaced.
    fn poll(&self) {
        let Ok(path) = (self.resolve)() else { return };
        let Ok(probe) = open_shared(&path) else { return };
        let Ok(meta) = probe.metadata() else { return };
        let len = meta.len();
        let created = meta.created().ok();
        let stored = self.head.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let head = read_range(&probe, 0, FINGERPRINT).unwrap_or_default();
        let scanned = self.lock().scanned;
        let same_start = head.len() >= stored.len() && head[..stored.len()] == stored[..];
        let same_file = created == *self.created.lock().unwrap_or_else(|e| e.into_inner());
        if !same_file || !same_start || len < scanned {
            // Truncated or replaced (rotated): index the file at the path again from its start.
            *self.file.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(probe);
            *self.head.lock().unwrap_or_else(|e| e.into_inner()) = head;
            *self.created.lock().unwrap_or_else(|e| e.into_inner()) = created;
            *self.lock() = Index::new(self.fmt.base, len);
            self.scan();
            self.send("bigfile-grew", true);
        } else if len > scanned {
            if stored.len() < FINGERPRINT {
                *self.head.lock().unwrap_or_else(|e| e.into_inner()) = head;
            }
            *self.file.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(probe);
            self.lock().done = false;
            self.scan();
            self.send("bigfile-grew", false);
        }
    }

    pub fn encoding_name(&self) -> String {
        encoding::shown(self.fmt.encoding.name())
    }

    pub fn bom(&self) -> bool {
        self.fmt.bom
    }

    pub fn binary(&self) -> bool {
        self.fmt.binary
    }

    pub fn size(&self) -> u64 {
        self.lock().size
    }

    pub fn line_count(&self) -> u64 {
        self.lock().lines()
    }

    /// Where reading line `first` starts (the nearest mark) and how many lines to skip to reach it, and the end to read to.
    fn position(&self, first: u64) -> Option<(u64, u64, u64)> {
        let idx = self.lock();
        let block = (first / MARK_EVERY) as usize;
        let mark = *idx.marks.get(block)?;
        Some((mark, first - block as u64 * MARK_EVERY, idx.size.max(idx.scanned)))
    }

    /// The raw lines `first` to `first + count`, as many as the file has.
    fn read_raw(&self, first: u64, count: u64, max_line: usize) -> Vec<(u64, RawLine)> {
        let Some((from, skip, end)) = self.position(first) else { return Vec::new() };
        let file = self.file();
        let mut reader = LineReader::new(&file, self.fmt, from, end, max_line);
        let mut out = Vec::new();
        let mut number = first - skip;
        while let Some(line) = reader.next() {
            if number >= first {
                out.push((number, line));
                if out.len() as u64 >= count {
                    break;
                }
            }
            number += 1;
        }
        out
    }

    /// Lines `first` to `first + count` for the webview. A request past what is indexed gives no lines.
    pub fn lines(&self, first: u64, count: u64) -> Lines {
        let lines = self.read_raw(first, count.min(MAX_LINES), DISPLAY_LINE)
            .into_iter()
            .map(|(number, raw)| Line { number, text: text_of(&raw.bytes, self.fmt), cut: raw.cut })
            .collect::<Vec<_>>();
        let idx = self.lock();
        // What was read counts even before the index reaches it (the first window of a file still being indexed).
        let total = idx.lines().max(lines.last().map_or(0, |l| l.number + 1));
        Lines { first, lines, total, indexed: idx.done, size: idx.size }
    }

    /// Bytes for the hex view.
    pub fn bytes(&self, offset: u64, len: u64) -> Result<Vec<u8>, String> {
        let len = len.min(MAX_BYTES) as usize;
        read_range(&self.file(), offset, len).map_err(|e| format!("Could not read the file: {e}"))
    }

    fn stale(&self, mine: u64) -> bool {
        self.searches.load(Ordering::Relaxed) != mine || self.is_closed()
    }

    /// The first match at or after `(line, col)`, wrapping to the start; or, backwards, the last match before it, wrapping to
    /// the end. `col` counts UTF-16 units of the line as shown. A pattern is a regular expression; a newer search stops this one.
    pub fn search(&self, re: &regex::Regex, line: u64, col: u64, forward: bool) -> Found {
        let mine = self.searches.fetch_add(1, Ordering::Relaxed) + 1;
        let total = self.line_count();
        let done = |hit, wrapped, cancelled| Found { hit, wrapped, cancelled };
        if total == 0 {
            return done(None, false, false);
        }
        let line = line.min(total - 1);
        let first = if forward { self.forward_until(re, line, col, total - 1, mine) } else { self.backward(re, line, Some(col), 0, mine) };
        match first {
            Err(_) => return done(None, false, true),
            Ok(Some(hit)) => return done(Some(hit), false, false),
            Ok(None) => {}
        }
        // Nothing in the first direction: go on from the other end, the starting line included (for what lies on the other
        // side of `col`).
        let again = if forward { self.forward_until(re, 0, 0, line, mine) } else { self.backward(re, total - 1, None, line, mine) };
        match again {
            Ok(hit) => done(hit, true, false),
            Err(_) => done(None, true, true),
        }
    }

    /// Lines `from_line` to `last` (inclusive), the first match at or after `col` on `from_line` and any on the others.
    /// `Err(true)` when a newer search took over.
    fn forward_until(&self, re: &regex::Regex, from_line: u64, col: u64, last: u64, mine: u64) -> Result<Option<Hit>, bool> {
        let Some((from, skip, end)) = self.position(from_line) else { return Ok(None) };
        let file = self.file();
        let mut reader = LineReader::new(&file, self.fmt, from, end, SEARCH_LINE);
        let mut number = from_line - skip;
        while let Some(raw) = reader.next() {
            if number >= from_line {
                if number > last {
                    return Ok(None);
                }
                if number.is_multiple_of(256) && self.stale(mine) {
                    return Err(true);
                }
                let text = text_of(&raw.bytes, self.fmt);
                if let Some((start, end)) = first_match(re, &text, if number == from_line { col } else { 0 }) {
                    return Ok(Some(Hit { line: number, start, end }));
                }
            }
            number += 1;
        }
        Ok(None)
    }

    /// Lines from `from_line` down to `to_line` (inclusive), the last match before `col` on `from_line` (any, with `None`) and
    /// the last match on the others. Reads a block of 1024 lines at a time, upwards.
    fn backward(&self, re: &regex::Regex, from_line: u64, col: Option<u64>, to_line: u64, mine: u64) -> Result<Option<Hit>, bool> {
        let mut hi = from_line;
        loop {
            if self.stale(mine) {
                return Err(true);
            }
            let block_start = hi / MARK_EVERY * MARK_EVERY;
            let lines = self.read_raw(block_start, hi - block_start + 1, SEARCH_LINE);
            for (number, raw) in lines.iter().rev() {
                if *number < to_line {
                    return Ok(None);
                }
                let text = text_of(&raw.bytes, self.fmt);
                let before = if *number == from_line { col } else { None };
                if let Some((start, end)) = last_match(re, &text, before) {
                    return Ok(Some(Hit { line: *number, start, end }));
                }
            }
            if block_start == 0 || block_start <= to_line {
                return Ok(None);
            }
            hi = block_start - 1;
        }
    }

    /// The first place the bytes `needle` start at or after `offset` (before it, backwards), wrapping once.
    pub fn find_bytes(&self, needle: &[u8], offset: u64, forward: bool) -> Result<(Option<u64>, bool), String> {
        if needle.is_empty() {
            return Err("Type the bytes to look for".into());
        }
        let file = self.file();
        let size = file.metadata().map_err(|e| format!("Could not read the file: {e}"))?.len();
        let offset = offset.min(size);
        let range = |lo: u64, hi: u64| if forward { scan_forward(&file, needle, lo, hi) } else { scan_backward(&file, needle, lo, hi) };
        let first = if forward { range(offset, size)? } else { range(0, offset.saturating_add(needle.len() as u64 - 1).min(size))?.filter(|at| *at < offset) };
        if first.is_some() {
            return Ok((first, false));
        }
        let again = if forward { range(0, (offset + needle.len() as u64 - 1).min(size))?.filter(|at| *at < offset) } else { range(offset, size)? };
        Ok((again, true))
    }
}

/// The first match in `text` starting at or after `col` (UTF-16 units), as UTF-16 start and end.
fn first_match(re: &regex::Regex, text: &str, col: u64) -> Option<(u64, u64)> {
    let from = byte_of(text, col);
    re.find_iter(&text[from..]).find(|m| m.start() != m.end()).map(|m| utf16_span(text, from + m.start(), from + m.end()))
}

/// The last match in `text` that starts before `col` (UTF-16 units; any with `None`).
fn last_match(re: &regex::Regex, text: &str, col: Option<u64>) -> Option<(u64, u64)> {
    let limit = col.map(|c| byte_of(text, c));
    re.find_iter(text).filter(|m| m.start() != m.end() && limit.is_none_or(|l| m.start() < l)).last().map(|m| utf16_span(text, m.start(), m.end()))
}

/// The byte index in `text` of UTF-16 unit `col`.
fn byte_of(text: &str, col: u64) -> usize {
    let mut units = 0u64;
    for (at, c) in text.char_indices() {
        if units >= col {
            return at;
        }
        units += c.len_utf16() as u64;
    }
    text.len()
}

fn utf16_span(text: &str, start: usize, end: usize) -> (u64, u64) {
    let from = text[..start].encode_utf16().count() as u64;
    (from, from + text[start..end].encode_utf16().count() as u64)
}

/// The first place `needle` starts in `[lo, hi)`, read a window at a time with the windows overlapping by the needle.
fn scan_forward(file: &File, needle: &[u8], lo: u64, hi: u64) -> Result<Option<u64>, String> {
    let overlap = needle.len() as u64 - 1;
    let mut at = lo;
    while at < hi {
        let take = (BYTE_CHUNK as u64 + overlap).min(hi - at) as usize;
        let window = read_range(file, at, take).map_err(|e| format!("Could not read the file: {e}"))?;
        if let Some(i) = window.windows(needle.len()).position(|w| w == needle) {
            return Ok(Some(at + i as u64));
        }
        if window.len() < take || at + take as u64 >= hi {
            break;
        }
        at += BYTE_CHUNK as u64;
    }
    Ok(None)
}

/// The last place `needle` starts in `[lo, hi)`.
fn scan_backward(file: &File, needle: &[u8], lo: u64, hi: u64) -> Result<Option<u64>, String> {
    let overlap = needle.len() as u64 - 1;
    let mut end = hi;
    while end > lo {
        let start = end.saturating_sub(BYTE_CHUNK as u64 + overlap).max(lo);
        let window = read_range(file, start, (end - start) as usize).map_err(|e| format!("Could not read the file: {e}"))?;
        if let Some(i) = window.windows(needle.len()).rposition(|w| w == needle) {
            return Ok(Some(start + i as u64));
        }
        if start == lo {
            break;
        }
        end = start + overlap;
    }
    Ok(None)
}

/// A search pattern: a regular expression, or text that is matched as it is.
pub fn matcher(pattern: &str, regex: bool, case: bool) -> Result<regex::Regex, String> {
    if pattern.is_empty() {
        return Err("Type something to search for".into());
    }
    let source = if regex { pattern.to_string() } else { regex::escape(pattern) };
    regex::RegexBuilder::new(&source).case_insensitive(!case).size_limit(8 * 1024 * 1024).build().map_err(|e| format!("This is not a valid pattern: {e}"))
}

/// The open viewers by handle, and the window each belongs to.
#[derive(Default)]
pub struct Viewers {
    map: Mutex<HashMap<String, Arc<Viewer>>>,
}

impl Viewers {
    pub fn open(&self, owner: &str, resolve: Resolve, emit: Emit) -> Result<Arc<Viewer>, String> {
        let handle = uuid::Uuid::new_v4().simple().to_string();
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, v| !v.is_closed());
        if map.len() >= MAX_VIEWERS {
            return Err(format!("{MAX_VIEWERS} files are open in the viewer; close a tab first"));
        }
        let viewer = Viewer::open(handle.clone(), owner.to_string(), resolve, emit)?;
        map.insert(handle, viewer.clone());
        Ok(viewer)
    }

    pub fn get(&self, handle: &str) -> Result<Arc<Viewer>, String> {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).get(handle).cloned().ok_or_else(|| "This file is no longer open in the viewer; open it again".to_string())
    }

    pub fn close(&self, handle: &str) {
        if let Some(viewer) = self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(handle) {
            viewer.close();
        }
    }

    /// Close every viewer of a window that is going away.
    pub fn close_owned(&self, owner: &str) {
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, v| {
            let mine = v.owner == owner;
            if mine {
                v.close();
            }
            !mine
        });
    }

    #[cfg(test)]
    pub fn count(&self) -> usize {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub handle: String,
    pub size: u64,
    pub encoding: String,
    pub bom: bool,
    pub binary: bool,
    pub first: Lines,
}

fn emitter(app: &AppHandle) -> Emit {
    let app = app.clone();
    Arc::new(move |name, progress| {
        let _ = app.emit(name, progress);
    })
}

/// Open a page of a notebook or a loose file in the viewer. The file is named and resolved as `file_read` does; the
/// viewer resolves it again whenever it follows the file.
#[tauri::command]
pub async fn bigfile_open(window: tauri::Window, app: AppHandle, state: State<'_, crate::AppState>, notebook: String, path: String) -> Result<Opened, String> {
    // Refused here, before anything is opened, when the file is not one the webview may read.
    crate::studio::resolve_file(&state, &notebook, &path, false)?;
    let resolver = app.clone();
    let resolve: Resolve = Arc::new(move || {
        let state = resolver.state::<crate::AppState>();
        crate::studio::resolve_file(&state, &notebook, &path, false).map(|(full, _)| full)
    });
    let (emit, owner) = (emitter(&app), window.label().to_string());
    let app2 = app.clone();
    crate::blocking(move || {
        let state = app2.state::<crate::AppState>();
        let viewer = state.bigfiles.open(&owner, resolve, emit)?;
        let first = viewer.lines(0, 120);
        Ok(Opened { handle: viewer.handle.clone(), size: viewer.size(), encoding: viewer.encoding_name(), bom: viewer.bom(), binary: viewer.binary(), first })
    })
    .await
}

#[tauri::command]
pub async fn bigfile_lines(state: State<'_, crate::AppState>, handle: String, first: u64, count: u64) -> Result<Lines, String> {
    let viewer = state.bigfiles.get(&handle)?;
    crate::blocking(move || Ok(viewer.lines(first, count))).await
}

/// Find the next or previous match of `pattern` from `(line, col)`. `regex` false searches the text as typed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bigfile_search(state: State<'_, crate::AppState>, handle: String, pattern: String, regex: bool, case: bool, line: u64, col: u64, forward: bool) -> Result<Found, String> {
    let viewer = state.bigfiles.get(&handle)?;
    let re = matcher(&pattern, regex, case)?;
    crate::blocking(move || Ok(viewer.search(&re, line, col, forward))).await
}

#[tauri::command]
pub async fn bigfile_bytes(state: State<'_, crate::AppState>, handle: String, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let viewer = state.bigfiles.get(&handle)?;
    crate::blocking(move || viewer.bytes(offset, len)).await
}

/// Find bytes (typed as hex, or text) from `offset`: where they start, and whether the search wrapped.
#[tauri::command]
pub async fn bigfile_find_bytes(state: State<'_, crate::AppState>, handle: String, needle: Vec<u8>, offset: u64, forward: bool) -> Result<(Option<u64>, bool), String> {
    let viewer = state.bigfiles.get(&handle)?;
    crate::blocking(move || viewer.find_bytes(&needle, offset, forward)).await
}

#[tauri::command]
pub fn bigfile_close(state: State<'_, crate::AppState>, handle: String) {
    state.bigfiles.close(&handle);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex as StdMutex;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-bigfile-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    type Events = Arc<StdMutex<Vec<(&'static str, Progress)>>>;

    fn quiet() -> (Emit, Events) {
        let seen: Events = Default::default();
        let sink = seen.clone();
        (Arc::new(move |name, p| sink.lock().unwrap().push((name, p))), seen)
    }

    fn open(path: &Path) -> (Arc<Viewer>, Events) {
        let (emit, seen) = quiet();
        let target = path.to_path_buf();
        let viewer = Viewer::open("h".into(), "main".into(), Arc::new(move || Ok(target.clone())), emit).unwrap();
        wait_done(&viewer);
        (viewer, seen)
    }

    fn wait_done(viewer: &Viewer) {
        for _ in 0..800 {
            if viewer.lock().done {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("the index did not finish");
    }

    fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
        for _ in 0..400 {
            if ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {what}");
    }

    fn utf16(text: &str, big: bool, bom: bool) -> Vec<u8> {
        let mut out = Vec::new();
        if bom {
            out.extend_from_slice(if big { &[0xFE, 0xFF] } else { &[0xFF, 0xFE] });
        }
        out.extend(text.encode_utf16().flat_map(|u| if big { u.to_be_bytes() } else { u.to_le_bytes() }));
        out
    }

    fn texts(viewer: &Viewer, first: u64, count: u64) -> Vec<String> {
        viewer.lines(first, count).lines.into_iter().map(|l| l.text).collect()
    }

    fn numbered(count: usize, eol: &str) -> String {
        (0..count).map(|i| format!("line {i}{eol}")).collect()
    }

    fn re(pattern: &str) -> regex::Regex {
        matcher(pattern, true, true).unwrap()
    }

    #[test]
    fn the_line_index_reads_lf_files_across_its_marks() {
        let dir = scratch();
        let path = dir.join("lf.log");
        std::fs::write(&path, numbered(5000, "\n")).unwrap();
        let (v, _) = open(&path);
        assert_eq!(v.line_count(), 5000);
        assert_eq!(texts(&v, 0, 2), ["line 0", "line 1"]);
        // Across a mark, and the last line.
        assert_eq!(texts(&v, 1023, 3), ["line 1023", "line 1024", "line 1025"]);
        assert_eq!(texts(&v, 4999, 5), ["line 4999"]);
        assert_eq!(texts(&v, 2048, 1), ["line 2048"]);
        assert!(texts(&v, 5000, 5).is_empty());
        assert_eq!(v.lines(100, 2).lines[1].number, 101);
        assert!(v.lines(0, 1).indexed);
    }

    #[test]
    fn crlf_is_one_break_and_the_carriage_return_is_not_shown() {
        let dir = scratch();
        let path = dir.join("crlf.log");
        std::fs::write(&path, numbered(3000, "\r\n")).unwrap();
        let (v, _) = open(&path);
        assert_eq!(v.line_count(), 3000);
        assert_eq!(texts(&v, 1024, 1), ["line 1024"]);
        assert_eq!(texts(&v, 2999, 1), ["line 2999"]);
    }

    #[test]
    fn a_file_without_a_trailing_newline_counts_its_last_line() {
        let dir = scratch();
        let path = dir.join("tail.txt");
        std::fs::write(&path, "one\ntwo\nthree").unwrap();
        let (v, _) = open(&path);
        assert_eq!(v.line_count(), 3);
        assert_eq!(texts(&v, 0, 10), ["one", "two", "three"]);
        std::fs::write(&path, "one\ntwo\nthree\n").unwrap();
        let (v, _) = open(&path);
        assert_eq!(v.line_count(), 3);
        assert_eq!(texts(&v, 2, 5), ["three"]);
    }

    #[test]
    fn an_empty_file_has_no_lines_and_a_lone_newline_has_one() {
        let dir = scratch();
        let path = dir.join("empty.txt");
        std::fs::write(&path, "").unwrap();
        let (v, _) = open(&path);
        assert_eq!((v.line_count(), v.lines(0, 5).lines.len()), (0, 0));
        assert_eq!(v.size(), 0);
        assert_eq!(find_hit(&v, "x", 0, 0, true), None);
        std::fs::write(&path, "\n").unwrap();
        let (v, _) = open(&path);
        assert_eq!(v.line_count(), 1);
        assert_eq!(texts(&v, 0, 5), [""]);
    }

    #[test]
    fn utf16_files_index_their_two_byte_line_breaks() {
        let dir = scratch();
        let text = numbered(3000, "\r\n") + "ünï\u{1F600}";
        for (name, big, bom) in [("le.txt", false, true), ("be.txt", true, true), ("le-nobom.txt", false, false)] {
            let path = dir.join(name);
            std::fs::write(&path, utf16(&text, big, bom)).unwrap();
            let (v, _) = open(&path);
            assert_eq!(v.encoding_name(), if big { "UTF-16 BE" } else { "UTF-16 LE" }, "{name}");
            assert_eq!(v.line_count(), 3001, "{name}");
            assert_eq!(texts(&v, 0, 1), ["line 0"], "{name}");
            assert_eq!(texts(&v, 1024, 1), ["line 1024"], "{name}");
            assert_eq!(texts(&v, 3000, 1), ["ünï\u{1F600}"], "{name}");
            // A search finds a match in UTF-16 text, and its columns count UTF-16 units of the line.
            let hit = find_hit(&v, "ï", 0, 0, true).unwrap();
            assert_eq!((hit.line, hit.start, hit.end), (3000, 2, 3), "{name}");
        }
    }

    #[test]
    fn a_line_longer_than_a_window_is_cut_and_the_lines_after_it_still_number_right() {
        let dir = scratch();
        let path = dir.join("long.json");
        let long = "x".repeat(3 * LINE_CHUNK + 17);
        std::fs::write(&path, format!("first\n{long}\nthird\n{}", numbered(2000, "\n"))).unwrap();
        let (v, _) = open(&path);
        assert_eq!(v.line_count(), 2003);
        let lines = v.lines(0, 3).lines;
        assert_eq!(lines[0].text, "first");
        assert!(lines[1].cut && lines[1].text.len() == DISPLAY_LINE);
        assert_eq!((lines[2].text.as_str(), lines[2].number, lines[2].cut), ("third", 2, false));
        assert_eq!(texts(&v, 2002, 1), ["line 1999"]);
        // Search sees the start of a long line, and goes on past it.
        assert_eq!(find_hit(&v, "xxxx", 0, 0, true).unwrap().line, 1);
        assert_eq!(find_hit(&v, "line 1999", 0, 0, true).unwrap().line, 2002);
    }

    fn find_hit(v: &Viewer, pattern: &str, line: u64, col: u64, forward: bool) -> Option<Hit> {
        v.search(&re(pattern), line, col, forward).hit
    }

    #[test]
    fn a_regex_search_goes_both_ways_across_marks_and_wraps() {
        let dir = scratch();
        let path = dir.join("search.log");
        let mut lines: Vec<String> = (0..3000).map(|i| format!("row {i}")).collect();
        for at in [10, 1023, 1024, 1500, 2999] {
            lines[at].push_str(" NEEDLE");
        }
        std::fs::write(&path, lines.join("\n")).unwrap();
        let (v, _) = open(&path);
        let next = |line, col| { let f = v.search(&re("NEEDLE"), line, col, true); (f.hit.map(|h| h.line), f.wrapped) };
        let prev = |line, col| { let f = v.search(&re("NEEDLE"), line, col, false); (f.hit.map(|h| h.line), f.wrapped) };
        assert_eq!(next(0, 0), (Some(10), false));
        assert_eq!(next(10, 100), (Some(1023), false));
        assert_eq!(next(1023, 100), (Some(1024), false));
        assert_eq!(next(1024, 100), (Some(1500), false));
        assert_eq!(next(2999, 100), (Some(10), true));
        assert_eq!(prev(1500, 0), (Some(1024), false));
        assert_eq!(prev(1024, 0), (Some(1023), false));
        assert_eq!(prev(1023, 0), (Some(10), false));
        assert_eq!(prev(10, 0), (Some(2999), true));
        // On the same line: a match after `col` is next, one before it is previous.
        let on = v.search(&re("NEEDLE"), 1500, 0, true).hit.unwrap();
        assert_eq!((on.line, on.start, on.end), (1500, 9, 15));
        assert_eq!(next(1500, on.start).0, Some(1500));
        assert_eq!(next(1500, on.start + 1), (Some(2999), false));
        assert_eq!(prev(1500, on.start + 3).0, Some(1500));
        assert_eq!(prev(1500, on.start), (Some(1024), false));
        // No match at all.
        let none = v.search(&re("absent"), 5, 0, true);
        assert_eq!((none.hit, none.wrapped), (None, true));
        // A regex: groups, classes and anchors; plain text is not read as a pattern.
        assert_eq!(find_hit(&v, r"^row 20\d\d NEEDLE|^row 2999 NEEDLE", 0, 0, true).unwrap().line, 2999);
        assert_eq!(v.search(&matcher("row 1.. (", false, true).unwrap(), 0, 0, true).hit, None);
        assert!(matcher("(", true, true).is_err() && matcher("", true, true).is_err());
        assert_eq!(v.search(&matcher("needle", false, false).unwrap(), 0, 0, true).hit.unwrap().line, 10);
        assert_eq!(v.search(&matcher("needle", false, true).unwrap(), 0, 0, true).hit, None);
    }

    #[test]
    fn a_match_on_a_line_that_crosses_the_read_window_is_found() {
        let dir = scratch();
        let path = dir.join("window.log");
        // About 3 MB in lines of 1000 bytes: one of them straddles each 1 MB read window.
        let mut lines: Vec<String> = (0..3000).map(|i| format!("{i:05} {}", "a".repeat(993))).collect();
        let straddling = LINE_CHUNK / 1000;
        lines[straddling].replace_range(500..510, "WINDOWEDGE");
        std::fs::write(&path, lines.join("\n")).unwrap();
        let (v, _) = open(&path);
        let hit = find_hit(&v, "WINDOWEDGE", 0, 0, true).unwrap();
        assert_eq!((hit.line, hit.start, hit.end), (straddling as u64, 500, 510));
        assert_eq!(find_hit(&v, "WINDOWEDGE", 2999, 0, false).unwrap().line, straddling as u64);
    }

    #[test]
    fn a_newer_search_stops_an_older_one() {
        let dir = scratch();
        let path = dir.join("cancel.log");
        std::fs::write(&path, numbered(2000, "\n")).unwrap();
        let (v, _) = open(&path);
        // The older search is told it is out of date once another one has started.
        let mine = v.searches.load(Ordering::Relaxed);
        let _ = v.search(&re("line 5"), 0, 0, true);
        assert!(v.stale(mine));
        v.searches.store(7, Ordering::Relaxed);
        assert_eq!(v.forward_until(&re("zzz"), 0, 0, 1999, 3), Err(true));
    }

    #[test]
    fn bytes_are_read_and_searched_both_ways_across_windows() {
        let dir = scratch();
        let path = dir.join("hex.bin");
        let mut data = vec![0u8; BYTE_CHUNK + 4096];
        data[100..104].copy_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        // Straddling the first window's end.
        data[BYTE_CHUNK - 2..BYTE_CHUNK + 2].copy_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        data[BYTE_CHUNK + 4000..BYTE_CHUNK + 4004].copy_from_slice(&[0xDE, 0xAD, 0xBE, 0xEF]);
        std::fs::write(&path, &data).unwrap();
        let (v, _) = open(&path);
        assert!(v.binary());
        assert_eq!(v.bytes(98, 8).unwrap(), [0, 0, 0xDE, 0xAD, 0xBE, 0xEF, 0, 0]);
        assert_eq!(v.bytes(data.len() as u64 - 2, 10).unwrap().len(), 2);
        let needle = [0xDE, 0xAD, 0xBE, 0xEF];
        let at = |offset, forward| v.find_bytes(&needle, offset, forward).unwrap();
        assert_eq!(at(0, true), (Some(100), false));
        assert_eq!(at(101, true), (Some(BYTE_CHUNK as u64 - 2), false));
        assert_eq!(at(BYTE_CHUNK as u64 - 1, true), (Some(BYTE_CHUNK as u64 + 4000), false));
        assert_eq!(at(BYTE_CHUNK as u64 + 4001, true), (Some(100), true));
        assert_eq!(at(BYTE_CHUNK as u64 + 4000, false), (Some(BYTE_CHUNK as u64 - 2), false));
        assert_eq!(at(100, false), (Some(BYTE_CHUNK as u64 + 4000), true));
        assert_eq!(v.find_bytes(&[1, 2, 3], 0, true).unwrap(), (None, true));
        assert!(v.find_bytes(&[], 0, true).is_err());
    }

    #[test]
    fn the_viewer_tells_what_to_show_for_each_kind_of_file() {
        let dir = scratch();
        std::fs::write(dir.join("bin.dat"), b"PK\x03\x04\x00\x00data\x00\n").unwrap();
        let (v, _) = open(&dir.join("bin.dat"));
        assert!(v.binary());
        assert_eq!(texts(&v, 0, 5)[0], "PK\u{3}\u{4}\u{0}\u{0}data\u{0}".chars().map(|c| if c.is_control() { '\u{b7}' } else { c }).collect::<String>());
        std::fs::write(dir.join("w.txt"), b"Le caf\xe9 co\xfbte 3 \xc2\xa3 au march\xe9 de la ville\r\nsecond line\r\n").unwrap();
        let (v, _) = open(&dir.join("w.txt"));
        assert_eq!((v.encoding_name().as_str(), v.binary()), ("Windows-1252", false));
        assert!(texts(&v, 0, 2)[0].starts_with("Le caf\u{e9} co\u{fb}te"));
        std::fs::write(dir.join("bom.txt"), b"\xEF\xBB\xBFhello\n").unwrap();
        let (v, _) = open(&dir.join("bom.txt"));
        assert!(v.bom());
        assert_eq!(texts(&v, 0, 1), ["hello"]);
    }

    #[test]
    fn following_a_growing_file_indexes_what_is_added() {
        let dir = scratch();
        let path = dir.join("grow.log");
        std::fs::write(&path, numbered(1500, "\n")).unwrap();
        let (v, seen) = open(&path);
        assert_eq!(v.line_count(), 1500);
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(numbered(700, "\n").replace("line", "more").as_bytes()).unwrap();
        file.write_all(b"partial").unwrap();
        wait_for("growth", || v.line_count() == 2201);
        assert_eq!(texts(&v, 2198, 5), ["more 698", "more 699", "partial"]);
        assert!(seen.lock().unwrap().iter().any(|(name, p)| *name == "bigfile-grew" && !p.reset && p.lines == 2201));
        // The partial line is finished by the next write.
        file.write_all(b" line\nlast\n").unwrap();
        wait_for("the partial line to end", || v.line_count() == 2202);
        assert_eq!(texts(&v, 2200, 5), ["partial line", "last"]);
    }

    #[test]
    fn a_truncated_file_is_indexed_again_from_its_start() {
        let dir = scratch();
        let path = dir.join("trunc.log");
        std::fs::write(&path, numbered(3000, "\n")).unwrap();
        let (v, seen) = open(&path);
        assert_eq!(v.line_count(), 3000);
        std::fs::write(&path, numbered(40, "\n").replace("line", "fresh")).unwrap();
        wait_for("the reset", || v.line_count() == 40);
        assert_eq!(texts(&v, 0, 2), ["fresh 0", "fresh 1"]);
        assert!(seen.lock().unwrap().iter().any(|(name, p)| *name == "bigfile-grew" && p.reset));
    }

    #[test]
    fn a_rotated_file_is_followed_to_the_new_one_even_when_it_is_larger() {
        let dir = scratch();
        let path = dir.join("app.log");
        std::fs::write(&path, numbered(100, "\n")).unwrap();
        let (v, _) = open(&path);
        // The writer renames the log away (the viewer holds it, and that is allowed) and starts a new one.
        std::fs::rename(&path, dir.join("app.log.1")).unwrap();
        std::fs::write(&path, numbered(900, "\n").replace("line", "new")).unwrap();
        wait_for("the new file", || v.line_count() == 900 && texts(&v, 0, 1) == ["new 0"]);
        // A rewrite in place with other content and the same length is seen as a replacement too.
        std::fs::write(&path, numbered(900, "\n").replace("line", "xxx")).unwrap();
        wait_for("the rewrite", || texts(&v, 0, 1) == ["xxx 0"]);
    }

    #[test]
    fn closing_a_viewer_drops_it_and_stops_its_thread() {
        let dir = scratch();
        let path = dir.join("close.log");
        std::fs::write(&path, "a\nb\n").unwrap();
        let viewers = Viewers::default();
        let target = path.clone();
        let (emit, _) = quiet();
        let viewer = viewers.open("main", Arc::new(move || Ok(target.clone())), emit.clone()).unwrap();
        let handle = viewer.handle.clone();
        let weak = Arc::downgrade(&viewer);
        drop(viewer);
        assert!(viewers.get(&handle).is_ok());
        viewers.close(&handle);
        assert!(viewers.get(&handle).is_err());
        wait_for("the thread to end", || weak.upgrade().is_none());
        // A window's viewers go with it; another window's stay.
        let target = path.clone();
        let one = viewers.open("main", Arc::new(move || Ok(target.clone())), emit.clone()).unwrap().handle.clone();
        let target = path.clone();
        let two = viewers.open("other", Arc::new(move || Ok(target.clone())), emit).unwrap().handle.clone();
        viewers.close_owned("main");
        assert!(viewers.get(&one).is_err() && viewers.get(&two).is_ok());
        assert_eq!(viewers.count(), 1);
        viewers.close(&two);
    }

    #[test]
    fn other_programs_can_write_rename_and_delete_a_file_the_viewer_holds() {
        let dir = scratch();
        let path = dir.join("shared.log");
        std::fs::write(&path, "one\ntwo\n").unwrap();
        let (v, _) = open(&path);
        // Write.
        let mut other = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        other.write_all(b"three\n").unwrap();
        drop(other);
        wait_for("the new line", || v.line_count() == 3);
        // Hivemind's own save (hold, then replace) is not blocked either.
        let held = crate::files::atomic::hold(&path).unwrap();
        drop(held);
        // Rename and delete while the viewer has the file open.
        let moved = dir.join("shared.log.1");
        std::fs::rename(&path, &moved).unwrap();
        std::fs::remove_file(&moved).unwrap();
        // The viewer still reads what it had.
        assert_eq!(texts(&v, 0, 5), ["one", "two", "three"]);
    }

    #[test]
    fn a_path_outside_the_notebook_is_never_opened() {
        use crate::files::guard::Protected;
        let root = scratch();
        let outside = scratch();
        std::fs::write(outside.join("secret.txt"), "no").unwrap();
        std::fs::write(root.join("fine.txt"), "yes\n").unwrap();
        std::fs::create_dir_all(root.join(".hivemind")).unwrap();
        std::fs::write(root.join(".hivemind/notebook.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app/data.txt"), "x").unwrap();
        let resolve = |rel: &'static str| -> Resolve {
            let (root, protected) = (root.clone(), Protected::new(None).with_app(&root.join("app")));
            Arc::new(move || crate::studio::inside(&root, &protected, rel, false))
        };
        let viewers = Viewers::default();
        let (emit, _) = quiet();
        let try_open = |rel: &'static str| viewers.open("main", resolve(rel), emit.clone()).map(|v| v.handle.clone());
        assert!(try_open("fine.txt").is_ok());
        for bad in ["../secret.txt", ".hivemind/notebook.json", "app/data.txt", "a/../../secret.txt", "C:/Windows/win.ini", "fine.txt:stream"] {
            assert!(try_open(bad).is_err(), "{bad}");
        }
        assert!(try_open("missing.txt").is_err());
        // A junction out of the notebook is refused as well.
        let link = root.join("link");
        let made = std::process::Command::new("cmd").args(["/d", "/c", "mklink", "/J"]).arg(&link).arg(&outside).output();
        if made.is_ok_and(|o| o.status.success()) {
            assert!(try_open("link/secret.txt").is_err());
        } else {
            eprintln!("skipped: mklink /J is not available here");
        }
    }

    #[test]
    fn a_folder_is_not_a_file() {
        let dir = scratch();
        let (emit, _) = quiet();
        let target = dir.clone();
        assert!(Viewer::open("h".into(), "main".into(), Arc::new(move || Ok(target.clone())), emit).is_err());
    }

    /// A 200 MB log opens in under a second and indexes (`HIVEMIND_TEST_BIG=1 cargo test --release 200_mb -- --ignored`).
    #[test]
    #[ignore = "makes a 200 MB file; run with HIVEMIND_TEST_BIG=1 and --ignored"]
    fn a_200_mb_file_opens_in_under_a_second_and_indexes() {
        if std::env::var("HIVEMIND_TEST_BIG").is_err() {
            eprintln!("skipped: set HIVEMIND_TEST_BIG=1");
            return;
        }
        let dir = scratch();
        let path = dir.join("big.log");
        let mut out = std::io::BufWriter::new(File::create(&path).unwrap());
        let (mut written, mut n) = (0u64, 0u64);
        while written < 200 * 1024 * 1024 {
            let line = format!("2026-11-22 12:00:{:02} INFO request {n} handled in {} ms\n", n % 60, n % 977);
            out.write_all(line.as_bytes()).unwrap();
            written += line.len() as u64;
            n += 1;
        }
        out.flush().unwrap();
        drop(out);
        let started = Instant::now();
        let (emit, _) = quiet();
        let target = path.clone();
        let viewer = Viewer::open("big".into(), "main".into(), Arc::new(move || Ok(target.clone())), emit).unwrap();
        let first = viewer.lines(0, 120);
        let opened = started.elapsed();
        eprintln!("opened the first window of {n} lines in {opened:?}");
        assert_eq!(first.lines.len(), 120);
        assert!(opened < Duration::from_secs(1), "opening took {opened:?}");
        let indexing = Instant::now();
        wait_done(&viewer);
        eprintln!("indexed {} lines in {:?}", viewer.line_count(), indexing.elapsed() + opened);
        assert_eq!(viewer.line_count(), n);
        assert_eq!(texts(&viewer, n - 1, 1), [format!("2026-11-22 12:00:{:02} INFO request {} handled in {} ms", (n - 1) % 60, n - 1, (n - 1) % 977)]);
        let searching = Instant::now();
        let hit = viewer.search(&re(&format!("request {} handled", n - 5)), 0, 0, true).hit.unwrap();
        eprintln!("searched to line {} in {:?}", hit.line, searching.elapsed());
        assert_eq!(hit.line, n - 5);
        viewer.close();
    }
}
