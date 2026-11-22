//! Appending a line to a page of a folder notebook (NS-7A): Quick capture's "Today's page" and "Inbox" targets. The
//! line goes under a heading (made at the end of the page when it is missing) or at the end of the page. The page is
//! read, changed and saved against the hash it was read at; a save that finds another change retries on the new text,
//! up to `ATTEMPTS` times, so nothing typed or synced meanwhile is lost.
use crate::files::guard::Protected;
use crate::files::{self, SaveOutcome};
use crate::studio::{inside, Change};
use serde::Serialize;
use std::path::Path;

/// How many times an append reads the page again after another change got in between its read and its save.
pub const ATTEMPTS: u32 = 3;

/// What an append did, for the webview.
#[derive(Serialize, Debug, PartialEq)]
pub struct Appended {
    /// The page did not exist and was made with the line.
    pub created: bool,
}

/// An ATX heading line: its level and its text, without closing hashes. None for any other line.
fn heading_of(line: &str) -> Option<(usize, String)> {
    let line = line.trim_end();
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    Some((hashes, rest.trim().trim_end_matches('#').trim_end().to_lowercase()))
}

/// Whether `line` opens or closes a fenced code block, whose lines are never headings.
fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

/// `text` (LF line breaks) with `line` added under `heading`, a line such as `## Captured`: at the end of that heading's
/// section, after its last line of text and before the blank lines that precede the next heading. A missing heading is
/// added at the end of the page. With no heading, `line` goes at the end of the page. A heading inside a fenced code
/// block is not a heading.
pub fn insert_under(text: &str, heading: Option<&str>, line: &str) -> String {
    let Some(wanted) = heading.and_then(|h| heading_of(h).map(|parsed| (h.trim(), parsed))) else {
        let kept = text.trim_end_matches('\n');
        return if kept.is_empty() { format!("{line}\n") } else { format!("{kept}\n{line}\n") };
    };
    let (heading_line, (level, name)) = wanted;
    let lines: Vec<&str> = text.split('\n').collect();
    // The last line of a text that ends with a line break is empty and is not a line of the page.
    let count = if text.ends_with('\n') { lines.len() - 1 } else { lines.len() };
    let mut fenced = false;
    let mut start = None;
    let mut end = count;
    for (i, l) in lines.iter().take(count).enumerate() {
        if is_fence(l) {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        match (start, heading_of(l)) {
            (None, Some((lv, n))) if lv == level && n == name => start = Some(i),
            (Some(_), Some((lv, _))) if lv <= level => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    let Some(start) = start else {
        let kept = text.trim_end_matches('\n');
        return if kept.trim().is_empty() { format!("{heading_line}\n\n{line}\n") } else { format!("{kept}\n\n{heading_line}\n\n{line}\n") };
    };
    // After the section's last line of text; with none, after the heading and one blank line.
    let last = (start + 1..end).rev().find(|i| !lines[*i].trim().is_empty());
    let mut out: Vec<String> = lines[..count].iter().map(|l| l.to_string()).collect();
    match last {
        Some(i) => out.insert(i + 1, line.to_string()),
        None => {
            let mut added = vec![String::new(), line.to_string()];
            if lines.get(start + 1).is_some_and(|next| !next.trim().is_empty()) && start + 1 < count {
                added.push(String::new());
            }
            out.splice(start + 1..start + 1, added);
        }
    }
    format!("{}\n", out.join("\n"))
}

/// The text of a page made by an append.
fn fresh_text(heading: Option<&str>, line: &str) -> String {
    insert_under("", heading, line)
}

/// Append `line` to the page `rel` of the notebook at `root` (see the module). A missing page is made. `between` runs
/// after each read and before its save; tests use it to change the page at that moment.
pub(crate) fn append_page(
    root: &Path,
    protected: &Protected,
    history: &Path,
    rel: &str,
    heading: Option<&str>,
    line: &str,
    between: &mut dyn FnMut(u32),
) -> Result<Appended, String> {
    if heading.is_some_and(|h| heading_of(h).is_none()) {
        return Err("The heading to append under must be a Markdown heading such as ## Captured".into());
    }
    for attempt in 1..=ATTEMPTS {
        let full = inside(root, protected, rel, true)?;
        if std::fs::symlink_metadata(&full).is_err() {
            match crate::studio::create_kept(history, &full, &fresh_text(heading, line)) {
                Ok(_) => return Ok(Appended { created: true }),
                // Made by someone else since the check: read it on the next round.
                Err(e) if e.contains("already exists") => continue,
                Err(e) => return Err(e),
            }
        }
        let loaded = files::read(&full)?;
        if loaded.binary || loaded.read_only.is_some() {
            return Err(format!("{rel} cannot be edited: {}", loaded.read_only.as_deref().unwrap_or("it is not a text file")));
        }
        let text = insert_under(&loaded.text, heading, line);
        between(attempt);
        let change = Change { text: &text, pre: &loaded.stamp, format: &loaded.format, convert: false, source: "capture" };
        match crate::studio::save_kept(history, &full, &change)? {
            SaveOutcome::Saved(_) => return Ok(Appended { created: false }),
            SaveOutcome::Stale { .. } | SaveOutcome::Gone => {}
        }
    }
    Err(format!("{rel} kept changing while the line was added, so it was not saved. Try again"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_goes_to_the_end_of_an_existing_section() {
        let page = "# Day\n\n## Captured\n\n- 09:00 first\n\n## Notes\n\ntext\n";
        assert_eq!(insert_under(page, Some("## Captured"), "- 10:00 second"), "# Day\n\n## Captured\n\n- 09:00 first\n- 10:00 second\n\n## Notes\n\ntext\n");
        // A section that runs to the end of the page.
        assert_eq!(insert_under("## Captured\n\n- a\n", Some("## Captured"), "- b"), "## Captured\n\n- a\n- b\n");
        assert_eq!(insert_under("## Captured\n- a", Some("## Captured"), "- b"), "## Captured\n- a\n- b\n");
        // The heading is found whatever its case, closing hashes or spacing; a deeper heading belongs to the section.
        assert_eq!(insert_under("## captured ##\n- a\n### Sub\n- s\n## Next\n", Some("## Captured"), "- b"), "## captured ##\n- a\n### Sub\n- s\n- b\n## Next\n");
    }

    #[test]
    fn an_empty_section_gets_a_blank_line_then_the_line() {
        assert_eq!(insert_under("## Captured\n\n## Next\n", Some("## Captured"), "- a"), "## Captured\n\n- a\n\n## Next\n");
        assert_eq!(insert_under("## Captured\n## Next\n", Some("## Captured"), "- a"), "## Captured\n\n- a\n\n## Next\n");
        assert_eq!(insert_under("## Captured\n", Some("## Captured"), "- a"), "## Captured\n\n- a\n");
    }

    #[test]
    fn a_missing_heading_is_added_at_the_end() {
        assert_eq!(insert_under("# Day\n\ntext\n", Some("## Captured"), "- a"), "# Day\n\ntext\n\n## Captured\n\n- a\n");
        assert_eq!(insert_under("text", Some("## Captured"), "- a"), "text\n\n## Captured\n\n- a\n");
        assert_eq!(insert_under("", Some("## Captured"), "- a"), "## Captured\n\n- a\n");
        // A heading of another level or text is another heading.
        assert_eq!(insert_under("# Captured\n", Some("## Captured"), "- a"), "# Captured\n\n## Captured\n\n- a\n");
    }

    #[test]
    fn a_heading_in_a_code_block_is_not_a_heading() {
        let page = "```\n## Captured\n```\n";
        assert_eq!(insert_under(page, Some("## Captured"), "- a"), "```\n## Captured\n```\n\n## Captured\n\n- a\n");
    }

    #[test]
    fn with_no_heading_the_line_goes_at_the_end() {
        assert_eq!(insert_under("- a\n", None, "- b"), "- a\n- b\n");
        assert_eq!(insert_under("- a", None, "- b"), "- a\n- b\n");
        assert_eq!(insert_under("", None, "- b"), "- b\n");
    }

    fn rig(page: Option<&str>) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("hm-append-{}", uuid::Uuid::new_v4()));
        let (root, hist) = (base.join("nb"), base.join("history"));
        std::fs::create_dir_all(&root).unwrap();
        if let Some(page) = page {
            std::fs::write(root.join("Day.md"), page).unwrap();
        }
        (base, root, hist)
    }

    fn append(root: &Path, hist: &Path, heading: Option<&str>, line: &str, between: &mut dyn FnMut(u32)) -> Result<Appended, String> {
        append_page(root, &Protected::new(None), hist, "Day.md", heading, line, between)
    }

    #[test]
    fn a_page_with_windows_line_endings_stays_that_way() {
        let (base, root, hist) = rig(Some("\u{feff}# Day\r\n\r\n## Captured\r\n\r\n- a\r\n\r\n## Notes\r\n"));
        append(&root, &hist, Some("## Captured"), "- b", &mut |_| {}).unwrap();
        assert_eq!(std::fs::read(root.join("Day.md")).unwrap(), "\u{feff}# Day\r\n\r\n## Captured\r\n\r\n- a\r\n- b\r\n\r\n## Notes\r\n".as_bytes());
        // A missing heading is added in the same style.
        let (_, root2, hist2) = rig(Some("# Day\r\n"));
        append(&root2, &hist2, Some("## Captured"), "- b", &mut |_| {}).unwrap();
        assert_eq!(std::fs::read(root2.join("Day.md")).unwrap(), b"# Day\r\n\r\n## Captured\r\n\r\n- b\r\n");
        std::fs::remove_dir_all(&base).unwrap();
        std::fs::remove_dir_all(root2.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_missing_page_is_made_and_kept_as_a_version() {
        let (base, root, hist) = rig(None);
        assert_eq!(append(&root, &hist, Some("## Captured"), "- a", &mut |_| {}).unwrap(), Appended { created: true });
        assert_eq!(std::fs::read_to_string(root.join("Day.md")).unwrap(), "## Captured\n\n- a\n");
        assert_eq!(append(&root, &hist, Some("## Captured"), "- b", &mut |_| {}).unwrap(), Appended { created: false });
        assert_eq!(std::fs::read_to_string(root.join("Day.md")).unwrap(), "## Captured\n\n- a\n- b\n");
        assert_eq!(crate::history::list(&hist, &root.join("Day.md")).len(), 2);
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn an_append_that_finds_another_change_reads_the_page_again_and_keeps_that_change() {
        let (base, root, hist) = rig(Some("# Day\n\n## Captured\n\n- a\n"));
        let mut seen = Vec::new();
        // Another program edits the page between the append's read and its save, once.
        let done = append(&root, &hist, Some("## Captured"), "- mine", &mut |attempt| {
            seen.push(attempt);
            if attempt == 1 {
                std::fs::write(root.join("Day.md"), "# Day (edited elsewhere)\n\n## Captured\n\n- a\n- theirs\n").unwrap();
            }
        })
        .unwrap();
        assert_eq!(done, Appended { created: false });
        assert_eq!(seen, [1, 2], "the second read saw the other change");
        assert_eq!(std::fs::read_to_string(root.join("Day.md")).unwrap(), "# Day (edited elsewhere)\n\n## Captured\n\n- a\n- theirs\n- mine\n");
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn an_append_gives_up_after_three_attempts_and_changes_nothing() {
        let (base, root, hist) = rig(Some("start\n"));
        let mut n = 0;
        let err = append(&root, &hist, None, "- mine", &mut |_| {
            n += 1;
            std::fs::write(root.join("Day.md"), format!("busy {n}\n")).unwrap();
        })
        .unwrap_err();
        assert!(err.contains("kept changing"), "{err}");
        assert_eq!(n, ATTEMPTS);
        assert_eq!(std::fs::read_to_string(root.join("Day.md")).unwrap(), format!("busy {ATTEMPTS}\n"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn a_page_that_cannot_be_edited_or_reached_is_refused() {
        let (base, root, hist) = rig(None);
        // Mixed line endings open read-only, and a read-only page is never written.
        std::fs::write(root.join("Day.md"), "a\r\nb\n").unwrap();
        assert!(append(&root, &hist, None, "- a", &mut |_| {}).unwrap_err().contains("cannot be edited"));
        assert_eq!(std::fs::read(root.join("Day.md")).unwrap(), b"a\r\nb\n");
        assert!(append(&root, &hist, Some("Captured"), "- a", &mut |_| {}).is_err());
        for refused in ["../Out.md", ".hivemind/Day.md", "a/.hidden.md", "C:/x.md"] {
            assert!(append_page(&root, &Protected::new(None), &hist, refused, None, "- a", &mut |_| {}).is_err(), "{refused}");
        }
        std::fs::remove_dir_all(&base).unwrap();
    }
}
