//! The tasks and the properties of a Markdown page, for the index (NS-7B). They are read the way Living Memory reads
//! them (`core/docs_index.py`, `tasks` and `properties`), so a saved query or the Tasks list means the same over a folder
//! notebook and a Living Memory notebook: a task is a `- [ ]` or `- [x]` line outside fenced code and the frontmatter, and
//! a property is a flat key of the frontmatter (a list gives one value per item; nested maps are skipped).

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
    /// `YYYY-MM-DD` after `📅` or `due::`.
    pub due: Option<String>,
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

/// The due date of a task: the first `📅 date` or `due:: date` (`due: date` too), where `due` starts a word.
pub fn due_of(text: &str) -> Option<String> {
    let c: Vec<char> = text.chars().collect();
    for i in 0..c.len() {
        if c[i] == '\u{1F4C5}' {
            if let Some(date) = date_at(&c, i + 1) {
                return Some(date);
            }
        } else if c[i..].starts_with(&['d', 'u', 'e', ':']) && (i == 0 || !(c[i - 1].is_alphanumeric() || c[i - 1] == '_')) {
            let after = if c.get(i + 4) == Some(&':') { i + 5 } else { i + 4 };
            if let Some(date) = date_at(&c, after) {
                return Some(date);
            }
        }
    }
    None
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
            let due = due_of(&text);
            out.push(Task { line: (at + 1) as u32, done, text, due });
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
        assert_eq!(due_of("call due: 2026-12-03"), Some("2026-12-03".into()));
        assert_eq!(due_of("overdue:: 2026-12-03"), None);
        assert_eq!(due_of("call 📅 soon"), None);
        assert_eq!(due_of("📅 2026-1-1"), None);
        // The first one wins, wherever it stands.
        assert_eq!(due_of("due:: 2026-01-02 and 📅 2026-02-03"), Some("2026-01-02".into()));
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
