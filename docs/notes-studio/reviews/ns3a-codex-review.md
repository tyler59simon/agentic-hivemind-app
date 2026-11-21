# NS-3A code review (Codex, 2026-11-21)

Codex (`gpt-6.2-sol`, effort high, read-only) reviewed the NS-3A rich live preview in three rounds: commit `398b956` (20 findings), the fix commit `87a0a1f` (8) and the next fix commit `fd7109e` (5). Claude checked each finding against the code before fixing it and found all 33 accurate. Each fix has a regression test, and every test named below was run against the commit it fixes and failed there. The rounds stopped at three, as planned for each phase. All findings are tracked on the Living Memory note "Notes Studio NS-3A: Codex review findings (commit 398b956)".

"Test" names the regression test: frontend tests by file and test name, Rust tests by module path.

## Round 1: commit 398b956, fixed in 87a0a1f

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| P1 | Inline math or a picture written over two lines made Live throw: a view plugin may not replace a line break | Such a construct shows as source | `editor.test.ts` "shows inline math over two lines as source instead of throwing" |
| P1 | A drawn table or diagram anywhere on a page stopped all inline rendering: the document node overlapped the block, and the plugin skipped its whole subtree | Only nodes inside a drawn block are skipped | `editor.test.ts` "renders inline marks and links on a page that also has a drawn table" |
| P1 | A page parked from another Living Memory store could read embeds from, and open links in, the store connected now | `useRichPage` checks the page's store before reading, following or opening; a store change redraws embeds | `richPage.test.tsx` "embeds, follows and opens nothing while it belongs to another store" |
| P2 | Opening the non-pictures of a mixed drop forgot the whole drop, so the second picture failed | Each file of a drop is handed out once; the drop goes when all are taken | `opens::prune_tests::a_drop_hands_out_only_its_own_files_once` |
| P2 | The attachment placeholder was text: a page closed meanwhile saved it, and Undo brought it back | A marker widget shows where the link goes; the text never holds a placeholder | `editor.test.ts` "marks where the link goes without changing the text..." and "says why when saving fails..." |
| P2 | The table grid reused its inputs when a table changed shape but kept its cell count, and threw | The grid records its rows and columns and is rebuilt when either changes | `editor.test.ts` "rebuilds the grid when a table changes shape with as many cells" |
| P2 | One long cell padded every row of its column, which could grow a page to about 100 MB | Columns are padded only up to 60 characters (`PAD_MAX`) | `parsing.test.ts` "pads table columns only up to a width..." |
| P2 | Reading mode broke display math inside a quote, and math and comments shifted the Outline's line numbers | Rewrites keep container markers; line numbers map back to the source (see round 2) | `PageView.rich.test.tsx` "keeps quotes, lists, block boundaries and heading lines..." |
| P2 | A callout's fold button kept the position it was drawn at, so it failed after text was added above | The position is read from the widget's DOM when clicked | `editor.test.ts` "folds the callout where it is now after text is added above it" |
| P2 | Links inside an embedded page resolved from the host page's folder | Followed links carry the embedded page's path | `PageView.rich.test.tsx` "follows a link inside an embed from the embedded page's folder" |
| P2 | `![[picture.png]]` never found a Living Memory attachment: `doc list` names pages only | New command `lmdoc_assets` lists the notebook's `assets` folder; `findFile` matches `assets/<sha8>-<name>` | `pictures.test.ts` "finds a Living Memory attachment by its name without the hash prefix"; `lmdoc::tests::asset_names_list_the_files_of_the_assets_folder` |
| P2 | A parenthesis in an attachment name ended the link's destination | Parentheses are percent-encoded | `parsing.test.ts` "encodes parentheses in attachment links..." |
| P2 | The 1 MB timing test failed in the full suite under load | It runs only with `VITE_RICH_BENCH=1`; the suite checks that an edit keeps every other block's widget | `blocks.test.ts` "redraws only the blocks around an edit" |
| P3 | A drop on a terminal whose program had exited did nothing | The terminal registry says whether a running terminal is under the drop | `editor.test.ts` "leaves a drop on a terminal to the terminal..." |
| P3 | A drop that arrived before the webview listened was lost | Drops are claimed once (`claim_drop`); the listener drains unclaimed ones at start (`unclaimed_drops`) and opens them | `opens::prune_tests::a_drop_is_claimed_once_by_the_listener_or_the_drain` |
| P3 | An embedded section started at a `# heading` inside a code fence and missed Setext headings | Sections follow the headings `@lezer/markdown` parses | `parsing.test.ts` "finds an embedded section by the headings Markdown parses" |
| P3 | A footnote definition inside a code block replaced the real one | Definition lines inside code are left out | `editor.test.ts` "reads footnote definitions outside code only" |
| P3 | A folder attachment could get a hidden name (`.shot.png`) that `hmfile` never serves | Leading dots are removed from the name | `attach::tests::names_are_made_safe_for_windows_and_living_memory` |
| P3 | A picture named `-draft.png` failed in Living Memory: its name was read as an option | `doc attach` gets `--name=<name>` and `--from-file=<path>` | `lmdoc::tests::live_pages_through_the_bridge` (with `HIVEMIND_TEST_LM_SCRIPT`) |
| P3 | A callout's formatted title lost everything after its first text node | The title keeps every inline node of its line | `PageView.rich.test.tsx` "keeps a callout's formatted title in its summary" |

