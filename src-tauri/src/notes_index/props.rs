//! The tasks and the properties of a Markdown page, for the index (NS-7B). They are read the way Living Memory reads
//! them (`core/docs_index.py`, `tasks` and `properties`), so a saved query or the Tasks list means the same over a folder
//! notebook and a Living Memory notebook: a task is a `- [ ]` or `- [x]` line outside fenced code and the frontmatter, and
//! a property is a flat key of the frontmatter (a list gives one value per item; nested maps are skipped). The fields of a task
//! (`due`, `owner`, `priority`) follow one rule, shared with Living Memory (`core/note_format.py`, `item_fields`) and with
//! `src/features/notes/tasks.ts`; `src/features/notes/fixtures/task_lines.json` holds the cases all three are checked against.

use regex::Regex;
use std::sync::LazyLock;

/// How many tasks and properties one page keeps.
pub const MAX_TASKS: usize = 500;
pub const MAX_PROPS: usize = 50;
/// The text of a task is cut here.
pub const TASK_CHARS: usize = 500;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    /// 1-based line in the file.
    pub line: u32,
    pub done: bool,
    /// What follows the box, at most `TASK_CHARS` characters.
    pub text: String,
    /// `YYYY-MM-DD`: the tail's `due:`, else the first `📅` or `due::` date.
    pub due: Option<String>,
    /// The tail's `owner:` only.
    pub owner: Option<String>,
    /// `highest`, `high`, `medium`, `low` or `lowest`: the tail's `priority:`, else the first Tasks priority emoji.
    pub priority: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prop {
    pub key: String,
    pub value: String,
}

/// The date in `chars` at `at` (after optional spaces): ten characters `dddd-dd-dd`.
fn date_at(chars: &[char], mut at: usize) -> Option<String> {
    while chars.get(at).is_some_and(|c| c.is_whitespace()) {
        at += 1;
    }
    let part = chars.get(at..at + 10)?;
    let shape = part.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == '-' } else { c.is_ascii_digit() });
    shape.then(|| part.iter().collect())
}

/// Whether `value` is a real `YYYY-MM-DD` date (year 1 or later).
fn valid_date(value: &str) -> bool {
    let c: Vec<char> = value.chars().collect();
    let shape = c.len() == 10 && c.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == '-' } else { c.is_ascii_digit() });
    shape && {
        let number = |from: usize, to: usize| value[from..to].parse::<u32>().unwrap_or(0);
        number(0, 4) >= 1 && chrono::NaiveDate::from_ymd_opt(number(0, 4) as i32, number(5, 7), number(8, 10)).is_some()
    }
}

/// The first `📅 date` or `due:: date` of `text` (`due` starts a word); `None` when that date is not a real one.
fn due_form(text: &str) -> Option<String> {
    let c: Vec<char> = text.chars().collect();
    for i in 0..c.len() {
        let after = if c[i] == '\u{1F4C5}' {
            i + 1
        } else if c[i..].starts_with(&['d', 'u', 'e', ':', ':']) && (i == 0 || !(c[i - 1].is_alphanumeric() || c[i - 1] == '_')) {
            i + 5
        } else {
            continue;
        };
        if let Some(date) = date_at(&c, after) {
            return valid_date(&date).then_some(date);
        }
    }
    None
}

const PAIR: &str = r"(?:due|owner|priority)\s*:\s*[^,()]+";
/// The tail of a task: a parenthesis group at the very end that holds only `due`, `owner` and `priority` pairs.
static TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"(?i)\s*\(\s*({PAIR}(?:\s*,\s*{PAIR})*)\s*\)\s*$")).unwrap());

/// The Tasks plugin's priority emojis.
const PRIORITY_EMOJI: [(char, &str); 5] = [('\u{1F53A}', "highest"), ('\u{23EB}', "high"), ('\u{1F53C}', "medium"), ('\u{1F53D}', "low"), ('\u{23EC}', "lowest")];

