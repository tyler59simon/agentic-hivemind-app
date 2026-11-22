//! Cutting a page into units for meaning search (NS-4B), the way Living Memory's `core/units.py` cuts a note body: a
//! section per heading, long sections cut into pieces of at most 360 words between paragraphs, and one paragraph longer
//! than that kept whole (the embedding then sees its first 512 word pieces, which is what the model reads anyway).
//!
//! Two differences from `units.py`: a page has no separate summary, so the title is a unit of its own, and `units.py`'s
//! rule that skips the "Links" and "Action items" sections belongs to note layout, not to free-form pages.
use crate::files::sha256;

/// Words in one piece of a section, as `MAX_WORDS` in `units.py`.
const MAX_WORDS: usize = 360;
/// A piece or a section with fewer words than this is not worth a vector.
const MIN_WORDS: usize = 3;
/// A page that would make more units than this keeps the first ones, so one huge file cannot fill the vector budget.
pub const MAX_UNITS_PER_PAGE: usize = 128;
/// The part of a unit's first line shown under a result.
const FIRST_LINE_CHARS: usize = 160;

/// A page as lines the extractors hand to the cutter: headings with their level, text lines, and the blank lines that
/// end a paragraph. A blank line inside a code fence is a `Text` with nothing in it, so a fence stays in one paragraph.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Line {
    Heading(u8, String),
    Text(String),
    Break,
}

/// One piece of a page, with the text the model embeds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unit {
    /// The heading path of its section, joined with ` > `; empty for the title and for text before the first heading.
    pub heading: String,
    /// The first line of its own text, for the snippet under a result.
    pub first_line: String,
    /// What is embedded: the title, the heading path and the text.
    pub text: String,
    /// The hash of `text`: a unit whose hash is the same as before keeps its vector.
    pub sha: String,
}

fn words(lines: &[&str]) -> usize {
    lines.iter().map(|l| l.split_whitespace().count()).sum()
}

/// Paragraphs of text lines, split at breaks.
fn paragraphs<'a>(rows: &[&'a Line]) -> Vec<Vec<&'a str>> {
    let mut out: Vec<Vec<&str>> = vec![Vec::new()];
    for row in rows {
        match row {
            Line::Text(text) => out.last_mut().expect("one group exists").push(text),
            Line::Break => {
                if !out.last().expect("one group exists").is_empty() {
                    out.push(Vec::new());
                }
            }
            Line::Heading(..) => {}
        }
    }
    out.retain(|p| !p.is_empty());
    out
}

/// Pieces of at most `MAX_WORDS` words, cut only between paragraphs; one paragraph longer than that stays whole.
fn split<'a>(rows: &[&'a Line]) -> Vec<Vec<&'a str>> {
    let mut pieces: Vec<Vec<&str>> = vec![Vec::new()];
    for paragraph in paragraphs(rows) {
        let last = pieces.last().expect("one piece exists");
        if !last.is_empty() && words(last) + words(&paragraph) > MAX_WORDS {
            pieces.push(Vec::new());
        }
        pieces.last_mut().expect("one piece exists").extend(paragraph);
    }
    pieces.retain(|p| !p.is_empty());
    pieces
}

struct Section<'a> {
    path: Vec<(u8, &'a str)>,
    rows: Vec<&'a Line>,
}

fn sections(lines: &[Line]) -> Vec<Section<'_>> {
    let mut out = vec![Section { path: Vec::new(), rows: Vec::new() }];
    let mut path: Vec<(u8, &str)> = Vec::new();
    for line in lines {
        match line {
            Line::Heading(level, text) => {
                path.retain(|(l, _)| l < level);
                path.push((*level, text));
                out.push(Section { path: path.clone(), rows: Vec::new() });
            }
            other => out.last_mut().expect("a section exists").rows.push(other),
        }
    }
    out
}

fn first_line_of(text: &str) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    line.chars().take(FIRST_LINE_CHARS).collect()
}

