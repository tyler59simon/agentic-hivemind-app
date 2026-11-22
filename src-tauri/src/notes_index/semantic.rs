//! Reading the static embedding model Living Memory installs (NS-4B), so Hivemind ships no model and no ONNX runtime. The
//! reader mirrors `agentic-living-memory/core/semantic.py` (spike S5 measured it against Python on 26 texts): the model is
//! a WordPiece vocabulary plus one embedding row per piece, and a text's vector is the normalised mean of its pieces' rows.
//!
//! Hivemind never installs, checks or changes the model folder. The model is used only while `verified.json` is in
//! `<store>/.models/potion-retrieval-32M/`, which Living Memory's `semantic install` writes last and `semantic remove`
//! deletes first. The marker is read before every embedding batch, so an install or a remove takes effect at once.
//!
//! Rows are read with positional reads and a bounded cache, not a memory map: on Windows a mapped file cannot be deleted,
//! and `semantic install` and `semantic remove` replace the folder. The file is closed after 30 seconds without use.
use rusqlite::Connection;
use serde::Deserialize;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use unicode_general_category::{get_general_category, GeneralCategory as Cat};
use unicode_normalization::UnicodeNormalization;

/// The only model Living Memory installs (`MODELS` in `semantic.py`).
pub const MODEL: &str = "potion-retrieval-32M";
/// The cosine at which a page found only by meaning is shown (`min_similarity` of that model in `MODELS`).
pub const MIN_SIMILARITY: f32 = 0.45;
const MARKER: &str = "verified.json";
const MAX_TOKENS: usize = 512;
/// Vocabulary rows kept unpacked, as `ROW_CACHE` in `semantic.py`.
const ROW_CACHE: usize = 1024;
/// How long the model file stays open without use.
const IDLE: Duration = Duration::from_secs(30);
/// A safetensors header is a small JSON object; one larger than this is not a model.
const HEADER_MAX: u64 = 64 * 1024 * 1024;
/// A piece that is not in the vocabulary, before the unknown pieces are dropped.
const UNKNOWN: u32 = u32::MAX;

/// Which model is installed: its name and the hash of `model.safetensors` that `verified.json` records. A different hash
/// is a different model, and vectors made by another model are not comparable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub hash: String,
}

impl Identity {
    pub fn key(&self) -> String {
        format!("{}:{}", self.name, self.hash)
    }
}

/// The folder Living Memory keeps the model in.
fn model_dir(root: &Path) -> PathBuf {
    root.join(".models").join(MODEL)
}

/// The installed, verified model in the store at `root`, or None. Reads one marker and loads nothing (`installed` in
/// `semantic.py` only asks whether the marker is a file; the hash is read here for the identity).
pub fn installed(root: &Path) -> Option<Identity> {
    let marker = model_dir(root).join(MARKER);
    if !marker.is_file() {
        return None;
    }
    let hash = std::fs::read(&marker)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|v| v.get("files")?.get("model.safetensors")?.as_str().map(str::to_string))
        .unwrap_or_default();
    Some(Identity { name: MODEL.to_string(), hash })
}

// ---- the tokenizer -------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct TokenizerFile {
    model: Option<ModelPart>,
    normalizer: Option<NormalizerPart>,
    pre_tokenizer: Option<TypePart>,
}

#[derive(Deserialize)]
struct TypePart {
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct ModelPart {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    vocab: HashMap<String, u32>,
    unk_token: Option<String>,
    continuing_subword_prefix: Option<String>,
    max_input_chars_per_word: Option<usize>,
}

#[derive(Deserialize)]
struct NormalizerPart {
    #[serde(rename = "type")]
    kind: Option<String>,
    lowercase: Option<bool>,
    strip_accents: Option<bool>,
    clean_text: Option<bool>,
    handle_chinese_chars: Option<bool>,
}

/// WordPiece with BERT normalisation and pre-tokenisation, the only tokenizer the reader supports.
pub struct Tokenizer {
    vocab: HashMap<String, u32>,
    unk: Option<u32>,
    prefix: String,
    max_chars: usize,
    lower: bool,
    strip: bool,
    clean: bool,
    chinese: bool,
}

fn py_isspace(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\u{1c}'..='\u{1f}')
}

fn punctuation(c: char) -> bool {
    let code = c as u32;
    (33..=47).contains(&code)
        || (58..=64).contains(&code)
        || (91..=96).contains(&code)
        || (123..=126).contains(&code)
        || matches!(
            get_general_category(c),
            Cat::ConnectorPunctuation | Cat::DashPunctuation | Cat::OpenPunctuation | Cat::ClosePunctuation | Cat::InitialPunctuation | Cat::FinalPunctuation | Cat::OtherPunctuation
        )
}

fn cjk(code: u32) -> bool {
    matches!(code, 0x4E00..=0x9FFF | 0x3400..=0x4DBF | 0x20000..=0x2A6DF | 0x2A700..=0x2B73F | 0x2B740..=0x2B81F | 0x2B820..=0x2CEAF | 0xF900..=0xFAFF | 0x2F800..=0x2FA1F)
}

impl Tokenizer {
    fn parse(bytes: &[u8]) -> Result<Tokenizer, String> {
        let file: TokenizerFile = serde_json::from_slice(bytes).map_err(|e| format!("tokenizer.json cannot be read: {e}"))?;
        let (model, norm, pre) = (file.model, file.normalizer, file.pre_tokenizer);
        let unsupported = "Only WordPiece tokenizers with BERT normalization are read";
        let (Some(model), Some(norm), Some(pre)) = (model, norm, pre) else { return Err(unsupported.into()) };
        if model.kind.as_deref() != Some("WordPiece") || norm.kind.as_deref() != Some("BertNormalizer") || pre.kind.as_deref() != Some("BertPreTokenizer") {
            return Err(unsupported.into());
        }
        let lower = norm.lowercase.unwrap_or(true);
        let unk_name = model.unk_token.as_deref().unwrap_or("[UNK]");
        Ok(Tokenizer {
            unk: model.vocab.get(unk_name).copied(),
            prefix: model.continuing_subword_prefix.unwrap_or_else(|| "##".into()),
            max_chars: model.max_input_chars_per_word.unwrap_or(100),
            vocab: model.vocab,
            lower,
            strip: norm.strip_accents.unwrap_or(lower),
            clean: norm.clean_text.unwrap_or(true),
            chinese: norm.handle_chinese_chars.unwrap_or(true),
        })
    }

