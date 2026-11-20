# NS-5: history

Read [README.md](README.md) first. This phase keeps a version of every page and opened file on each save, shows a timeline that also includes git commits for notebooks in a repository, and restores or compares any version. Living Memory pages show Living Memory's own history.

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
