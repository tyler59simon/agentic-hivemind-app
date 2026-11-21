# NS-3B code review (Codex, 2026-11-21)

Codex (`gpt-6.2-sol`, effort high, read-only) reviewed NS-3B Rich mode in three rounds: commit `2392f6b` (15 findings), the fix commit `b0afec0` (9) and the next fix commit `ad6c5c5` (5). Claude checked each finding against the code before fixing it and found all 29 accurate. Each fix has a regression test, and every test named below was run against the commit it fixes and failed there. The rounds stopped at three, as planned for each phase. All findings are tracked on the Living Memory note "Notes Studio NS-3B: Codex review findings (commit 2392f6b)".

"Test" names the regression test by file and test name. Files are in `src/features/rich/` unless a path is given.

## Round 1: commit 2392f6b, fixed in b0afec0

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| P1 | A `%%comment%%` over two lines of a paragraph made Rich throw a `RangeError`: the span resolver dropped the line endings inside it | Comments keep their inner events; the node drops them when it is built | `markdown.test.ts` "opens a page with a comment over two lines (R1-P1)", plus a Live parity case |
| P2 | Toggling a heading off after a single line break saved two paragraphs with one newline, which read back as one | The original gap comes back only while it still parts the two blocks | `markdown.test.ts` "parts two blocks with a blank line once one changes type (R1-2)" |
| P2 | Deleting the paragraph between two `-` lists merged them: both still owned their slices, so the marker check was skipped | Neighbouring lists of one marker are checked whether or not they own their source | `markdown.test.ts` "keeps two lists apart when the block between them is deleted (R1-3)" |
| P2 | An unclosed fence or `$$` block moved above another block swallowed it | Unclosed display math is closed once something follows it; an unclosed fence is written anew, which closes it | `markdown.test.ts` "closes an unclosed fence / display math that moves above another block (R1-4)" |
| P2 | An indented fence's opening indentation went to the gap, so a moved block changed its code | The indentation before a block's first line belongs to the block | `markdown.test.ts` "moves an indented fence with its indentation, so its code stays the same (R1-5)" |
| P2 | `[[Page\|alias]]` typed in a table cell wrote a bare pipe and split the cell | Links, embeds and math escape their pipes in a cell (reworked in R2-4 and R3-1) | `markdown.test.ts` "escapes pipes of links, embeds and math in a table cell (R1-6)" |
| P2 | Plain text pasted into a code block was parsed as Markdown and inserted outside the fence | A paste into a code block is left to ProseMirror | `RichEditor.test.tsx` "pastes plain text into a code block as code (R1-7)" |
| P2 | The toolbar and block handle did not show until the first transaction | The editor renders again once it is built | `RichEditor.test.tsx` "shows the toolbar as soon as Rich opens (R1-8)" |
| P2 | Ctrl+E toggled inline code and then switched the tab to Reading, losing the Rich history | The workspace leaves a key an editor already handled | `src/workspace/Workspace.keys.test.tsx` "an editor that used the key: true, mode after: rich" |
| P2 | Adding or deleting a column left the table's positional alignments in place | The column commands move the alignments in the same transaction (reworked in R2-5) | `RichEditor.test.tsx` "Delete column / Add column right keeps each column's alignment (R1-10)" |
| P2 | Source boxes and code language fields kept their editability when the page turned read-only or back | A read-only change redraws the node views, and their handlers check editability | `RichEditor.test.tsx` "locks and unlocks source boxes with the page (R1-11)" |
| P2 | A popover survived a reload and could edit another node at the same position | A reload or read-only change closes the popover | `RichEditor.test.tsx` "closes an open popover when the text is reloaded (R1-12)" |
| P2 | A wiki link redrawn for a new target kept its old Ctrl+click listener | The listener is removed when the link is redrawn | `RichEditor.test.tsx` "opens only the current target of a wiki link after it changes (R1-13)" |
| P2 | Undo while a picture was saving undid the edit before it, and the link still arrived | Undo first cancels pending pictures, as in Live | `RichEditor.test.tsx` "Undo while a picture is saving cancels its link and keeps earlier edits (R1-14)" |
| P2 | Each unmatched `==` run scanned back over every earlier run (64,000 characters took over 6 s) | Open runs sit on a stack | `markdown.test.ts` "matches runs of == that never pair in linear work (R1-15)" |