    /// Clean text, space out Chinese characters, lowercase, then decompose and drop combining marks.
    fn normalize(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for ch in text.chars() {
            let code = ch as u32;
            let mut ch = ch;
            if self.clean {
                if code == 0 || code == 0xFFFD || (matches!(get_general_category(ch), Cat::Control | Cat::Format) && !matches!(ch, '\t' | '\n' | '\r')) {
                    continue;
                }
                if py_isspace(ch) {
                    ch = ' ';
                }
            }
            if self.chinese && cjk(code) {
                out.push(' ');
                out.push(ch);
                out.push(' ');
            } else {
                out.push(ch);
            }
        }
        let text = if self.lower { out.to_lowercase() } else { out };
        if self.strip { text.nfd().filter(|c| get_general_category(*c) != Cat::NonspacingMark).collect() } else { text }
    }

    /// Split on white space, and put every punctuation character in a word of its own.
    fn words(text: &str) -> Vec<String> {
        let mut words = Vec::new();
        for chunk in text.split(py_isspace).filter(|c| !c.is_empty()) {
            let mut current = String::new();
            for ch in chunk.chars() {
                if punctuation(ch) {
                    if !current.is_empty() {
                        words.push(std::mem::take(&mut current));
                    }
                    words.push(ch.to_string());
                } else {
                    current.push(ch);
                }
            }
            if !current.is_empty() {
                words.push(current);
            }
        }
        words
    }

    /// Vocabulary ids, as the `tokenizers` library gives them without special tokens: at most 512, greedy longest match
    /// with the continuation prefix, a word over the length limit or with an unmatched part unknown, unknown dropped.
    pub fn tokenize(&self, text: &str) -> Vec<u32> {
        let mut ids: Vec<u32> = Vec::new();
        for word in Self::words(&self.normalize(text)) {
            if ids.len() >= MAX_TOKENS {
                break;
            }
            let chars: Vec<char> = word.chars().collect();
            if chars.len() > self.max_chars {
                ids.push(UNKNOWN);
                continue;
            }
            let mut pieces: Vec<u32> = Vec::new();
            let mut start = 0;
            while start < chars.len() {
                let mut end = chars.len();
                let mut found = None;
                while start < end {
                    let part: String = chars[start..end].iter().collect();
                    let piece = if start == 0 { part } else { format!("{}{part}", self.prefix) };
                    if let Some(id) = self.vocab.get(&piece) {
                        found = Some(*id);
                        break;
                    }
                    end -= 1;
                }
                let Some(id) = found else {
                    pieces = vec![UNKNOWN];
                    break;
                };
                pieces.push(id);
                start = end;
            }
            ids.extend(pieces);
        }
        ids.truncate(MAX_TOKENS);
        ids.retain(|id| *id != UNKNOWN && Some(*id) != self.unk);
        ids
    }
}

// ---- the embedding rows --------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct Tensor {
    dtype: Option<String>,
    shape: Option<Vec<usize>>,
    data_offsets: Option<Vec<u64>>,
}

/// Where the embedding matrix is in `model.safetensors`.
struct Layout {
    rows: usize,
    dim: usize,
    half: bool,
    base: u64,
    row_bytes: usize,
}

fn layout_of(file: &File) -> Result<Layout, String> {
    let corrupt = |why: &str| format!("The model file is damaged: {why}");
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut size = [0u8; 8];
    read_at(file, &mut size, 0).map_err(|_| corrupt("no header"))?;
    let size = u64::from_le_bytes(size);
    if size > HEADER_MAX || 8 + size > len {
        return Err(corrupt("the header is longer than the file"));
    }
    let mut header = vec![0u8; size as usize];
    read_at(file, &mut header, 8).map_err(|_| corrupt("no header"))?;
    let header: HashMap<String, serde_json::Value> = serde_json::from_slice(&header).map_err(|_| corrupt("the header is not JSON"))?;
    let mut tensors = header.iter().filter(|(k, _)| k.as_str() != "__metadata__");
    let (Some((_, tensor)), None) = (tensors.next(), tensors.next()) else { return Err("Expected one F32 or F16 embedding matrix".into()) };
    let tensor: Tensor = serde_json::from_value(tensor.clone()).map_err(|_| corrupt("the tensor is not described"))?;
    let (half, width) = match tensor.dtype.as_deref() {
        Some("F32") => (false, 4usize),
        Some("F16") => (true, 2usize),
        _ => return Err("Expected one F32 or F16 embedding matrix".into()),
    };
    let (Some([rows, dim]), Some([from, to])) = (tensor.shape.as_deref(), tensor.data_offsets.as_deref()) else { return Err("Expected one F32 or F16 embedding matrix".into()) };
    let (rows, dim) = (*rows, *dim);
    let row_bytes = dim * width;
    let base = 8 + size + from;
    if to.checked_sub(*from) != Some((rows * row_bytes) as u64) || 8 + size + to > len {
        return Err(corrupt("the embedding matrix does not match its header"));
    }
    Ok(Layout { rows, dim, half, base, row_bytes })
}

/// Fill `buf` from `offset`, without a memory map and without moving a shared position.
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < buf.len() {
            let n = file.seek_read(&mut buf[done..], offset + done as u64)?;
            if n == 0 {
                return Err(std::io::ErrorKind::UnexpectedEof.into());
            }
            done += n;
        }
        Ok(())
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_exact_at(buf, offset)
    }
}

/// An IEEE half float as a single.
fn half_to_f32(bits: u16) -> f32 {
    let sign = ((bits >> 15) & 1) as u32;
    let exp = ((bits >> 10) & 0x1f) as u32;
    let frac = (bits & 0x3ff) as u32;
    let out = match (exp, frac) {
        (0, 0) => sign << 31,
        (0, _) => {
            // A subnormal half is a normal single.
            let shift = frac.leading_zeros() - 21;
            (sign << 31) | ((127 - 15 + 1 - shift) << 23) | (((frac << shift) & 0x3ff) << 13)
        }
        (31, 0) => (sign << 31) | 0x7f80_0000,
        (31, _) => (sign << 31) | 0x7fc0_0000 | (frac << 13),
        _ => (sign << 31) | ((exp + 127 - 15) << 23) | (frac << 13),
    };
    f32::from_bits(out)
}

