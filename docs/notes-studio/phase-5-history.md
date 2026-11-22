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

(Filled in when the phase lands.)
