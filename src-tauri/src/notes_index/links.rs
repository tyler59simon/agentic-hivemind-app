//! Reading Markdown for the index: the title, the headings, the text without markup, `[[wiki]]` and `[text](path)`
//! links, and `#tags` with the `tags` of a frontmatter block. Written by hand, one pass per line, so no regular
//! expression crate is needed. Code (fenced blocks and spans) holds text but never links, tags or headings.

/// How a link was written: `wiki` for `[[Page]]`, `md` for `[text](path)`, `file` for a canvas card.
pub const WIKI: &str = "wiki";
pub const MD: &str = "md";
pub const FILE: &str = "file";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// The target as written, without the alias: `Notebook/Page#Heading` for `[[Notebook/Page#Heading|alias]]`, and the
    /// decoded path of a Markdown link.
    pub raw: String,
    pub kind: &'static str,
    pub embed: bool,
    /// 1-based line in the file; 0 for a page that is not text lines (a rich page).
    pub line: u32,
    /// The line the link is in, trimmed and cut, for the backlinks list.
    pub context: String,
}

#[derive(Default, Debug)]
pub struct Scanned {
    /// The first heading's text.
    pub title: Option<String>,
    pub headings: Vec<String>,
    pub body: String,
    pub tags: Vec<String>,
    pub links: Vec<Link>,
}

const CONTEXT_CHARS: usize = 200;
const PAGE_EXT: [&str; 3] = [".md", ".markdown", ".hmdoc"];

/// What a link's target is called, for finding the pages that could be its answer: the last part of its path, without the
/// heading or block part and, for a Markdown or rich page, its extension; lowercase. This is the key of `links.target_name`.
pub fn name_key(raw: &str) -> String {
    let path = raw.split(['#', '^', '?']).next().unwrap_or("");
    let path = path.replace('\\', "/");
    let last = path.rsplit('/').next().unwrap_or("").trim().to_lowercase();
    for ext in PAGE_EXT {
        if let Some(stem) = last.strip_suffix(ext) {
            return stem.trim().to_string();
        }
    }
    last
}

/// The name a link to the page at `path` would use.
pub fn page_key(path: &str) -> String {
    name_key(path)
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(pair) = bytes.get(i + 1..i + 3)
            && let Ok(hex) = std::str::from_utf8(pair)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn cut(line: &str) -> String {
    let line = line.trim();
    match line.char_indices().nth(CONTEXT_CHARS) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_string(),
    }
}

/// A scheme such as `https:` or `mailto:` (two letters or more, so `C:` is a drive).
fn external(dest: &str) -> bool {
    let Some(colon) = dest.find(':') else { return false };
    colon >= 2 && dest[..colon].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-')) && dest.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
}

struct Cx<'a> {
    links: &'a mut Vec<Link>,
    tags: &'a mut Vec<String>,
    line: u32,
    context: &'a str,
}

impl Cx<'_> {
    fn link(&mut self, raw: String, kind: &'static str, embed: bool) {
        if name_key(&raw).is_empty() {
            return;
        }
        self.links.push(Link { raw, kind, embed, line: self.line, context: cut(self.context) });
    }
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// The tag starting at `c[i]` (a `#`), and where it ends. A tag follows the start of a line, a space or an opening
/// bracket, and holds at least one character that is not a digit.
fn tag_at(c: &[char], i: usize) -> Option<(String, usize)> {
    if i > 0 && !(c[i - 1].is_whitespace() || matches!(c[i - 1], '(' | '[' | '{' | ',' | ';')) {
        return None;
    }
    let mut j = i + 1;
    while j < c.len() && is_tag_char(c[j]) {
        j += 1;
    }
    let text: String = c[i + 1..j].iter().collect();
    let text = text.trim_end_matches(['/', '-']);
    (text.chars().any(|ch| !ch.is_ascii_digit() && ch != '/') && !text.is_empty()).then(|| (text.to_lowercase(), i + 1 + text.chars().count()))
}