/// The most recently used rows, unpacked.
#[derive(Default)]
struct RowCache {
    rows: HashMap<u32, (Box<[f32]>, u64)>,
    tick: u64,
}

impl RowCache {
    fn add_to(&mut self, file: &File, layout: &Layout, index: u32, total: &mut [f64]) -> std::io::Result<()> {
        self.tick += 1;
        if let Some((row, used)) = self.rows.get_mut(&index) {
            *used = self.tick;
            for (t, v) in total.iter_mut().zip(row.iter()) {
                *t += *v as f64;
            }
            return Ok(());
        }
        let mut raw = vec![0u8; layout.row_bytes];
        read_at(file, &mut raw, layout.base + index as u64 * layout.row_bytes as u64)?;
        let row: Box<[f32]> = if layout.half {
            raw.as_chunks::<2>().0.iter().map(|b| half_to_f32(u16::from_le_bytes(*b))).collect()
        } else {
            raw.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect()
        };
        for (t, v) in total.iter_mut().zip(row.iter()) {
            *t += *v as f64;
        }
        if self.rows.len() >= ROW_CACHE
            && let Some(oldest) = self.rows.iter().min_by_key(|(_, (_, used))| *used).map(|(k, _)| *k)
        {
            self.rows.remove(&oldest);
        }
        self.rows.insert(index, (row, self.tick));
        Ok(())
    }
}

/// The model in use: its tokenizer, where its matrix is, and the file and rows that go when it has been idle.
struct Loaded {
    identity: Identity,
    folder: PathBuf,
    tokenizer: Tokenizer,
    layout: Layout,
    file: Option<File>,
    cache: RowCache,
    used: Instant,
}

impl Loaded {
    fn open(folder: PathBuf, identity: Identity) -> Result<Loaded, String> {
        let bytes = std::fs::read(folder.join("tokenizer.json")).map_err(|e| format!("tokenizer.json cannot be read: {e}"))?;
        let tokenizer = Tokenizer::parse(&bytes)?;
        let file = File::open(folder.join("model.safetensors")).map_err(|e| format!("model.safetensors cannot be read: {e}"))?;
        let layout = layout_of(&file)?;
        if tokenizer.vocab.values().any(|id| *id as usize >= layout.rows) {
            return Err("The model file is damaged: the vocabulary is larger than the embedding matrix".into());
        }
        Ok(Loaded { identity, folder, tokenizer, layout, file: Some(file), cache: RowCache::default(), used: Instant::now() })
    }

    /// The unit-length mean of the text's piece rows, or None when no piece is known.
    fn embed(&mut self, text: &str) -> std::io::Result<Option<Vec<f32>>> {
        let ids = self.tokenizer.tokenize(text);
        if ids.is_empty() {
            return Ok(None);
        }
        if self.file.is_none() {
            self.file = Some(File::open(self.folder.join("model.safetensors"))?);
        }
        let file = self.file.as_ref().expect("the file was just opened");
        let mut total = vec![0f64; self.layout.dim];
        for id in ids {
            self.cache.add_to(file, &self.layout, id, &mut total)?;
        }
        let norm = total.iter().map(|v| v * v).sum::<f64>().sqrt();
        Ok((norm > 0.0).then(|| total.iter().map(|v| (v / norm) as f32).collect()))
    }
}

// ---- the model as the index uses it --------------------------------------------------------------------------------

/// Why no vector could be made.
#[derive(Clone, Debug, PartialEq)]
pub enum Unavailable {
    /// No verified model is installed (or its marker was just removed).
    Absent,
    /// The model is installed but cannot be read.
    Broken(String),
}

pub struct Embedded {
    /// The model that made the vectors.
    pub identity: Identity,
    /// One vector per text; None for a text with no piece the model knows.
    pub vectors: Vec<Option<Vec<f32>>>,
}

/// Vectors the index holds at most (about 200 MB of matrix at 512 dimensions); a page that would go past it has none.
pub const MAX_VECTORS: i64 = 100_000;

/// What `index_status` says about meaning search.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `missing` (no model installed), `building` (pages are still being read), `ready`, or `error` (installed but
    /// unreadable).
    pub state: &'static str,
    pub model: Option<String>,
    pub error: Option<String>,
    /// The vector budget is spent, so some pages have no vector.
    pub full: bool,
}

#[derive(Default)]
struct Inner {
    /// The store `loaded` and `failed` belong to. Another store starts both afresh, so a damaged model in one store does
    /// not follow the user to a good copy in another that has the same identity.
    root: Option<PathBuf>,
    loaded: Option<Loaded>,
    /// A model that could not be loaded, by identity: not tried again until the model changes.
    failed: Option<(Identity, String)>,
}

/// The model and everything that follows it: shared by the writer thread and the commands.
pub struct Semantic {
    root: Mutex<Option<PathBuf>>,
    inner: Mutex<Inner>,
    idle: Duration,
    /// The model of the last pass that gave every page a vector; None while some page may lack one.
    pub(super) pass: Mutex<Option<String>>,
    /// Vectors in the index, or -1 when it has to be counted.
    pub(super) vectors: AtomicI64,
    /// Whether a page was left without vectors because `MAX_VECTORS` was reached.
    pub(super) full: AtomicBool,
    /// Texts embedded since start (tests and measurements).
    texts: AtomicU64,
    pub matrix: super::matrix::Matrix,
}

impl Default for Semantic {
    fn default() -> Self {
        Semantic::new(IDLE)
    }
}

impl Semantic {
    pub fn new(idle: Duration) -> Semantic {
        Semantic { root: Mutex::new(None), inner: Mutex::new(Inner::default()), idle, pass: Mutex::new(None), vectors: AtomicI64::new(-1), full: AtomicBool::new(false), texts: AtomicU64::new(0), matrix: Default::default() }
    }

    /// The Living Memory store whose `.models` folder holds the model.
    pub fn set_root(&self, root: Option<PathBuf>) {
        *self.root.lock().unwrap_or_else(|e| e.into_inner()) = root;
        // The model of the old store is let go now; `embed` and `failure` also compare stores, for a call already running.
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.root != self.root() {
            *inner = Inner::default();
        }
    }

