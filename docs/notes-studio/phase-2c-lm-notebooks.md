# NS-2C: Living Memory notebooks in Hivemind

Read [README.md](README.md), [phase-1a-workspace.md](phase-1a-workspace.md) and `agentic-living-memory/docs/notebooks-design.md` first. This phase shows Living Memory notebooks (NS-2A, NS-2B) in the Notes page beside folder notebooks, lets the user edit their pages in the shared workspace, attach files, review agents' proposed edits, and set agent reach and Private for both notebook kinds. Before starting, re-check this document's anchors against the code; NS-1A and NS-1B will have moved things.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Page bodies whose JSON-escaped form exceeds 512 KiB are written to `app_data/lm-staging/<uuid>.md` and sent as `--body-file`; the file is deleted after the reply. The bridge measures the encoded frame and never sends one over 2 MiB (C2).
- Every `doc` read, list, search and history call from Hivemind carries `--include-private` (LM design section 6).
- Reach settings for folder notebooks: Hivemind calls `doc folder set PATH --visibility V [--private]` when a notebook is registered (searchable by default) and whenever reach or Private changes, and `doc folder unset PATH` when it is removed; the sidecar is updated too when it can be written. The registry is what makes Private and Hidden effective when the sidecar cannot be written (S6).
- There is no bridge deadline. The bridge serializes calls under one lock, so a stalled write would hold a read past any deadline, and restarting the process would leave the write's outcome unknown. Living Memory bounds its own `doc` work instead (LM design 8.1) (U6).
- The `lmdoc` adapter applies the file service's format rules to page text: BOM and line endings are detected on `doc read`, the editor gets LF text, mixed line endings open read-only, and `doc write` sends the bytes re-encoded with the detected BOM and line endings. Its round-trip tests mirror NS-1A's (C4).
- Notebook settings of a notebook-only domain offer choosing its Obsidian vault, which runs `sync --domain DOMAIN VAULT` (U5).
- Hivemind's notebook registry (`notebooks.json`) keeps a copy of each folder notebook's reach and Private, written with every `doc folder set`; Hivemind's AI features read the stricter of that copy and the sidecar (S10).

## Changes from the code survey before NS-2C

Claude surveyed Hivemind at 9437abe (the end of NS-1B) and Living Memory as NS-2A and NS-2B shipped them, on 2026-11-21. Where the text below says otherwise, these win.