/// The fields of a task's text, `(due, owner, priority)`. A tail at the very end, `(due: YYYY-MM-DD, owner: NAME, priority: high)`,
/// gives them in any order, with the keys in any case; a bad value is ignored and the first of a repeated key wins. A group
/// holding anything else is plain text. What the tail does not give comes from the text: the due date from the first
/// `📅 YYYY-MM-DD` or `due:: YYYY-MM-DD`, the priority from the first priority emoji. The owner comes from the tail only.
pub fn fields_of(text: &str) -> (Option<String>, Option<String>, Option<String>) {
    let text = text.trim();
    let (mut due, mut owner, mut priority) = (None, None, None);
    let mut rest = text;
    if let Some(tail) = TAIL.captures(text) {
        rest = text[..tail.get(0).map_or(0, |m| m.start())].trim_end();
        let mut seen: Vec<String> = Vec::new();
        for pair in tail[1].split(',') {
            let (key, value) = pair.split_once(':').unwrap_or((pair, ""));
            let key = key.trim().to_lowercase();
            let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
            if seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            match key.as_str() {
                "due" if valid_date(&value) => due = Some(value),
                "owner" => owner = Some(value),
                "priority" if PRIORITY_EMOJI.iter().any(|(_, p)| value.to_lowercase() == *p) => priority = Some(value.to_lowercase()),
                _ => {}
            }
        }
    }
    let due = due.or_else(|| due_form(rest));
    let priority = priority.or_else(|| rest.chars().find_map(|c| PRIORITY_EMOJI.iter().find(|(e, _)| *e == c).map(|(_, p)| p.to_string())));
    (due, owner, priority)
}

/// The due date of a task's text (see `fields_of`).
#[cfg(test)]
pub fn due_of(text: &str) -> Option<String> {
    fields_of(text).0
}

/// A task line: its box and its text. A list marker (`-`, `*`, `+`, or a number with `.` or `)`), a box with a space, `x` or
/// `X`, and some text.
pub fn task_line(line: &str) -> Option<(bool, String)> {
    let s = line.trim_start();
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    let rest = if let Some(rest) = ["-", "*", "+"].iter().find_map(|m| s.strip_prefix(m)) {
        rest
    } else if digits > 0 && s[digits..].starts_with(['.', ')']) {
        &s[digits + 1..]
    } else {
        return None;
    };
    let after = rest.trim_start();
    if after.len() == rest.len() {
        return None;
    }
    let mut chars = after.chars();
    let (open, mark, close) = (chars.next()?, chars.next()?, chars.next()?);
    if open != '[' || close != ']' || !matches!(mark, ' ' | 'x' | 'X') {
        return None;
    }
    let tail = chars.as_str();
    let text = tail.trim_start();
    if text.len() == tail.len() {
        return None;
    }
    let text = text.trim_end();
    (!text.is_empty()).then(|| (mark != ' ', text.chars().take(TASK_CHARS).collect()))
}

/// A fence line: up to three spaces, then three backticks or tildes. Returns the three characters.
fn fence_of(line: &str) -> Option<&str> {
    let spaces = line.chars().take_while(|c| c.is_whitespace()).count();
    if spaces > 3 {
        return None;
    }
    let rest = line.trim_start();
    ["```", "~~~"].iter().find(|m| rest.starts_with(**m)).copied()
}