    pub(super) fn root(&self) -> Option<PathBuf> {
        self.root.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The verified model now installed, which may have changed since the last call.
    pub fn identity(&self) -> Option<Identity> {
        installed(&self.root()?)
    }

    /// Whether the model could be read the last time it was tried, for a model that is installed.
    pub fn failure(&self, identity: &Identity) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.failed.as_ref().filter(|(id, _)| id == identity && inner.root == self.root()).map(|(_, why)| why.clone())
    }

    /// Embed `texts` with the model installed now. The marker is read first: without it nothing is used and the file is
    /// let go; with another model than the one loaded, the new one is loaded.
    pub fn embed(&self, texts: &[&str]) -> Result<Embedded, Unavailable> {
        let Some(root) = self.root() else { return Err(Unavailable::Absent) };
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.root.as_ref() != Some(&root) {
            *inner = Inner { root: Some(root.clone()), ..Inner::default() };
        }
        let Some(identity) = installed(&root) else {
            inner.loaded = None;
            inner.failed = None;
            return Err(Unavailable::Absent);
        };
        if inner.loaded.as_ref().is_none_or(|l| l.identity != identity) {
            inner.loaded = None;
            if let Some((id, why)) = &inner.failed
                && *id == identity
            {
                return Err(Unavailable::Broken(why.clone()));
            }
            match Loaded::open(model_dir(&root), identity.clone()) {
                Ok(loaded) => {
                    inner.failed = None;
                    inner.loaded = Some(loaded);
                }
                Err(why) => {
                    inner.failed = Some((identity, why.clone()));
                    return Err(Unavailable::Broken(why));
                }
            }
        }
        let loaded = inner.loaded.as_mut().expect("the model is loaded");
        loaded.used = Instant::now();
        self.texts.fetch_add(texts.len() as u64, Ordering::Relaxed);
        let mut vectors = Vec::with_capacity(texts.len());
        for text in texts {
            match loaded.embed(text) {
                Ok(vector) => vectors.push(vector),
                Err(e) => {
                    // The file may have been replaced under us: let go of it, so the next batch starts from the marker.
                    inner.loaded = None;
                    return Err(Unavailable::Broken(format!("The model file cannot be read: {e}")));
                }
            }
        }
        Ok(Embedded { identity, vectors })
    }

    /// Where meaning search stands: no model, a model still being read into the index, a model that is ready, or one that
    /// cannot be read.
    pub fn status(&self) -> Status {
        let full = self.full.load(Ordering::Relaxed);
        let Some(identity) = self.identity() else { return Status { state: "missing", model: None, error: None, full } };
        let model = Some(identity.name.clone());
        if let Some(why) = self.failure(&identity) {
            return Status { state: "error", model, error: Some(why), full };
        }
        let done = self.pass.lock().unwrap_or_else(|e| e.into_inner()).as_deref() == Some(identity.key().as_str());
        Status { state: if done { "ready" } else { "building" }, model, error: None, full }
    }

    /// How long the model file stays open without use.
    pub fn idle(&self) -> Duration {
        self.idle
    }

    /// How long the matrix stays in memory without a search or a Related query: 20 times the model's idle time (10 minutes).
    pub fn matrix_idle(&self) -> Duration {
        self.idle * 20
    }

    /// The vectors in the index (counted once, then followed by the writer).
    pub fn vector_count(&self, conn: &Connection) -> rusqlite::Result<i64> {
        let held = self.vectors.load(Ordering::Relaxed);
        if held >= 0 {
            return Ok(held);
        }
        let n: i64 = conn.query_row("SELECT count(*) FROM vectors", [], |r| r.get(0))?;
        self.vectors.store(n, Ordering::Relaxed);
        Ok(n)
    }

    /// The writer added or removed vectors.
    pub fn adjust_vectors(&self, delta: i64) {
        let _ = self.vectors.try_update(Ordering::Relaxed, Ordering::Relaxed, |n| (n >= 0).then(|| (n + delta).max(0)));
    }

    /// Some page may be without vectors again: the next check runs a pass.
    pub fn forget_pass(&self) {
        *self.pass.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Let go of the model file and the cached rows when nothing has used them for the idle time.
    pub fn release_if_idle(&self) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(loaded) = inner.loaded.as_mut()
            && loaded.used.elapsed() >= self.idle
        {
            loaded.file = None;
            loaded.cache = RowCache::default();
        }
    }

    /// Whether the model file is open now (tests).
    #[cfg(test)]
    pub fn file_is_open(&self) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).loaded.as_ref().is_some_and(|l| l.file.is_some())
    }

    /// How many texts have been embedded since start.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn embedded_texts(&self) -> u64 {
        self.texts.load(Ordering::Relaxed)
    }

    /// Cached rows and their approximate size in bytes.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn cache_size(&self) -> (usize, usize) {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.loaded.as_ref().map_or((0, 0), |l| (l.cache.rows.len(), l.cache.rows.len() * l.layout.dim * 4))
    }
}

#[cfg(test)]
pub(super) mod fixture {
    //! A tiny model on disk: five words in a four-dimensional space, laid out as Living Memory installs it.
    use super::*;

    pub const VOCAB: [(&str, u32); 12] =
        [("[UNK]", 0), ("alpha", 1), ("beta", 2), ("gamma", 3), ("un", 4), ("##known", 5), ("##s", 6), ("!", 7), ("play", 8), ("##ing", 9), ("cafe", 10), ("日", 11)];

