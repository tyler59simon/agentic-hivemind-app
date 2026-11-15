//! The capped raw history of one terminal.
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// How much history is kept: the file is cut back to this when it reaches twice this.
pub const KEEP: u64 = 2 * 1024 * 1024;
/// A cut moves forward to the next line start only when one is this close.
const LINE_SEARCH: usize = 64 * 1024;

pub struct Scrollback {
    path: PathBuf,
    file: File,
    len: u64,
    keep: u64,
}

impl Scrollback {
    /// Open (or create) the file for appending. `keep` is `KEEP` outside tests.
    pub fn open(path: PathBuf, keep: u64) -> Result<Scrollback, String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{e:#}"))?;
        }
        let file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("{e:#}"))?;
        let len = file.metadata().map_err(|e| format!("{e:#}"))?.len();
        Ok(Scrollback { path, file, len, keep })
    }

    /// Append; errors are ignored (a full disk must not stop the terminal).
    pub fn append(&mut self, bytes: &[u8]) {
        if self.file.write_all(bytes).is_err() {
            return;
        }
        self.len += bytes.len() as u64;
        if self.len >= 2 * self.keep {
            self.trim();
        }
    }

    /// Everything saved so far; empty when there is no file.
    pub fn read(path: &Path) -> Vec<u8> {
        fs::read(path).unwrap_or_default()
    }

    /// Cut the file back to its last `keep` bytes, starting at a line start when one is near.
    fn trim(&mut self) {
        let _ = self.try_trim();
    }

    fn try_trim(&mut self) -> std::io::Result<()> {
        let mut source = File::open(&self.path)?;
        let size = source.metadata()?.len();
        let start = size.saturating_sub(self.keep);
        source.seek(SeekFrom::Start(start))?;
        let mut tail = Vec::new();
        source.read_to_end(&mut tail)?;
        drop(source);
        let window = tail.len().min(LINE_SEARCH);
        let from = tail[..window].iter().position(|b| *b == b'\n').map_or(0, |i| i + 1);
        let tmp = self.path.with_extension("bin.tmp");
        fs::write(&tmp, &tail[from..])?;
        fs::rename(&tmp, &self.path)?;
        self.file = OpenOptions::new().append(true).open(&self.path)?;
        self.len = (tail.len() - from) as u64;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivemind-scrollback-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn appends_and_reads_back() {
        let dir = folder("basic");
        let path = dir.join("scrollback.bin");
        assert!(Scrollback::read(&dir.join("missing.bin")).is_empty());
        let mut s = Scrollback::open(path.clone(), 1024).unwrap();
        s.append(b"one\n");
        s.append(b"two\n");
        assert_eq!(Scrollback::read(&path), b"one\ntwo\n");
        let mut again = Scrollback::open(path.clone(), 1024).unwrap();
        again.append(b"three\n");
        assert_eq!(Scrollback::read(&path), b"one\ntwo\nthree\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trims_to_the_newest_bytes_at_a_line_start() {
        let dir = folder("trim");
        let path = dir.join("scrollback.bin");
        let mut s = Scrollback::open(path.clone(), 1024).unwrap();
        let mut last = String::new();
        for n in 0..100 {
            last = format!("line-{n:04}-{}\n", "x".repeat(19));
            s.append(last.as_bytes());
            assert!(fs::metadata(&path).unwrap().len() <= 2048 + 30);
        }
        let saved = Scrollback::read(&path);
        assert!(saved.ends_with(last.as_bytes()));
        assert!(saved.starts_with(b"line-"));
        assert!(saved.len() <= 2048);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn survives_bytes_without_newlines() {
        let dir = folder("binary");
        let path = dir.join("scrollback.bin");
        let mut s = Scrollback::open(path.clone(), 1024).unwrap();
        s.append(&[0xFF; 5000]);
        let saved = Scrollback::read(&path);
        assert!(!saved.is_empty() && saved.len() <= 2048);
        let _ = fs::remove_dir_all(&dir);
    }
}