## Round 2: commit 87a0a1f, fixed in fd7109e

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| P2 | `lmdoc_assets` followed an `assets` folder that is a link or junction | A linked `assets` lists nothing | `lmdoc::tests::asset_names_list_the_files_of_the_assets_folder` (junction case) |
| P2 | The asset list did not refresh when an attachment was added | `docs-changed` for `assets/` invalidates `lm-assets` | `lmnotebooks.test.ts` docs-changed tests |
| P2 | One-line display math became inline code, so `$$x$$` above `---` made a heading | Display math is always a fence; the lines it adds are mapped back to the source (`prepare`) | `PageView.rich.test.tsx` "keeps quotes, lists, block boundaries and heading lines..." |
| P2 | Undo while a picture was saving undid the typing before it, and the link still came | Superseded by round 3's fix | `editor.test.ts` "lets Undo cancel a picture still being saved..." |
| P3 | Text after a multi-line comment could start a new block | Superseded by round 3's fix | `PageView.rich.test.tsx` round-3 test |
| P3 | Bold running past a callout's title line moved body text into the title | A node that ends past the title line stays in the body | `PageView.rich.test.tsx` "leaves bold that runs past a callout's title line in its body" |
| P3 | A two-line Setext title was matched by its first line only | All title lines are joined | `parsing.test.ts` "finds an embedded section..." |
| P3 | A page closed during a batch copied only the last missed link | Missed links are collected and copied once | `editor.test.ts` "puts every link a closed page missed in one message" |

## Round 3: commit fd7109e, fixed in f5cdc90

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| P2 | The undoable marker left history entries: after a link, Undo took two presses, and Redo restored a marker that never finished | Markers stay out of history. Ctrl+Z and the `historyUndo` input cancel pending pictures before the history sees them (undo transactions skip transaction filters) | `editor.test.ts` "keeps the marker out of the undo history" |
| P2 | An under-indented display-math line inside a list ended the list, and the fence swallowed what followed | Every fence line gets the container's markers | `PageView.rich.test.tsx` "keeps every math line inside its list..." |
| P3 | Removing a multi-line comment joined a callout's title to its body | A multi-line comment keeps one line break; text after it is escaped where it would start a block | same test |
| P3 | A heading matched with collapsed spaces won over an exact one | Exact titles are tried first | `parsing.test.ts` "finds an embedded section..." (twin headings) |
| P3 | A text change remounted every embed in Reading mode | Headings read the line map through a ref | `PageView.rich.test.tsx` "keeps embeds mounted when other text of the page changes" |