    pub fn rows() -> Vec<[f32; 4]> {
        vec![
            [0.0, 0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
            [0.5, 0.5, 0.0, 0.0],
            [0.0, 0.5, 0.5, 0.0],
            [0.25, 0.0, 0.0, 0.75],
            [0.5, 0.0, 0.5, 0.0],
            [0.0, 0.5, 0.0, 0.5],
            [1.0, 1.0, 1.0, 1.0],
            [-1.0, 0.0, 0.0, 0.0],
        ]
    }

    pub fn tokenizer_json(extra_normalizer: &str) -> String {
        let vocab: Vec<String> = VOCAB.iter().map(|(w, i)| format!("{}:{}", serde_json::to_string(w).unwrap(), i)).collect();
        format!(
            r###"{{"model":{{"type":"WordPiece","vocab":{{{}}},"unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}},
            "normalizer":{{"type":"BertNormalizer","clean_text":true,"handle_chinese_chars":true,"strip_accents":null,"lowercase":true{extra_normalizer}}},
            "pre_tokenizer":{{"type":"BertPreTokenizer"}}}}"###,
            vocab.join(",")
        )
    }

    /// A tokenizer whose words are `w1` to `w{n-1}`, with the ids 1 to n-1.
    pub fn plain_tokenizer(n: usize) -> String {
        let vocab: Vec<String> = (1..n).map(|i| format!("\"w{i}\":{i}")).collect();
        format!(
            r#"{{"model":{{"type":"WordPiece","vocab":{{"[UNK]":0,{}}},"unk_token":"[UNK]"}},"normalizer":{{"type":"BertNormalizer"}},"pre_tokenizer":{{"type":"BertPreTokenizer"}}}}"#,
            vocab.join(",")
        )
    }

    pub fn safetensors(rows: &[[f32; 4]]) -> Vec<u8> {
        let header = format!(r#"{{"__metadata__":{{"format":"pt"}},"embeddings":{{"dtype":"F32","shape":[{},4],"data_offsets":[0,{}]}}}}"#, rows.len(), rows.len() * 16);
        let mut out = (header.len() as u64).to_le_bytes().to_vec();
        out.extend(header.as_bytes());
        for row in rows {
            for v in row {
                out.extend(v.to_le_bytes());
            }
        }
        out
    }

    /// Install the tiny model in the store at `root` the way `semantic install` leaves it: the files, then the marker.
    pub fn install(root: &Path, rows: &[[f32; 4]], hash: &str) {
        let folder = model_dir(root);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("tokenizer.json"), tokenizer_json("")).unwrap();
        std::fs::write(folder.join("model.safetensors"), safetensors(rows)).unwrap();
        std::fs::write(folder.join(MARKER), format!(r#"{{"model":"{MODEL}","files":{{"model.safetensors":"{hash}"}}}}"#)).unwrap();
    }

    pub fn remove(root: &Path) {
        let _ = std::fs::remove_file(model_dir(root).join(MARKER));
    }

    pub fn tokenizer() -> Tokenizer {
        Tokenizer::parse(tokenizer_json("").as_bytes()).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::*;
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hm-semantic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ids(text: &str) -> Vec<u32> {
        tokenizer().tokenize(text)
    }

    #[test]
    fn text_is_lowercased_accents_are_dropped_and_control_characters_vanish() {
        let t = tokenizer();
        assert_eq!(t.normalize("CAFÉ"), "cafe");
        assert_eq!(t.normalize("ca\u{0}f\u{200b}e\u{fffd}"), "cafe");
        // Tab, newline and every kind of space are spaces.
        assert_eq!(t.normalize("a\tb\nc\u{a0}d\u{3000}e\u{2028}f"), "a b c d e f");
        // Combining marks go after decomposition: "e" with a combining acute is "e".
        assert_eq!(t.normalize("cafe\u{301}"), "cafe");
        // Final sigma follows Unicode's rule, as Python's lower() does.
        assert_eq!(t.normalize("ΟΔΟΣ"), "οδος");
        assert_eq!(ids("CAFÉ"), [10]);
        assert_eq!(ids("Alpha\u{200b} Beta\u{7}"), [1, 2]);
    }

    #[test]
    fn chinese_characters_are_spaced_out_and_punctuation_is_split() {
        let t = tokenizer();
        assert_eq!(t.normalize("a日b"), "a 日 b");
        assert_eq!(ids("alpha日beta"), [1, 11, 2]);
        // Punctuation is a word of its own, ASCII symbols included.
        assert_eq!(ids("alpha!beta"), [1, 7, 2]);
        assert_eq!(Tokenizer::words("a,b.c  d"), ["a", ",", "b", ".", "c", "d"]);
        assert_eq!(Tokenizer::words("x+y=z"), ["x", "+", "y", "=", "z"]);
        // Unicode punctuation (a general category) is split too.
        assert_eq!(Tokenizer::words("a\u{2014}b\u{ab}c"), ["a", "\u{2014}", "b", "\u{ab}", "c"]);
    }

    #[test]
    fn wordpiece_takes_the_longest_match_and_continues_with_the_prefix() {
        assert_eq!(ids("alphas"), [1, 6]);
        assert_eq!(ids("unknown"), [4, 5]);
        assert_eq!(ids("playing"), [8, 9]);
        // "unknowns" is un + ##known + ##s.
        assert_eq!(ids("unknowns"), [4, 5, 6]);
    }

    #[test]
    fn a_word_with_an_unmatched_part_is_one_unknown_piece_and_unknown_pieces_are_dropped() {
        // "alphaz" has no piece for "z": the whole word is unknown, so only the others remain.
        assert_eq!(ids("alpha alphaz beta"), [1, 2]);
        assert_eq!(ids("zzz qqq"), Vec::<u32>::new());
    }

    #[test]
    fn a_word_over_a_hundred_characters_is_unknown_and_one_of_exactly_a_hundred_is_matched() {
        let t = tokenizer();
        // "alpha" and 95 times "##s" is 100 characters: matched piece by piece. One more character is over the limit, so
        // the whole word is unknown although every part of it is in the vocabulary.
        assert_eq!(t.tokenize(&format!("alpha{}", "s".repeat(95))).len(), 96);
        assert_eq!(t.tokenize(&format!("alpha{} beta", "s".repeat(96))), [2]);
        // The limit counts characters, not bytes: 100 two-byte letters are a word, just not a known one.
        assert_eq!(t.tokenize(&format!("{} beta", "é".repeat(100))), [2]);
    }

    #[test]
    fn at_most_512_tokens_are_kept_and_unknown_ones_count_before_they_are_dropped() {
        let t = tokenizer();
        let many = "alpha ".repeat(700);
        assert_eq!(t.tokenize(&many).len(), 512);
        // A word of 96 pieces, ten times: the cap cuts the sixth word, not only the loop's check before a word.
        let long = format!("alpha{}", "s".repeat(95));
        assert_eq!(t.tokenize(&[long.as_str(); 10].join(" ")).len(), 512);
        // 600 unknown words first: the cap is reached before any known word, as in Python.
        let text = format!("{}alpha", "zzz ".repeat(600));
        assert_eq!(t.tokenize(&text), Vec::<u32>::new());
        // Fewer unknown words leave room: 100 unknown, then 500 known -> 412 known kept (512 - 100).
        let text = format!("{}{}", "zzz ".repeat(100), "alpha ".repeat(500));
        assert_eq!(t.tokenize(&text).len(), 412);
    }

    #[test]
    fn a_vector_is_the_normalised_mean_of_its_rows_in_double_precision() {
        let root = scratch();
        install(&root, &rows(), "h1");
        let semantic = Semantic::new(Duration::from_secs(30));
        semantic.set_root(Some(root.clone()));
        let got = semantic.embed(&["alpha beta", "", "zzz", "alpha"]).unwrap();
        let v = got.vectors[0].as_ref().unwrap();
        let k = (0.5f64).sqrt() as f32;
        assert_eq!(v.len(), 4);
        assert!((v[0] - k).abs() < 1e-7 && (v[1] - k).abs() < 1e-7 && v[2] == 0.0 && v[3] == 0.0, "{v:?}");
        // Nothing the model knows: no vector.
        assert!(got.vectors[1].is_none() && got.vectors[2].is_none());
        assert_eq!(got.vectors[3].as_deref(), Some(&[1.0, 0.0, 0.0, 0.0][..]));
        // Unit length even for rows that are not.
        let v = semantic.embed(&["cafe"]).unwrap().vectors.remove(0).unwrap();
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
        assert_eq!(got.identity, Identity { name: MODEL.into(), hash: "h1".into() });
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_half_float_matrix_reads_as_singles() {
        for (bits, want) in [(0x3c00u16, 1.0f32), (0xc000, -2.0), (0x3800, 0.5), (0x0000, 0.0), (0x7c00, f32::INFINITY), (0x0001, 5.960_464_5e-8), (0x03ff, 6.097_555e-5), (0x7bff, 65504.0)] {
            assert_eq!(half_to_f32(bits), want, "{bits:#06x}");
        }
        assert!(half_to_f32(0x7e00).is_nan());
        // A whole F16 file: three rows of two values; "w1" is (1, 0) and "w2" is (0, 1).
        let root = scratch();
        let folder = model_dir(&root);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("tokenizer.json"), plain_tokenizer(3)).unwrap();
        let header = r#"{"e":{"dtype":"F16","shape":[3,2],"data_offsets":[0,12]}}"#;
        let mut file = (header.len() as u64).to_le_bytes().to_vec();
        file.extend(header.as_bytes());
        for bits in [0u16, 0, 0x3c00, 0, 0, 0x3c00] {
            file.extend(bits.to_le_bytes());
        }
        std::fs::write(folder.join("model.safetensors"), &file).unwrap();
        std::fs::write(folder.join(MARKER), r#"{"files":{"model.safetensors":"x"}}"#).unwrap();
        let semantic = Semantic::new(IDLE);
        semantic.set_root(Some(root.clone()));
        let v = semantic.embed(&["w1 w2"]).unwrap().vectors.remove(0).unwrap();
        let k = (0.5f64).sqrt() as f32;
        assert_eq!(v, [k, k]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_model_that_cannot_be_read_says_why_and_is_not_tried_again_until_it_changes() {
        let root = scratch();
        install(&root, &rows(), "h1");
        let folder = model_dir(&root);
        let semantic = Semantic::new(IDLE);
        semantic.set_root(Some(root.clone()));
        // Another kind of tokenizer.
        std::fs::write(folder.join("tokenizer.json"), tokenizer_json("").replace("WordPiece", "BPE")).unwrap();
        let err = semantic.embed(&["alpha"]).err().unwrap();
        assert!(matches!(&err, Unavailable::Broken(why) if why.contains("WordPiece")), "{err:?}");
        assert!(semantic.failure(&semantic.identity().unwrap()).is_some());
        // A matrix whose size does not match its header.
        std::fs::write(folder.join("tokenizer.json"), tokenizer_json("")).unwrap();
        install(&root, &rows(), "h2");
        let mut bytes = std::fs::read(folder.join("model.safetensors")).unwrap();
        bytes.truncate(bytes.len() - 8);
        std::fs::write(folder.join("model.safetensors"), bytes).unwrap();
        assert!(matches!(semantic.embed(&["alpha"]), Err(Unavailable::Broken(why)) if why.contains("damaged")));
        // Two matrices are not a model this reader can use.
        let header = r#"{"a":{"dtype":"F32","shape":[1,1],"data_offsets":[0,4]},"b":{"dtype":"F32","shape":[1,1],"data_offsets":[4,8]}}"#;
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header.as_bytes());
        bytes.extend([0u8; 8]);
        install(&root, &rows(), "h3");
        std::fs::write(folder.join("model.safetensors"), bytes).unwrap();
        assert!(matches!(semantic.embed(&["alpha"]), Err(Unavailable::Broken(why)) if why.contains("one F32 or F16")));
        // A vocabulary with an id past the matrix.
        install(&root, &rows()[..3], "h4");
        assert!(matches!(semantic.embed(&["alpha"]), Err(Unavailable::Broken(why)) if why.contains("vocabulary")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_model_failure_does_not_follow_the_user_to_another_store() {   // NOTES-8
        let (bad, good) = (scratch(), scratch());
        install(&bad, &rows(), "h1");
        install(&good, &rows(), "h1");
        let mut bytes = std::fs::read(model_dir(&bad).join("model.safetensors")).unwrap();
        bytes.truncate(bytes.len() - 8);
        std::fs::write(model_dir(&bad).join("model.safetensors"), bytes).unwrap();
        let semantic = Semantic::new(IDLE);
        semantic.set_root(Some(bad.clone()));
        assert!(matches!(semantic.embed(&["alpha"]), Err(Unavailable::Broken(_))));
        assert!(semantic.failure(&semantic.identity().unwrap()).is_some());
        // The same model identity in a store whose copy is sound.
        semantic.set_root(Some(good.clone()));
        assert!(semantic.failure(&semantic.identity().unwrap()).is_none());
        assert!(semantic.embed(&["alpha"]).is_ok());
        // Back to the damaged store: it is tried afresh and fails again, and the good copy is not kept as loaded.
        semantic.set_root(Some(bad.clone()));
        assert!(matches!(semantic.embed(&["alpha"]), Err(Unavailable::Broken(_))));
        std::fs::remove_dir_all(&bad).unwrap();
        std::fs::remove_dir_all(&good).unwrap();
    }

    #[test]
    fn the_model_is_used_only_while_its_marker_is_there_and_a_changed_model_is_loaded_again() {
        let root = scratch();
        let semantic = Semantic::new(IDLE);
        assert_eq!(semantic.embed(&["alpha"]).err(), Some(Unavailable::Absent), "no store yet");
        semantic.set_root(Some(root.clone()));
        assert_eq!(semantic.embed(&["alpha"]).err(), Some(Unavailable::Absent), "no model");
        assert!(semantic.identity().is_none());
        install(&root, &rows(), "h1");
        let first = semantic.embed(&["alpha"]).unwrap();
        assert_eq!((first.identity.hash.as_str(), first.vectors[0].clone()), ("h1", Some(vec![1.0, 0.0, 0.0, 0.0])));
        assert!(semantic.file_is_open());
        // Install replaces the model: the next batch reads the new rows and says which model made them.
        let mut changed = rows();
        changed[1] = [0.0, 1.0, 0.0, 0.0];
        install(&root, &changed, "h2");
        let second = semantic.embed(&["alpha"]).unwrap();
        assert_eq!((second.identity.hash.as_str(), second.vectors[0].clone()), ("h2", Some(vec![0.0, 1.0, 0.0, 0.0])));
        // Remove deletes the marker first: nothing is used and the file is let go at once.
        remove(&root);
        assert_eq!(semantic.embed(&["alpha"]).err(), Some(Unavailable::Absent));
        assert!(!semantic.file_is_open());
        // And it comes back without a restart.
        install(&root, &rows(), "h1");
        assert!(semantic.embed(&["alpha"]).is_ok());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_file_is_closed_after_the_idle_time_and_opened_again_by_the_next_use() {
        let root = scratch();
        install(&root, &rows(), "h1");
        let semantic = Semantic::new(Duration::from_millis(30));
        semantic.set_root(Some(root.clone()));
        semantic.embed(&["alpha beta"]).unwrap();
        assert!(semantic.file_is_open() && semantic.cache_size().0 == 2);
        semantic.release_if_idle();
        assert!(semantic.file_is_open(), "not idle yet");
        std::thread::sleep(Duration::from_millis(60));
        semantic.release_if_idle();
        assert!(!semantic.file_is_open());
        assert_eq!(semantic.cache_size().0, 0);
        // The file can be deleted now, which is what `semantic remove` does on Windows.
        std::fs::remove_file(model_dir(&root).join("model.safetensors")).unwrap();
        install(&root, &rows(), "h1");
        assert!(semantic.embed(&["alpha"]).unwrap().vectors[0].is_some());
        assert!(semantic.file_is_open());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_row_cache_is_bounded() {
        let root = scratch();
        let many: Vec<[f32; 4]> = (0..2000).map(|i| [1.0, i as f32, 0.0, 0.0]).collect();
        let folder = model_dir(&root);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("tokenizer.json"), plain_tokenizer(2000)).unwrap();
        std::fs::write(folder.join("model.safetensors"), safetensors(&many)).unwrap();
        std::fs::write(folder.join(MARKER), r#"{"files":{"model.safetensors":"x"}}"#).unwrap();
        let semantic = Semantic::new(IDLE);
        semantic.set_root(Some(root.clone()));
        // Every text holds at most 512 tokens, so 1,999 different words take several texts.
        let words: Vec<String> = (1..2000).map(|i| format!("w{i}")).collect();
        for chunk in words.chunks(400) {
            semantic.embed(&[&chunk.join(" ")]).unwrap();
        }
        assert_eq!(semantic.cache_size().0, ROW_CACHE);
        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- gated tests against Living Memory itself ---------------------------------------------------------------------
    //
    // Both run only when `HIVEMIND_TEST_LM_SCRIPT` (the path of `living_memory.py`) and `HIVEMIND_TEST_MODEL_DIR` (a folder
    // with the three model files) are set. Each makes a temporary store, binds a domain in it and installs the model there
    // with `semantic install --from`; nothing here touches a real store.

    fn gate() -> Option<(PathBuf, PathBuf)> {
        let script = PathBuf::from(std::env::var("HIVEMIND_TEST_LM_SCRIPT").ok()?);
        let model = PathBuf::from(std::env::var("HIVEMIND_TEST_MODEL_DIR").ok()?);
        Some((script, model))
    }

    fn python() -> std::process::Command {
        #[cfg(windows)]
        {
            let mut cmd = std::process::Command::new("py");
            cmd.arg("-3");
            cmd
        }
        #[cfg(not(windows))]
        std::process::Command::new("python3")
    }

    /// Run `living_memory.py --json --root <store> <args>`; the reply as JSON.
    fn lm(script: &Path, store: &Path, args: &[&str]) -> (bool, serde_json::Value) {
        let out = python().arg(script).args(["--json", "--root"]).arg(store).args(args).output().expect("python runs");
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let json = serde_json::from_str(&text).unwrap_or_else(|_| panic!("not JSON: {text} {}", String::from_utf8_lossy(&out.stderr)));
        (out.status.success(), json)
    }

    /// A temporary store with a bound domain and the model installed by `semantic install --from`.
    fn lm_store(script: &Path, model: &Path) -> PathBuf {
        let dir = scratch();
        let (store, project) = (dir.join("store"), dir.join("project"));
        std::fs::create_dir_all(&store).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        let (ok, reply) = lm(script, &store, &["bind", "testdom", project.to_str().unwrap()]);
        assert!(ok, "{reply}");
        let (ok, reply) = lm(script, &store, &["semantic", "install", "--from", model.to_str().unwrap()]);
        assert!(ok && reply["enabled"] == true, "{reply}");
        store
    }

    /// The 26 texts of spike S5 (`docs/notes-studio/spikes/s5-model2vec.md`).
    fn corpus() -> Vec<String> {
        let mut texts: Vec<String> = [
            "The quick brown fox jumps over the lazy dog while reading about semantic search.",
            "Café naïve résumé über façade crème brûlée Ångström",
            "ΟΔΥΣΣΕΥΣ Καλημέρα κόσμε ὁ λόγος ΣΑΣ",
            "Привет, мир! Это проверка поиска по смыслу.",
            "你好，世界。这是一个语义搜索的测试。",
            "こんにちは世界 カタカナ ﾊﾝｶｸｶﾀｶﾅ 日本語の検索",
            "안녕하세요 세계 의미 검색 테스트",
            "Great job 😀🎉 team 🇺🇸 ship it 🚀",
            "Wait... what?!?! --- (really) [yes] {no} ;;; ::: ,,, ### ***",
            "bell\u{7} null\u{0} esc\u{1b} tab\t newline\n cr\r end",
            "bad\u{fffd}char zero\u{200b}width non\u{a0}breaking",
            "e\u{301} a\u{300}\u{323} n\u{303} Z\u{30c} o\u{308}",
            "İstanbul Straße ﬁnal ﬂow ǅ",
            "# Title\n- [ ] task item\n```rust\nfn main() {}\n```\n**bold** _italic_ [link](https://example.com)",
            "https://example.com/path?q=1&b=2#frag C:\\Users\\name\\Documents\\file.txt",
            "Version 3.14.159 released 2026-11-22T09:30:00Z for 1,234,567 users at $19.99",
            "camelCaseIdentifier snake_case_identifier kebab-case-identifier HTTPServer2Go",
            "",
            "   \t\n  ",
            "a\u{3000}b\u{2028}c\u{2029}d",
            "مرحبا بالعالم שלום עולם",
            "नमस्ते दुनिया สวัสดีชาวโลก",
            "∑ ∫ √ ≈ ≠ ≤ ≥ € £ ¥ ₹ ± × ÷ x² y³",
            "Mixed 日本語 and English ünïcödé 123 !!!",
        ]
        .iter()
        .map(|t| t.to_string())
        .collect();
        // A 150-character word and 700 tokens.
        texts.push(format!("before {} after", "a".repeat(150)));
        texts.push("the quick brown fox ".repeat(175));
        texts
    }

    #[test]
    fn token_ids_and_vectors_match_living_memorys_python_reader() {
        let Some((script, model)) = gate() else {
            println!("skipped: HIVEMIND_TEST_LM_SCRIPT and HIVEMIND_TEST_MODEL_DIR are not set");
            return;
        };
        let store = lm_store(&script, &model);
        let folder = model_dir(&store);
        let texts = corpus();
        let corpus_file = store.parent().unwrap().join("corpus.json");
        std::fs::write(&corpus_file, serde_json::to_string(&texts).unwrap()).unwrap();
        let repo = script.parent().unwrap();
        // `-I`: no environment, no current folder; the repository goes on the path by hand.
        let code = "import sys, json\nsys.path.insert(0, sys.argv[1])\nfrom core import semantic\nm = semantic.Model(sys.argv[2])\nout = []\nfor t in json.load(open(sys.argv[3], encoding='utf-8')):\n    v = m.embed(t)\n    out.append({'ids': m.tokenize(t), 'vec': list(v) if v is not None else None})\nm.close()\nsys.stdout.write(json.dumps(out))\n";
        let out = python().args(["-I", "-c", code]).arg(repo).arg(&folder).arg(&corpus_file).output().expect("python runs");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let python_says: Vec<serde_json::Value> = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(python_says.len(), texts.len());

        let tokenizer = Tokenizer::parse(&std::fs::read(folder.join("tokenizer.json")).unwrap()).unwrap();
        let semantic = Semantic::new(IDLE);
        semantic.set_root(Some(store.clone()));
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        let rust_says = semantic.embed(&refs).unwrap();
        let mut worst = 1.0f64;
        for (i, text) in texts.iter().enumerate() {
            let ids: Vec<u32> = python_says[i]["ids"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u32).collect();
            assert_eq!(tokenizer.tokenize(text), ids, "token ids of text {i}: {text:?}");
            match (&python_says[i]["vec"], &rust_says.vectors[i]) {
                (serde_json::Value::Null, None) => {}
                (py, Some(ours)) if !py.is_null() => {
                    let theirs: Vec<f64> = py.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
                    assert_eq!(theirs.len(), ours.len());
                    let cosine: f64 = theirs.iter().zip(ours).map(|(a, b)| a * *b as f64).sum();
                    worst = worst.min(cosine);
                    assert!(cosine >= 0.99999, "text {i} {text:?}: cosine {cosine}");
                }
                (py, ours) => panic!("text {i} {text:?}: Python gave {py}, Hivemind gave {ours:?}"),
            }
        }
        println!("parity: {} texts, identical token ids, worst cosine {worst:.10}", texts.len());
        std::fs::remove_dir_all(store.parent().unwrap()).ok();
    }

    #[test]
    fn semantic_install_and_remove_succeed_while_hivemind_has_the_model_open() {
        let Some((script, model)) = gate() else {
            println!("skipped: HIVEMIND_TEST_LM_SCRIPT and HIVEMIND_TEST_MODEL_DIR are not set");
            return;
        };
        let store = lm_store(&script, &model);
        let semantic = Semantic::new(IDLE);
        semantic.set_root(Some(store.clone()));
        assert!(semantic.embed(&["hello world"]).is_ok());
        assert!(semantic.file_is_open(), "Hivemind has the model file open");
        // Install again over the model Hivemind is reading.
        let (ok, reply) = lm(&script, &store, &["semantic", "install", "--from", model.to_str().unwrap()]);
        assert!(ok && reply["enabled"] == true, "install while the model is open: {reply}");
        assert!(semantic.embed(&["hello world"]).is_ok(), "the new model is read at once");
        // Remove while it is open again.
        let (ok, reply) = lm(&script, &store, &["semantic", "remove"]);
        assert!(ok && reply["removed"] == true, "remove while the model is open: {reply}");
        println!("remove reply: leftover = {}", reply.get("leftover").map_or("none".to_string(), |l| l.to_string()));
        assert!(reply.get("leftover").is_none(), "nothing was left behind: {reply}");
        assert_eq!(semantic.embed(&["hello world"]).err(), Some(Unavailable::Absent), "the model is no longer used");
        assert!(!semantic.file_is_open());
        // And it works again after an install.
        let (ok, reply) = lm(&script, &store, &["semantic", "install", "--from", model.to_str().unwrap()]);
        assert!(ok && reply["enabled"] == true, "{reply}");
        assert!(semantic.embed(&["hello world"]).is_ok());
        std::fs::remove_dir_all(store.parent().unwrap()).ok();
    }
}
