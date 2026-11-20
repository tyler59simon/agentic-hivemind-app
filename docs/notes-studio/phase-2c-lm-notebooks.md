# NS-2C: Living Memory notebooks in Hivemind

Read [README.md](README.md), [phase-1a-workspace.md](phase-1a-workspace.md) and `agentic-living-memory/docs/notebooks-design.md` first. This phase shows Living Memory notebooks (NS-2A, NS-2B) in the Notes page beside folder notebooks, lets the user edit their pages in the shared workspace, attach files, review agents' proposed edits, and set agent reach and Private for both notebook kinds. Before starting, re-check this document's anchors against the code; NS-1A and NS-1B will have moved things.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Page bodies over 512 KiB are written to `app_data/lm-staging/<uuid>.md` and sent as `--body-file`; the file is deleted after the reply. Hivemind never builds a bridge frame over 2 MiB (C2).
- Every `doc` read, list, search and history call from Hivemind carries `--include-private` (LM design section 6).
- Reach settings for folder notebooks: Hivemind calls `doc folder set PATH --visibility V [--private]` when a notebook is registered (searchable by default) and whenever reach or Private changes, and `doc folder unset PATH` when it is removed; the sidecar is updated too when it can be written. The registry is what makes Private and Hidden effective when the sidecar cannot be written (S6).
- Read commands (`doc list`, `doc read`, `doc search`, `search`, `ask`) get a bridge deadline of 20 s; on a timeout the bridge restarts its process and the caller shows a retry. Writes keep no deadline, because an unknown outcome is worse than waiting (U6).
- Notebook settings of a notebook-only domain offer choosing its Obsidian vault, which runs `sync DOMAIN VAULT` (U5).

## 1. What the user sees

- The notebook column lists Living Memory notebooks under a **Living Memory** heading, grouped by domain, below folder notebooks. **New notebook** offers "Folder on disk" or "Living Memory" (pick a domain, or **New notebook-only domain**, which asks for a name).
- Living Memory pages open as `doc` tabs with the same modes as folder pages. The eyebrow shows `domain · notebook`.
- Saving: Ctrl+S or 5 s after the last keystroke (never per keystroke, so the journal does not fill with autosaves). A stale save opens the text merge.
- Images: paste or drop an image into a Living Memory page; Hivemind writes it to a temp file and runs `doc attach --from-file`, then inserts the relative link. Images show through an `hmfile` grant on the notebook's `assets` folder (read-only).
- **Proposals:** a badge on the notebook with the number of agent proposals. The inbox lists each with its page, author (session or agent), age and a diff (`@codemirror/merge`), with Accept (applies with the proposal's base revision; a stale base opens the merge against the current page), Edit then accept, and Reject with an optional reason.
- **Notebook settings** for both kinds: Agent reach (Hidden, Searchable, Injectable, with one sentence each and an example) and Private (blocks Hivemind AI and every Living Memory search and injection; with the reminder that it does not stop an agent reading files in its own folder). For folder notebooks the setting goes to Living Memory's policy registry with `doc folder set` (and to the sidecar when the folder can be written); Living Memory then indexes the folder by that policy, inside or outside a bound repository.
- Memory's domain pickers (library filter, Quick capture, new note) leave out notebook-only domains.

## 2. Design

- Gate: `useDocsEnabled()` in `src/lib/connection.ts` on `capabilities.docs.version >= 1`. Without it, the Living Memory heading shows "Update Living Memory to use Living Memory notebooks".
- `src/lib/lm.ts` wrappers for every `doc` command used: `docNotebooks`, `docNotebookCreate`, `docNotebookUpdate`, `docList`, `docRead`, `docWrite`, `docCreate`, `docMove`, `docDelete`, `docAttach`, `docHistory`, `docProposals`, `docAccept`, `docReject`, `docFolderLink`, `docFolderUnlink`, plus `domainCreateNotebook`. Reads use `view()` (`--actor viewer`); writes run as main. Stdin payloads stay under `max_page_bytes`; larger pages are written to a temp file and passed with `--body-file` (the bridge's 2 MiB request limit).
- `src/documents/adapters/lmdoc.ts`: precondition `{ revision }`; maps `LmError.stale` to the controller's stale event.
- `docKey`: `doc:<domain>:<notebook>:<lowercased path>`. `TabKind` gains `"doc"`; `TAB_VIEWS.doc` renders the same `FileTab` component through the adapter.
- Watcher (`src-tauri/src/watcher.rs`): a pure `doc_change(domains_dir, path) -> Option<(domain, notebook)>` for `domains/D/notebooks/<nb>/**` excluding `docs.sqlite3*`, emitted as `docs-changed`; the frontend invalidates the tree and refreshes open clean documents.
- Asset grants: `assets.rs` gains a grant kind for `<store>/domains/D/notebooks/<nb>/assets` resolved in Rust from the configured store root, read-only.

## 3. Files

`src/lib/lm.ts`, `src/lib/connection.ts`, `src/documents/adapters/lmdoc.ts`, `src/documents/keys.ts`, `src/workspace/{store.ts, Workspace.tsx}`, `src/features/notes/{NotebookTree.tsx, tree.ts, NotebookSettings.tsx, ProposalInbox.tsx, NewNotebook.tsx}`, `src/features/capture/QuickCapture.tsx`, `src/features/library/MemoryPage.tsx`, `src/features/editor/NewNote.tsx` (picker filters), `src-tauri/src/{watcher.rs, assets.rs, lib.rs}`.

## 4. Tests

- vitest: lmdoc adapter against `setTransport` (read, write, stale, payload over the limit goes through a file); tree grouping by domain; proposal diff model; picker filter drops `kind: "notebook"`.
- cargo: `doc_change` mapping (pages, assets, `docs.sqlite3` ignored, notes unaffected); the assets grant refuses paths outside `assets`.
- Live (gated by `HIVEMIND_TEST_LM_SCRIPT`, throwaway store): create a notebook-only domain and notebook, write, stale write, attach, propose as an agent and accept.

## 5. Exit

- A Living Memory page and a memory note side by side in a split, both editable.
- An agent's `alm doc propose` (run in a Hivemind terminal) shows in the inbox and is accepted.
- Agent reach set to Searchable on a folder notebook outside any repo makes `alm search` find its text; Hidden or Private makes it disappear (after Living Memory reindexes).
- Memory regression pass.

## 6. Shipped

(Filled in when the phase lands.)