/// The units of a page: its title, then the text before the first heading, then each section (cut into pieces when long).
/// A section or a piece with under three words is left out, and so is one whose text another unit of the page has.
pub fn cut(title: &str, lines: &[Line]) -> Vec<Unit> {
    let mut units: Vec<Unit> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut add = |heading: String, body: Option<&str>, embedded: String| {
        let sha = sha256(embedded.as_bytes());
        if !seen.insert(sha.clone()) {
            return;
        }
        let first_line = body.map(first_line_of).unwrap_or_default();
        units.push(Unit { heading, first_line, text: embedded, sha });
    };
    if !title.trim().is_empty() {
        add(String::new(), None, title.trim().to_string());
    }
    for section in sections(lines) {
        // The page's own title as its first heading says nothing more about the text below it.
        let shown: Vec<&str> = section.path.iter().map(|(_, t)| *t).enumerate().filter(|(i, t)| !(*i == 0 && t.eq_ignore_ascii_case(title.trim()))).map(|(_, t)| t).collect();
        let label = shown.join(" > ");
        if words(&paragraphs(&section.rows).concat()) < MIN_WORDS {
            continue;
        }
        for piece in split(&section.rows) {
            if words(&piece) < MIN_WORDS {
                continue;
            }
            let text = piece.join("\n");
            let embedded = if label.is_empty() { format!("{}\n{text}", title.trim()) } else { format!("{} > {label}\n{text}", title.trim()) };
            add(label.clone(), Some(&text), embedded);
        }
    }
    units.truncate(MAX_UNITS_PER_PAGE);
    units
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Line {
        Line::Text(s.to_string())
    }
    fn heading(level: u8, s: &str) -> Line {
        Line::Heading(level, s.to_string())
    }
    fn long(n: usize, word: &str) -> String {
        vec![word; n].join(" ")
    }

    #[test]
    fn a_page_is_its_title_the_text_before_the_first_heading_and_one_unit_per_section() {
        let lines = [
            text("Some opening words here."),
            Line::Break,
            heading(1, "Plan"),
            text("The plan is to ship it."),
            heading(2, "Risks"),
            text("Nothing could go wrong at all."),
            heading(2, "Next steps"),
            text("Write the tests first."),
            heading(3, "Owners"),
            text("Ann and Bob own this."),
            heading(2, "Empty"),
            text("two words"),
        ];
        let units = cut("Plan", &lines);
        let shown: Vec<(&str, &str)> = units.iter().map(|u| (u.heading.as_str(), u.text.as_str())).collect();
        assert_eq!(shown, [
            ("", "Plan"),
            ("", "Plan\nSome opening words here."),
            // The title as the first heading adds nothing to the label.
            ("", "Plan\nThe plan is to ship it."),
            ("Risks", "Plan > Risks\nNothing could go wrong at all."),
            ("Next steps", "Plan > Next steps\nWrite the tests first."),
            ("Next steps > Owners", "Plan > Next steps > Owners\nAnn and Bob own this."),
        ]);
        assert_eq!(units[3].first_line, "Nothing could go wrong at all.");
        assert_eq!(units[0].first_line, "");
        assert!(units.iter().all(|u| u.sha.len() == 64));
    }

    #[test]
    fn a_long_section_is_cut_between_paragraphs_and_one_long_paragraph_is_kept_whole() {
        // Three paragraphs of 200 words: 200 fits, 400 does not, so a piece holds one paragraph.
        let lines = [heading(2, "Part"), text(&long(200, "a")), Line::Break, text(&long(200, "b")), Line::Break, text(&long(200, "c"))];
        let units = cut("T", &lines);
        assert_eq!(units.len(), 4);
        assert!(units[1].text.ends_with(&long(200, "a")) && units[2].text.ends_with(&long(200, "b")) && units[3].text.ends_with(&long(200, "c")));
        // Two paragraphs of 180 words fit one piece.
        let lines = [heading(2, "Part"), text(&long(180, "a")), Line::Break, text(&long(180, "b")), Line::Break, text(&long(180, "c"))];
        let units = cut("T", &lines);
        assert_eq!(units.len(), 3);
        assert!(units[1].text.contains(&long(180, "b")) && !units[1].text.contains("c c"));
        assert!(units[2].text.ends_with(&long(180, "c")));
        // One paragraph over 360 words is never cut.
        let big = long(500, "w");
        let units = cut("T", &[heading(2, "Part"), text(&big)]);
        assert_eq!(units.len(), 2);
        assert_eq!(units[1].text, format!("T > Part\n{big}"));
        // A paragraph over the limit after a short one starts its own piece.
        let units = cut("T", &[heading(2, "Part"), text("short words here"), Line::Break, text(&big)]);
        assert_eq!(units.len(), 3);
        assert_eq!(units[1].text, "T > Part\nshort words here");
    }

    #[test]
    fn a_fence_with_a_blank_line_stays_in_one_paragraph() {
        let lines = [heading(2, "Code"), text("let a = 1;"), text(""), text("let b = 2;"), Line::Break, text("after the fence ends")];
        let units = cut("T", &lines);
        assert_eq!(units.len(), 2);
        assert_eq!(units[1].text, "T > Code\nlet a = 1;\n\nlet b = 2;\nafter the fence ends");
    }

    #[test]
    fn repeated_text_makes_one_unit_and_too_many_units_are_cut_off() {
        let lines = [heading(2, "A"), text("same words here"), heading(2, "A"), text("same words here")];
        assert_eq!(cut("T", &lines).len(), 2, "the title and one section");
        let mut many = Vec::new();
        for i in 0..300 {
            many.push(heading(2, &format!("Part {i}")));
            many.push(text(&format!("words of part {i}")));
        }
        assert_eq!(cut("T", &many).len(), MAX_UNITS_PER_PAGE);
        assert!(cut("", &[]).is_empty());
    }
}