## Round 2: commit b0afec0, fixed in ad6c5c5

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| P1 | A new `1.` list inserted before original `1.` and `1)` lists changed the middle list's marker and merged it with the last | The new list takes the other marker, and the check runs on the markers as written | `markdown.test.ts` "gives a new list the other marker rather than an original list, so the next list stays apart (R2-P1)" |
| P2 | A comment with about 21,000 inner events overflowed the stack in `splice(...next)` | The resolver splices in chunks (`micromark-util-chunked`) | `markdown.test.ts` "opens a comment holding thousands of code spans (R2-2)" |
| P2 | An indented paragraph moved below a list shown as a source box joined the list | A block after a source box, or one starting indented, is checked to stand alone | `markdown.test.ts` "keeps an indented paragraph moved below a list shown as a source box out of the list (R2-3)" |
| P2 | Pipe escapes stayed in math and embed values after a reload, so KaTeX drew double bars and `pic.png\` read as a page | Values hold plain pipes; the writer escapes them in a cell | `markdown.test.ts` "reads back the pipes of math and embeds in a table cell as written (R2-4)" |
| P2 | Column commands updated one alignment for a selection of several columns | The table commands' selection rectangle is used | `RichEditor.test.tsx` "Delete column / Add column right acts on every selected column's alignment (R2-5)" |
| P2 | After a large paste the boundary cache was cleared again and again (about 390 ms per write) | Boundary answers are kept with the blocks for the life of the page | `preserve.test.ts` "remembers which blocks part, past a few hundred boundaries" |
| P3 | Deleting the only column cleared its alignment though the command was refused | Alignments change only when the column count changed | `RichEditor.test.tsx` "keeps the alignment of a last column that cannot be deleted (R2-7)" |
| P3 | A picture cancelled by Undo was copied to the clipboard if its page closed first | Cancellation is checked before the closed-page path | `RichEditor.test.tsx` "drops a picture cancelled by Undo also when the page closed meanwhile (R2-8)" |
| P3 | The R1-15 test used a wall-clock cutoff and failed once under load | It counts the resolver's reads of the event list through a Proxy | `markdown.test.ts` "matches runs of == that never pair in linear work (R1-15)" |

## Round 3: commit ad6c5c5, fixed in 2cc08d7

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| P2 | `$\|x\|$` in a cell was written with two backslashes before each pipe; the table read them as a pair and split the cell | `k` backslashes before a pipe are written as `2k` and then `\|`, and read back the same way | `markdown.test.ts` "keeps TeX backslashes before pipes in a table cell (R3-1)" |
| P2 | Pipes in a comment or inline HTML in a cell were no longer escaped | Source text in a cell escapes the pipes not yet escaped | `markdown.test.ts` "escapes the pipes of a comment or inline source in a table cell once (R3-2)" |
| P2 | When the writer had to keep a list's marker (an item `* ---` cannot be written `- ---`), two lists still merged | The later list takes a marker that parts them | `markdown.test.ts` "keeps a new list apart from the next one when the writer must keep its marker (R3-3)" |
| P3 | With a header cell spanning two columns, adding a column looked like no change | The guard compares `TableMap` widths | `RichEditor.test.tsx` "moves alignments when a column is added to a table with a merged header (R3-4)" |
| P3 | Typing after a large closed HTML comment parsed the comment again on every key (about 38 ms for 900 KB) | A paragraph or heading after a source box that ends by itself is not checked again | `preserve.test.ts` "does not parse a large closed source box again while a paragraph after it is typed in (R3-5)" |