/// The tasks of the lines of a page (LF line endings), the first `skip` lines (the frontmatter) left out. As Living Memory
/// does, a fence closes only on the same three characters that opened it.
pub fn tasks(lines: &[&str], skip: usize) -> Vec<Task> {
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    for (at, line) in lines.iter().enumerate().skip(skip) {
        if let Some(marker) = fence_of(line) {
            fence = if fence == Some(marker) { None } else { fence.or(Some(marker)) };
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some((done, text)) = task_line(line) {
            let (due, owner, priority) = fields_of(&text);
            out.push(Task { line: (at + 1) as u32, done, text, due, owner, priority });
            if out.len() >= MAX_TASKS {
                break;
            }
        }
    }
    out
}

fn scalar(value: &str) -> String {
    let v = value.trim();
    let quoted = v.len() >= 2 && v.starts_with(['"', '\'']) && v.chars().next() == v.chars().last();
    if quoted { v[1..v.len() - 1].to_string() } else { v.to_string() }
}

/// A key: a letter, digit or `_`, then at most 63 of letters, digits, `_`, spaces, `.` and `-`, then `:` and a space or the end.
fn pair_of(line: &str) -> Option<(String, String)> {
    let colon = line.find(':')?;
    let (key, rest) = (&line[..colon], &line[colon + 1..]);
    let key = key.trim_end();
    let mut chars = key.chars();
    let first = chars.next()?;
    let word = |c: char| c.is_alphanumeric() || c == '_';
    if !(first.is_ascii_alphanumeric() || first == '_') || key.chars().count() > 64 || !chars.all(|c| word(c) || matches!(c, ' ' | '.' | '-')) {
        return None;
    }
    if !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    Some((key.to_string(), rest.trim().to_string()))
}

/// The properties of a frontmatter block (its lines between the two `---`): a scalar, an inline `[a, b]` list or a block list
/// of `- item` lines gives one pair per value. Anything else is skipped, never guessed.
pub fn properties(front: &str) -> Vec<Prop> {
    let mut out: Vec<Prop> = Vec::new();
    let mut key: Option<String> = None;
    for line in front.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let item = line.trim_start().strip_prefix('-').filter(|rest| rest.starts_with([' ', '\t'])).filter(|_| line.starts_with([' ', '\t', '-']));
        if let (Some(rest), Some(k)) = (item, &key) {
            out.push(Prop { key: k.clone(), value: scalar(rest) });
            continue;
        }
        let Some((k, value)) = pair_of(line) else {
            key = None;
            continue;
        };
        key = Some(k.clone());
        if value.is_empty() {
            // A block list (or a nested map) follows.
            continue;
        }
        if value.starts_with('[') && value.ends_with(']') {
            out.extend(value[1..value.len() - 1].split(',').filter(|v| !v.trim().is_empty()).map(|v| Prop { key: k.clone(), value: scalar(v) }));
        } else {
            out.push(Prop { key: k, value: scalar(&value) });
        }
        key = None;
    }
    out.truncate(MAX_PROPS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<&str> {
        text.lines().collect()
    }

    #[test]
    fn a_task_is_a_list_line_with_a_box_and_text() {
        assert_eq!(task_line("- [ ] call Ana"), Some((false, "call Ana".into())));
        assert_eq!(task_line("  * [x] done thing  "), Some((true, "done thing".into())));
        assert_eq!(task_line("12) [X] numbered"), Some((true, "numbered".into())));
        assert_eq!(task_line("+ [ ]\ttab after the box"), Some((false, "tab after the box".into())));
        for not in ["- [ ]", "- [ ] ", "- [-] cancelled", "-[ ] no space", "- [ ]no space", "[ ] no marker", "- [] empty box", "text - [ ] later", "1.[ ] no space"] {
            assert_eq!(task_line(not), None, "{not}");
        }
        assert_eq!(task_line(&format!("- [ ] {}", "é".repeat(600))).unwrap().1.chars().count(), TASK_CHARS);
    }

    #[test]
    fn due_dates_are_read_from_the_emoji_or_the_dataview_field() {
        assert_eq!(due_of("call 📅 2026-12-01 soon"), Some("2026-12-01".into()));
        assert_eq!(due_of("call 📅2026-12-01"), Some("2026-12-01".into()));
        assert_eq!(due_of("call due:: 2026-12-02"), Some("2026-12-02".into()));
        // A single colon counts only inside the tail (the rule Living Memory uses).
        assert_eq!(due_of("call due: 2026-12-03"), None);
        assert_eq!(due_of("call (due: 2026-12-03)"), Some("2026-12-03".into()));
        assert_eq!(due_of("overdue:: 2026-12-03"), None);
        assert_eq!(due_of("call 📅 soon"), None);
        assert_eq!(due_of("📅 2026-1-1"), None);
        // The first one wins, wherever it stands.
        assert_eq!(due_of("due:: 2026-01-02 and 📅 2026-02-03"), Some("2026-01-02".into()));
    }

    #[test]
    fn the_tail_wins_over_the_emoji_and_the_dataview_field() {
        let some = |v: &str| Some(v.to_string());
        assert_eq!(fields_of("Ship it (due: 2026-12-01, owner: me, priority: high)"), (some("2026-12-01"), some("me"), some("high")));
        assert_eq!(fields_of("Ship it ⏫ 📅 2026-01-01 (due: 2030-01-01, priority: low)"), (some("2030-01-01"), None, some("low")));
        assert_eq!(fields_of("Review 🔼 📅 2027-03-04 (owner: Kim)"), (some("2027-03-04"), some("Kim"), some("medium")));
        assert_eq!(fields_of("Ship it (due: soon) 📅 2026-12-01"), (some("2026-12-01"), None, None));
        assert_eq!(fields_of("Ship it (due: 2026-02-30)"), (None, None, None));
    }

    /// The cases `src/features/notes/fixtures/task_lines.json` shares with Living Memory and `tasks.ts`.
    const CASES: &str = include_str!("../../../src/features/notes/fixtures/task_lines.json");

    #[test]
    fn every_shared_fixture_case_reads_the_same() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(CASES).unwrap();
        assert!(cases.len() >= 30);
        for case in &cases {
            let line = case["line"].as_str().unwrap();
            let want = &case["task"];
            let Some((done, text)) = task_line(line) else {
                assert!(want.is_null(), "{line}");
                assert!(tasks(&[line], 0).is_empty(), "{line}");
                continue;
            };
            assert!(!want.is_null(), "{line}");
            let (due, owner, priority) = fields_of(&text);
            assert_eq!(done, want["done"].as_bool().unwrap(), "{line}");
            assert_eq!(text, want["text"].as_str().unwrap(), "{line}");
            assert_eq!(due.as_deref(), want["due"].as_str(), "{line}");
            assert_eq!(owner.as_deref(), want["owner"].as_str(), "{line}");
            assert_eq!(priority.as_deref(), want["priority"].as_str(), "{line}");
            let found = tasks(&[line], 0);
            assert_eq!(found.len(), 1, "{line}");
            assert_eq!((found[0].due.clone(), found[0].owner.clone(), found[0].priority.clone()), (due, owner, priority), "{line}");
        }
    }

    /// Runs only when HIVEMIND_TEST_LM_SCRIPT points at a living_memory.py: the copy of the fixture here must hold the same cases as
    /// the file Living Memory owns, `tests/fixtures/task_lines.json` next to its `tests` folder. Parsed values are compared, since Git
    /// may change the line endings of either file.
    #[test]
    fn the_fixture_copy_matches_living_memorys_file() {
        let Ok(script) = std::env::var("HIVEMIND_TEST_LM_SCRIPT") else { return };
        let owned = std::path::Path::new(&script).parent().unwrap().join("tests").join("fixtures").join("task_lines.json");
        let theirs: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&owned).unwrap_or_else(|e| panic!("{}: {e}", owned.display()))).unwrap();
        let ours: serde_json::Value = serde_json::from_str(CASES).unwrap();
        assert!(ours == theirs, "src/features/notes/fixtures/task_lines.json differs from {}; copy that file over it", owned.display());
    }

    #[test]
    fn tasks_skip_code_and_the_frontmatter_and_count_lines_from_the_top() {
        let text = "---\ntitle: X\n---\n- [ ] one 📅 2026-12-01\n```\n- [ ] in code\n```\n- [x] two\n~~~\n- [ ] in tildes\n```\n- [ ] still in tildes\n~~~\n- [ ] three";
        let page = lines(text);
        let found = tasks(&page, 3);
        assert_eq!(found.iter().map(|t| (t.line, t.done, t.text.as_str(), t.due.as_deref())).collect::<Vec<_>>(), [
            (4, false, "one 📅 2026-12-01", Some("2026-12-01")),
            (8, true, "two", None),
            (14, false, "three", None),
        ]);
        // Without skipping, a task-looking line of the frontmatter would count.
        assert_eq!(tasks(&lines("- [ ] a\n- [ ] b"), 1).len(), 1);
    }

    #[test]
    fn a_page_keeps_at_most_500_tasks() {
        let text = "- [ ] t\n".repeat(600);
        assert_eq!(tasks(&lines(&text), 0).len(), MAX_TASKS);
    }

    #[test]
    fn properties_are_flat_keys_with_lists_as_one_pair_per_value() {
        let front = "title: \"Plan: Q4\"\nstatus: active\n# a comment\ntags: [a, 'b', \"c\"]\nowners:\n  - ana\n  - \"bo\"\nnested:\n  inner: x\ncount: 3\ndue: 2026-12-01\nempty:\n";
        let found: Vec<(String, String)> = properties(front).into_iter().map(|p| (p.key, p.value)).collect();
        assert_eq!(found, [
            ("title", "Plan: Q4"), ("status", "active"), ("tags", "a"), ("tags", "b"), ("tags", "c"), ("owners", "ana"), ("owners", "bo"),
            ("count", "3"), ("due", "2026-12-01"),
        ].map(|(k, v)| (k.to_string(), v.to_string())));
    }

    #[test]
    fn properties_skip_what_is_not_a_flat_key() {
        assert!(properties("- a\n- b\n").is_empty());
        assert!(properties("no colon here\n: nothing\n-bad: x").is_empty());
        // A key needs a space after its colon (a URL is not a pair), or nothing.
        assert!(properties("https://example.com\n").is_empty());
        assert_eq!(properties("key:value\nk2: v").len(), 1);
        let many = (0..80).map(|i| format!("k{i}: v")).collect::<Vec<_>>().join("\n");
        assert_eq!(properties(&many).len(), MAX_PROPS);
    }
}
