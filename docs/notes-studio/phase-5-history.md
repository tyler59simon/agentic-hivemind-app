# NS-5: history

Read [README.md](README.md) first. This phase keeps a version of every page and opened file on each save, shows a timeline that also includes git commits for notebooks in a repository, and restores or compares any version. Living Memory pages show Living Memory's own history.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- History follows renames: the snapshot index maps a page key to its snapshots, and a rename or move (NS-1A) appends the old key to the new one, so a page's history is continuous; case-only renames keep the key (U9).
- Commit stages and commits exactly one file: `git commit --only -m MESSAGE -- ":(literal)<repo-relative path>"`, which leaves any other staged change staged. Tests: another file already staged, and a file name with pathspec characters (`*`, `?`, `[`, `:`) (S12).
- Restoring a version runs `files::guard` on the target (S2).

## Changes from the code survey before NS-5

Claude surveyed main at `f88e919` on 2026-11-22. Where the sections below say otherwise, these win. At the user's request this phase has no Codex review; Claude reviews the diff.

- **Key.** Every file save, loose files included, goes through `studio.rs file_save` with a notebook id and a relative path, and the webview's `docKey` uses that id (`file:<notebook>:<path>`), which a re-registered notebook or a loose file's grant would change. So Rust keys history by the file's absolute path, normalised as `folders.rs normal()` does (case-folded on Windows): the folder is `app_data/history/<sha256(normalised path)[:16]>/`. The same file has one history whether it is opened as a page or from disk.
- **When snapshots are taken.** In Rust, not the webview: after every successful `file_save`, `file_create` and Save as (`opens.rs file_save_as`); and, the first time a file with no history is saved, its content on disk before the save, so the version from before Hivemind can be restored. `file_save` takes an optional `source` (`you` by default; `links`, `restore`, and later `replace`, `ai`, `agent`): for any source but `you` the content on disk is snapshotted before the write too. The NS-4A link rewrite (`src/features/links/rewrite.ts applyPlan`) passes `links`. Identical contents are stored once, so the extra snapshots cost nothing when nothing changed.
- **Renames.** `file_rename` (`rename_in`) moves the history of the file, or of every file under a folder, to the new key by appending the old key's entries; a case-only rename keeps the key.
- **Size.** Files over 16 MB are not snapshotted (the timeline says so); retention is per file as in section 2.
- **Living Memory pages** take no Hivemind snapshots: their timeline is `docHistory` in `src/lib/lm.ts` (`alm doc history`) and Restore writes through the existing page save with its revision precondition.
- **Git.** The timeline and Commit apply to any file inside a git work tree (found with `git rev-parse --show-toplevel` from the file's folder through `git.rs run_captured` with a timeout). Commit asks for a message in a dialog, never pushes, and shows `review.rs NO_IDENTITY` when git has no identity.
- **Where it shows.** File tabs gain a History mode beside Reading, Live, Rich and Source (today `FileTab.tsx` maps `history` to Reading); plain text files get it too. The page rail gains a History section with the last five versions. The new components go in `src/features/history/` beside Memory's existing `HistoryViews.tsx`, `LogView.tsx` and `activity.ts`, without changing them.

## 1. What the user sees

- A **History** mode on file and page tabs (as notes have) and a **History** section in the page rail with the last few versions.
- The timeline merges Hivemind snapshots (time, size, what saved it: you, AI action, agent apply, replace in files) and, for git notebooks, commits touching the file (`git log --follow`), with author and message.
- Click a version to see it; **Compare with current** opens a side-by-side diff (`@codemirror/merge`); **Restore** saves that version as a new version (never rewrites history). **Pin** keeps a version past retention.
- Git notebooks get a **Commit** button on the page (stages that file, asks for a message, commits; never pushes). A missing git identity shows the existing message from `review.rs` (`NO_IDENTITY`).
- Living Memory pages: the timeline comes from `alm doc history`; Restore writes the old text with `doc write --expected-revision`.

## 2. Design

- `src-tauri/src/history.rs`: `app_data/history/<sha256(docKey) first 16 hex>/` holding `index.json` (entries: time, sha256, size, source, pinned) and content-addressed `objects/<sha256>.gz` (`flate2`), so identical versions are stored once.
- A snapshot is taken after every successful save, and before every write that is not the user typing (AI apply, agent apply, folder replace, link rewrite, restore), so each of those can be undone.
- Retention per document: 100 versions or 90 days, whichever keeps more, pinned versions always; pruned on write. A damaged `index.json` is rebuilt from the objects folder (times from file mtimes).
- Git timeline: `git log --follow --format=... -- <file>` through `git.rs` helpers with a timeout; contents with `git show <sha>:<path>`.
- Commands: `history_list(ref)`, `history_read(ref, id)`, `history_pin(ref, id, pinned)`, `git_file_log(ref)`, `git_file_commit(ref, message)`.

## 3. Files and tests

`src-tauri/src/history.rs`, `src-tauri/src/git.rs`, `src/features/history/{FileHistory.tsx, timeline.ts}`, `src/features/history/HistoryViews.tsx`. cargo: retention bounds, pins, dedupe, damaged index recovery, snapshot before non-typing writes. vitest: timeline merge and ordering. Exit: restore any version of a page; retention holds; Memory regression pass.

## 4. Shipped

Code landed on 2026-11-22: Hivemind `cf4fe96` (decisions in `0ccb353`), with the fixes from Claude's review and UI pass. At the user's request this phase had no Codex review; Claude reviewed the diff.

**Rust**
- `src-tauri/src/history.rs`: the store. `history/<first 16 hex of sha256(normalised absolute path)>/index.json` plus `objects/<sha256>.gz` (`flate2`, now a direct dependency). Entries are `{ id, time, sha256, size, source, pinned }`. Retention runs on every write and drops a version only when it is unpinned, not among the newest 100 and older than 90 days. A damaged or missing `index.json` is rebuilt from the objects (times from file mtimes, source `recovered`, pins lost) and written back. Files over 16 MB add nothing, and `history_list` says `tooLarge`. `moved` carries the old key's entries into the new key (old entries first, ids renumbered, objects copied, old folder removed), for a file or for every file under a renamed folder; a case-only rename is the same key on Windows. Commands: `history_list`, `history_read`, `history_pin`, `git_file_log`, `git_file_commit`.
- `studio.rs`: `file_save` takes an optional `source` (`you` by default; `links`, `restore`, `replace`, `ai`, `agent`; anything else is refused). `save_kept` snapshots the file as it is on disk before the write when it has no history yet, or when the source is not `you` (only when the disk still holds the bytes the save's precondition names; labelled `disk`; a non-`you` save is not written if that snapshot fails), and the saved bytes after the write. `file_create` snapshots the new file; `rename_kept` (behind `file_rename`) calls `history::moved`; `resolve_file` gives the history commands the same resolution and guard as any file command. `opens.rs file_save_as` snapshots the file it replaces (first time) and the saved file.
- `git.rs`: `beside`, `work_tree` (`git rev-parse --show-toplevel` through `run_captured`), `file_log` (`git log --follow --name-only`, newest 100, plus whether the file changed), `file_version` (`git show <sha>:<path at that commit>`, 16 MB cap), `file_commit` (`git commit --only -m MESSAGE -- ":(literal)<name>"`; `review.rs NO_IDENTITY` when git has no identity; never pushes). `folders::normal` and `review::NO_IDENTITY` became `pub(crate)`.

**Webview**
- `src/lib/history.ts` (wrappers), `src/features/history/timeline.ts` (merge and order of snapshots, commits and Living Memory operations; labels), `src/features/history/FileHistory.tsx` (`FileHistory` mode, `HistoryRail`, `CommitDialog`, compare with `@codemirror/merge`, restore, pin). Memory's `HistoryViews.tsx`, `LogView.tsx` and `activity.ts` are unchanged.
- `FileTab.tsx`: a History tab for every file tab (markdown: Reading, Live, Rich, Source, History; other text files: Source, History; rich pages: Page, History). `RightSidebar.tsx PageRail`: a History section with the five newest versions and an All link.
- `documents/store.ts`: `save(key, source?)` and `restore(key, text)`; `saveFile` and `saveDoc` pass `source` only when given. The link rewrite (`RewriteDialog.tsx`) saves with source `links`.
- Living Memory pages: the timeline is `docHistory`, a version is `docVersion`, and Restore goes through the normal page save, so it writes with `doc write --expected-revision`.

**UI pass (2026-11-22).** Claude ran the dev app with two scratch notebooks, one a git work tree with a commit and another file already staged, and a scratch Living Memory store:
- The first save of a page added "Saved by you" and "Found on disk"; Restore of the disk version put the old text back in the file and added a "Restored" row; Compare opened the merge view.
- Commit in the git notebook made one commit for that page; the other staged file stayed staged; the timeline showed the commit and "Matches the last commit".
- A `.txt` file has Source and History; a Living Memory page shows its Living Memory history.
- Renaming the page in the tree kept its history (the old folder was removed, the new one held every version).
- Not checked in the app: the missing git identity message (it would mean changing the machine's git identity; the cargo test covers it).

The review and the pass found two problems, fixed before the commit: the History mode left the preview and Compare about 110 px in a narrow pane (UI-1), and the rail's History rows did not open their version (UI-2). Claude also left-aligned the rail rows once they became buttons.

**Fixes after the check in the dev app (webview only)**
- UI-1: the History mode is a grid of a fixed 15 rem list and the version taking the rest (`.history-view` inside `.history-wrap`, `App.css`). The wrap is a container (`container-type: inline-size`), and `@container history (max-width: 640px)` puts the version below the list at the pane's full width, so the layout follows the pane, not the window (a `@media` rule would not). Compare gets that full width in a narrow pane. `FileHistory.test.tsx` checks the structure and the stylesheet rules, since jsdom lays nothing out.
- UI-2: each row of the rail's History section is a button. It asks for that version through `src/features/history/pick.ts` (a small store keyed by tab) and switches the tab to History; `FileHistory` takes the request once it has the timeline, selects the version and scrolls it into view. It also works when the History mode is already showing. Tested for both cases.

**Where this differs from the text above**
- The commands take `notebook` and `path` (as every file command does), not one `ref`.
- Git commands run in the file's folder with the file name as a literal pathspec (`:(literal)<name>`, relative to that folder) rather than a repo-relative path. A commit lists the file's path at that commit (`--name-only`) so `git show` finds it after a rename.
- Restore is not a Rust command: the History view puts the version's text into the open page and saves it through the document store with source `restore`, so the page's own precondition, merge and conflict handling apply, and `file_save` runs `files::guard`. It needs a clean page (unsaved edits are not in the history), and is off for a read-only page, a binary or undecodable version, and a version equal to the page.
- A file git does not know yet is marked with `git add -N` before the commit, and unmarked again if the commit fails. Git's output reaches Hivemind as text, so a commit version with bytes that are not UTF-8 cannot be restored (it can still be read).
- Windows cannot name a file with `*`, `?` or `:`. The literal-pathspec test creates such files only on Unix; on Windows it checks the pathspec text and runs the real git test with `[` in the name.
- `RightSidebar.test.tsx` and `FileTab.hmdoc.test.tsx` were edited for the new History section and tab; `RewriteDialog.test.tsx` gained the `links` source test. `store.test.ts` is unedited.
- Not covered by a test: the dialog and the two snapshots inside `opens.rs file_save_as`, and the Tauri command wrappers themselves (their logic is in `save_kept`, `create_kept`, `rename_kept` and the `history` and `git` functions, which are).