- **Living Memory commands as shipped.** Folder reach is `doc folder set PATH --visibility V [--private|--no-private]` and `doc folder unset PATH [--forget]`; `unset` of a hidden or private folder keeps a tombstone, so Hivemind sends `--forget` only when the user removes a notebook and wants its folder reachable again. The wrappers are `docFolderSet` and `docFolderUnset`, plus `docProposal` (one proposal), `docUndo` and `docSearch`. `doc notebooks` leaves hidden notebooks out unless given `--include-hidden`, which Hivemind always passes. `--include-private` is needed on writes, `undo`, `apply` and `recover` that touch a private notebook, not only on reads. `search` and `ask` return pages in a `pages` array with `pages_stale` when the page index was not fully refreshed.
- **Reach takes effect at once.** Living Memory checks folder reach and Private when it serves each result, so Hidden or Private hides a folder notebook's pages immediately; the exit check below no longer waits for a reindex. The same holds for Living Memory notebooks (`notebook.json` is read when results are served).
- **No vault for notebook-only domains yet.** Living Memory mirrors notebooks only into the vault of a domain that already syncs notes (NS-2B, design section 12b). The U5 item above (choosing a vault for a notebook-only domain) is deferred.
- **Adapter seam first.** NS-1A shipped no adapter interface: `src/documents/store.ts` calls `readFile` and `saveFile` directly and is keyed by `FileRef`, and `FileTab` (`src/features/notes/FileTab.tsx`) assumes a folder notebook (`tab.file`, `notebooksQuery`, `treeQuery`, `createFile`, `trashPath`, `assetBase`). NS-2C first splits the document store by key kind and makes the page view work without a `FileRef`; `lmdoc.ts` then implements that seam.
- **Tabs.** `docKey` (`src/documents/keys.ts`) gains a `doc:<domain>:<notebook>:<path>` branch; `Tab` gains `doc?: DocRef`; `"doc"` joins `TabKind` and `KINDS` in `src/workspace/store.ts`; `showTab` routes doc tabs to Notes; `src/workspace/sync.ts` treats them like file tabs (unsaved dots, letting documents go); `FileDraft.target` (`src/documents/drafts.ts`) accepts a `DocRef`.
- **Text format.** BOM and line-ending detection exists only in Rust (`files/encoding.rs`). The `lmdoc` adapter gets a small TypeScript helper with the same rules (UTF-8 only: a page is UTF-8 by Living Memory's rule), tested on NS-1A's round-trip cases.
- **Bridge size.** `max_page_bytes` is 4 MiB, above the bridge's 2 MiB line limit (`SERVE_LIMIT`), so the 512 KiB escaped-size rule above is the one that holds. `bridge.rs` `exchange` has no size check today; the measuring and `lm-staging` files are new code.
- **Watcher.** `src-tauri/src/watcher.rs` has the pure mappers `note_domain` and `store_file`, and `watch_all` already watches `domains/` recursively; `doc_change` is a third mapper and callback, emitted beside `notes-changed` and `store-changed` in `lib.rs`. It ignores `docs.sqlite3*`, `.docs-*` and `notebook-sync.json`.
- **Attachments grant.** `assets.rs` has one map of grant id to root and no kinds. The `hmfile` handler refuses everything under the store through `Protected::check`, and `opens.rs` `prune_assets` keeps only notebook roots and recent-file folders. The Living Memory assets grant needs an explicit exemption in both, limited to `<store>/domains/D/notebooks/<nb>/assets`, and `asset_base` needs a form for Living Memory notebooks.
- **Reach for folder notebooks.** Nothing writes reach or Private today: `NotebookMeta` (`src/lib/notebooks.ts`) and the registry structs (`src-tauri/src/notebooks/mod.rs`, which drop unknown keys) gain `visibility` and `private` with defaults. Both registration paths, `notebook_add` and `notebook_add_dropped` (`studio.rs`), call `doc folder set`, and removal calls `doc folder unset`.
- **Domain pickers.** `DomainInfo` (`src/lib/lm.ts`) gains `kind`. Besides Quick capture, New note and the Memory library filter, the default domain choice (`App.tsx`) and the Graph, History, Log, Wiki and Work views also list domains; notebook-only domains are left out of every one.
- **Saving.** File pages have no timed save to disk today (the store's timer writes drafts only), so the 5 s save of Living Memory pages is new behaviour, limited to `doc` tabs.
- **Files.** New: `src/features/notes/NewNotebook.tsx`, `ProposalInbox.tsx`, `src/documents/adapters/lmdoc.ts`. Changed besides those listed in section 3: `src/lib/notebooks.ts`, `src-tauri/src/notebooks/mod.rs`, `src-tauri/src/studio.rs`, `src-tauri/src/opens.rs`, `src-tauri/src/bridge.rs`, `src/documents/{store.ts, drafts.ts, keys.ts}`, `src/workspace/sync.ts`, `src/features/notes/{NotesPage.tsx, FileTab.tsx}`, `src/App.tsx`.

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
- `src/lib/lm.ts` wrappers for every `doc` command used: `docNotebooks`, `docNotebookCreate`, `docNotebookUpdate`, `docList`, `docRead`, `docWrite`, `docCreate`, `docMove`, `docDelete`, `docAttach`, `docHistory`, `docSearch`, `docProposals`, `docProposal`, `docAccept`, `docReject`, `docUndo`, `docFolderSet`, `docFolderUnset`, plus `domainCreateNotebook`. Reads use `view()` (`--actor viewer`); writes run as main. Stdin payloads stay under `max_page_bytes`; larger pages are written to a temp file and passed with `--body-file` (the bridge's 2 MiB request limit).
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
- Agent reach set to Searchable on a folder notebook outside any repo makes `alm search` find its text; Hidden or Private makes it disappear at once.
- Memory regression pass.

## 6. Shipped

(Filled in when the phase lands.)