/// Every `#tag` in `text` (a line of a page that is not Markdown source).
pub fn tags_in(text: &str, out: &mut Vec<String>) {
    for line in text.lines() {
        let c: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < c.len() {
            if c[i] == '#'
                && let Some((tag, end)) = tag_at(&c, i)
            {
                out.push(tag);
                i = end;
            } else {
                i += 1;
            }
        }
    }
}

/// The index of the `]` closing the `[` at `open`, counting nested brackets.
fn close_bracket(c: &[char], open: usize) -> Option<usize> {
    let mut depth = 0;
    let mut i = open;
    while i < c.len() {
        match c[i] {
            '\\' => i += 1,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// The destination of a link whose `(` is at `open`, and the index after its `)`.
fn destination(c: &[char], open: usize) -> Option<(String, usize)> {
    let mut i = open + 1;
    while i < c.len() && c[i] == ' ' {
        i += 1;
    }
    let mut dest = String::new();
    if c.get(i) == Some(&'<') {
        i += 1;
        while i < c.len() && c[i] != '>' {
            dest.push(c[i]);
            i += 1;
        }
        i += 1;
    } else {
        let mut depth = 0;
        while i < c.len() && !c[i].is_whitespace() {
            match c[i] {
                '(' => depth += 1,
                ')' if depth == 0 => break,
                ')' => depth -= 1,
                _ => {}
            }
            dest.push(c[i]);
            i += 1;
        }
    }
    // An optional title, then the closing parenthesis.
    while i < c.len() && c[i] == ' ' {
        i += 1;
    }
    if let Some(&quote) = c.get(i).filter(|q| matches!(q, '"' | '\'')) {
        i += 1;
        while i < c.len() && c[i] != quote {
            i += 1;
        }
        i += 1;
        while i < c.len() && c[i] == ' ' {
            i += 1;
        }
    }
    (c.get(i) == Some(&')')).then_some((dest, i + 1))
}

/// A line's text without markup. Links and tags found on the way go into `cx`.
fn inline(line: &str, cx: &mut Cx) -> String {
    let c: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '\\' if c.get(i + 1).is_some_and(|n| n.is_ascii_punctuation()) => {
                out.push(c[i + 1]);
                i += 2;
            }
            '`' => {
                let run = c[i..].iter().take_while(|ch| **ch == '`').count();
                let mut j = i + run;
                let mut found = None;
                while j < c.len() {
                    let len = c[j..].iter().take_while(|ch| **ch == '`').count();
                    if c[j] == '`' && len == run {
                        found = Some(j);
                        break;
                    }
                    j += len.max(1);
                }
                match found {
                    Some(end) => {
                        out.extend(&c[i + run..end]);
                        i = end + run;
                    }
                    None => {
                        i += run;
                    }
                }
            }
            '[' | '!' if c[i] == '[' || c.get(i + 1) == Some(&'[') => {
                let embed = c[i] == '!';
                let open = if embed { i + 1 } else { i };
                if c.get(open + 1) == Some(&'[') {
                    if let Some(end) = (open + 2..c.len().saturating_sub(1)).find(|&j| c[j] == ']' && c[j + 1] == ']') {
                        let inner: String = c[open + 2..end].iter().collect();
                        // `\|` is how a table cell holds the alias separator.
                        let inner = inner.replace("\\|", "|");
                        let (target, alias) = match inner.split_once('|') {
                            Some((t, a)) => (t.trim().to_string(), Some(a.trim().to_string())),
                            None => (inner.trim().to_string(), None),
                        };
                        let shown = if embed { target.replace(['#', '^'], " ") } else { alias.filter(|a| !a.is_empty()).unwrap_or_else(|| target.replace(['#', '^'], " ")) };
                        out.push_str(shown.trim());
                        cx.link(target, WIKI, embed);
                        i = end + 2;
                        continue;
                    }
                } else if c.get(open + 1) == Some(&'^') {
                    // A footnote reference or definition marker.
                    if let Some(end) = close_bracket(&c, open) {
                        i = end + 1;
                        continue;
                    }
                } else if let Some(end) = close_bracket(&c, open)
                    && c.get(end + 1) == Some(&'(')
                    && let Some((dest, after)) = destination(&c, end + 1)
                {
                    let text: String = c[open + 1..end].iter().collect();
                    out.push_str(&inline(&text, cx));
                    let dest = percent_decode(dest.trim());
                    let path = dest.split(['#', '?']).next().unwrap_or("");
                    if !embed && !path.is_empty() && !external(&dest) {
                        cx.link(dest, MD, false);
                    }
                    i = after;
                    continue;
                }
                out.push(c[i]);
                i += 1;
            }
            '<' => {
                // An HTML tag or an autolink is markup; a lone `<` is text.
                let tag = c.get(i + 1).is_some_and(|n| n.is_ascii_alphabetic() || matches!(n, '/' | '!'));
                match (tag, c[i..].iter().position(|ch| *ch == '>')) {
                    (true, Some(len)) => i += len + 1,
                    _ => {
                        out.push('<');
                        i += 1;
                    }
                }
            }
            '#' => match tag_at(&c, i) {
                Some((tag, end)) => {
                    cx.tags.push(tag);
                    out.extend(&c[i..end]);
                    i = end;
                }
                None => {
                    out.push('#');
                    i += 1;
                }
            },
            '*' | '~' => i += 1,
            '=' if c.get(i + 1) == Some(&'=') => i += 2,
            '|' => {
                out.push(' ');
                i += 1;
            }
            ch => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

/// `#`s and a space, then the heading's text.
fn heading(line: &str) -> Option<&str> {
    let stripped = line.trim_start_matches(' ');
    if line.len() - stripped.len() > 3 {
        return None;
    }
    let line = stripped;
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    let text = rest.trim();
    Some(text.trim_end_matches('#').trim_end())
}

/// A table's delimiter row or a horizontal rule: no words in it.
fn rule(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    let table = t.contains('-') && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '));
    let solid = t.chars().filter(|c| !c.is_whitespace()).count() >= 3 && t.chars().all(|c| matches!(c, '-' | '*' | '_' | ' ')) && {
        let mut kinds: Vec<char> = t.chars().filter(|c| !c.is_whitespace()).collect();
        kinds.dedup();
        kinds.len() == 1
    };
    table || solid
}

/// A line without its quote marks, list marker, task box and callout label.
fn strip_prefix(line: &str) -> &str {
    let mut s = line.trim_start();
    while let Some(rest) = s.strip_prefix('>') {
        s = rest.trim_start();
    }
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    if let Some(rest) = ["- ", "* ", "+ "].iter().find_map(|m| s.strip_prefix(m)) {
        s = rest.trim_start();
    } else if (1..=9).contains(&digits) && s[digits..].starts_with(['.', ')']) && s[digits + 1..].starts_with(' ') {
        s = s[digits + 1..].trim_start();
    }
    for boxed in ["[ ] ", "[x] ", "[X] "] {
        if let Some(rest) = s.strip_prefix(boxed) {
            s = rest.trim_start();
        }
    }
    if let Some(rest) = s.strip_prefix("[!")
        && let Some(end) = rest.find(']')
    {
        s = rest[end + 1..].trim_start_matches(['+', '-']).trim_start();
    }
    s
}

/// The tags a frontmatter block lists under `tags` or `tag`: inline (`[a, b]`, `a, b`) or one per `- ` line.
fn front_tags(front: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut listing = false;
    for line in front.lines() {
        let item = |text: &str| text.trim().trim_matches(['"', '\'']).trim_start_matches('#').trim().to_lowercase();
        if let Some(value) = line.strip_prefix("tags:").or_else(|| line.strip_prefix("tag:")) {
            let value = value.trim().trim_start_matches('[').trim_end_matches(']');
            listing = value.is_empty();
            let parts: Vec<&str> = if value.contains(',') { value.split(',').collect() } else { value.split_whitespace().collect() };
            out.extend(parts.into_iter().map(item).filter(|t| !t.is_empty()));
        } else if listing && line.trim_start().starts_with('-') && line.starts_with([' ', '-']) {
            out.push(item(line.trim_start().trim_start_matches('-')));
        } else if !line.trim().is_empty() && !line.starts_with([' ', '\t']) {
            listing = false;
        }
    }
    out.retain(|t| !t.is_empty());
    out
}

/// The frontmatter block at the start of `lines` (between two `---` lines): its text and how many lines it takes.
fn frontmatter(lines: &[&str]) -> Option<(String, usize)> {
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return None;
    }
    let end = lines.iter().skip(1).position(|l| matches!(l.trim_end(), "---" | "..."))?;
    Some((lines[1..=end].join("\n"), end + 2))
}

/// Read a Markdown page (its text with LF line endings).
pub fn scan_markdown(text: &str) -> Scanned {
    let mut found = Scanned::default();
    let lines: Vec<&str> = text.lines().collect();
    let first = match frontmatter(&lines) {
        Some((front, taken)) => {
            found.tags.extend(front_tags(&front));
            taken
        }
        None => 0,
    };
    let mut body: Vec<String> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for (at, raw) in lines.iter().enumerate().skip(first) {
        let line_no = (at + 1) as u32;
        let t = raw.trim_start();
        let marker = if t.starts_with("```") { Some('`') } else if t.starts_with("~~~") { Some('~') } else { None };
        if let Some(ch) = marker {
            let run = t.chars().take_while(|c| *c == ch).count();
            match fence {
                None => {
                    fence = Some((ch, run));
                    continue;
                }
                Some((open, size)) if open == ch && run >= size && t[run..].trim().is_empty() => {
                    fence = None;
                    continue;
                }
                _ => {}
            }
        }
        if fence.is_some() {
            body.push((*raw).to_string());
            continue;
        }
        let mut cx = Cx { links: &mut found.links, tags: &mut found.tags, line: line_no, context: raw };
        if let Some(text) = heading(raw) {
            let shown = inline(text, &mut cx).trim().to_string();
            if !shown.is_empty() {
                found.title.get_or_insert_with(|| shown.clone());
                body.push(shown.clone());
                found.headings.push(shown);
            }
            continue;
        }
        if rule(raw) {
            continue;
        }
        // Table cells and spaces left by removed markup run together.
        let shown = inline(strip_prefix(raw), &mut cx).split_whitespace().collect::<Vec<_>>().join(" ");
        if !shown.is_empty() {
            body.push(shown);
        }
    }
    found.body = body.join("\n");
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(text: &str) -> Vec<(String, &'static str, bool, u32)> {
        scan_markdown(text).links.into_iter().map(|l| (l.raw, l.kind, l.embed, l.line)).collect()
    }

    #[test]
    fn wiki_links_keep_their_target_and_show_their_alias() {
        let s = scan_markdown("See [[Other page|the alias]] and [[Folder/Page#Part]] and ![[pic.png|200]].");
        assert_eq!(links("See [[Other page|the alias]] and [[Folder/Page#Part]] and ![[pic.png|200]]."), [
            ("Other page".to_string(), WIKI, false, 1),
            ("Folder/Page#Part".to_string(), WIKI, false, 1),
            ("pic.png".to_string(), WIKI, true, 1),
        ]);
        assert_eq!(s.body, "See the alias and Folder/Page Part and pic.png.");
    }

    #[test]
    fn markdown_links_are_decoded_and_external_ones_left_out() {
        let found = links("[a](My%20Page.md) [b](https://example.com/x) [c](#top) [d](<Sub folder/B.md> \"title\") ![img](pic.png) [e](mailto:x@y.z)");
        assert_eq!(found, [("My Page.md".to_string(), MD, false, 1), ("Sub folder/B.md".to_string(), MD, false, 1)]);
    }

    #[test]
    fn code_holds_text_but_no_links_tags_or_headings() {
        let text = "# Real\n```\n[[not a link]] #nottag\n# not a heading\n```\nInline `[[no]] #no` and [[yes]] #yes\n~~~\n[[no2]]\n~~~\n";
        let s = scan_markdown(text);
        assert_eq!(s.links.iter().map(|l| l.raw.as_str()).collect::<Vec<_>>(), ["yes"]);
        assert_eq!(s.tags, ["yes"]);
        assert_eq!(s.headings, ["Real"]);
        assert!(s.body.contains("[[not a link]] #nottag") && s.body.contains("# not a heading") && s.body.contains("[[no]] #no"));
        assert_eq!(s.links[0].line, 6);
    }

    #[test]
    fn tags_need_a_boundary_and_a_letter() {
        let s = scan_markdown("A #one, (#two/sub) a#three #123 #4/5 url.com/#frag &#39; #Mixed_Case-x\n# Heading #notatag");
        assert_eq!(s.tags, ["one", "two/sub", "mixed_case-x", "notatag"]);
    }

    #[test]
    fn frontmatter_tags_in_three_forms_and_the_block_is_not_body() {
        let inline = scan_markdown("---\ntitle: X\ntags: [Alpha, \"beta\", #gamma]\n---\nBody #delta");
        assert_eq!(inline.tags, ["alpha", "beta", "gamma", "delta"]);
        assert_eq!(inline.body, "Body #delta");
        let listed = scan_markdown("---\ntags:\n  - one\n  - Two\naliases:\n  - nope\n---\ntext");
        assert_eq!(listed.tags, ["one", "two"]);
        assert_eq!(scan_markdown("---\ntags: a b, c\n---\n").tags, ["a b", "c"]);
        assert_eq!(scan_markdown("---\ntags: a b\n---\n").tags, ["a", "b"]);
        // Lines after a frontmatter block count from the top of the file.
        assert_eq!(scan_markdown("---\ntags: x\n---\n[[Page]]").links[0].line, 4);
        // Not a frontmatter block without its closing line.
        assert_eq!(scan_markdown("---\ntags: x\nno end").tags.len(), 0);
    }

    #[test]
    fn the_title_is_the_first_heading_and_markup_is_stripped() {
        let s = scan_markdown("intro\n## The *real* title ##\n> [!note]+ Heads up\n> - [x] done **thing** with ==mark== and [link text](a.md)\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n1. first\n");
        assert_eq!(s.title.as_deref(), Some("The real title"));
        assert_eq!(s.headings, ["The real title"]);
        assert_eq!(s.body, "intro\nThe real title\nHeads up\ndone thing with mark and link text\na b\n1 2\nfirst");
    }

    #[test]
    fn a_page_with_no_heading_has_no_title_and_names_are_keys() {
        assert_eq!(scan_markdown("just text").title, None);
        assert_eq!(name_key("Folder/Sub/My Page.md"), "my page");
        assert_eq!(name_key("Page#Heading"), "page");
        assert_eq!(name_key("Notebook\\Plan.HMDOC"), "plan");
        assert_eq!(name_key("run.log"), "run.log");
        assert_eq!(name_key("#Heading"), "");
        assert_eq!(page_key("Projects/Roadmap.md"), "roadmap");
    }

    #[test]
    fn a_link_in_a_table_may_escape_its_pipe_and_unclosed_brackets_are_text() {
        assert_eq!(links("| [[Page\\|alias]] |"), [("Page".to_string(), WIKI, false, 1)]);
        let s = scan_markdown("an [unclosed bracket and [[open");
        assert!(s.links.is_empty());
        assert_eq!(s.body, "an [unclosed bracket and [[open");
    }

    #[test]
    fn non_ascii_text_and_links_survive() {
        let s = scan_markdown("# Café notes\nSee [[Über Straße]] and [x](Ärger%20Frei.md) #日本語\n");
        assert_eq!(s.title.as_deref(), Some("Café notes"));
        assert_eq!(s.links.iter().map(|l| l.raw.as_str()).collect::<Vec<_>>(), ["Über Straße", "Ärger Frei.md"]);
        assert_eq!(s.tags, ["日本語"]);
    }

    #[test]
    fn the_context_of_a_link_is_its_line_cut_to_a_length() {
        let long = format!("[[Page]] {}", "x".repeat(400));
        let c = &scan_markdown(&long).links[0].context;
        assert!(c.chars().count() <= CONTEXT_CHARS + 1 && c.ends_with('…'));
        assert_eq!(scan_markdown("  see [[Page]]  ").links[0].context, "see [[Page]]");
    }
}
