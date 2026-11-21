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

## Changes from building NS-2C

Claude made these choices while building the phase on 2026-11-21, after running the shipped `doc` commands against a throwaway store. Where the text above or below says otherwise, these win.

- **One page tab kind.** A Living Memory page is a `file` tab whose `FileRef.notebook` is the container id `lm:<domain>:<notebook>`, as a loose file's is `@<grant>`. There is no `doc` tab kind and no `doc:` key: the document store's holds, moves, drafts and refreshes (fixed through three Codex rounds in NS-1A and NS-1B) apply to Living Memory pages unchanged. `src/documents/io.ts` picks the adapter by container: `lmdoc.ts` for `lm:` ids, the Rust file commands otherwise. An older build that finds such a tab shows "unknown notebook" and the tab can be closed.
- **Moves keep drafts.** `doc move` runs in a Rust command (`lmdoc_move`) that moves the drafts of the pages it moves the way `file_rename` does: copied first, the old ones removed only after Living Memory moved the pages, put back when it refused. Links are not rewritten (folder notebooks do not rewrite them either until NS-4A).
- **Bodies.** Every command that carries a page body (`doc write`, `doc create`) goes through the Rust command `lm_body`, which measures the JSON-escaped body and sends it as the request's stdin up to 512 KiB, else through `app_data/lm-staging/<uuid>.md` and `--body-file`. The bridge refuses to send any request line over 2 MiB. `doc read` decodes with replacement characters, so the adapter checks the text against the page's revision (SHA-256 of its UTF-8 bytes) and opens a page whose bytes are not UTF-8 read-only.
- **Sections.** Living Memory has no empty sections and `doc delete` takes pages only, so a Living Memory notebook offers New section as a section with its first page (`Section/Untitled.md`) and has no Delete section.
- **Folder notebook domain.** `doc folder set` needs a domain. Hivemind passes the bound domain whose folder holds the notebook (longest prefix), else the domain Hivemind uses by default, and Notebook settings let the user pick another memory domain. The registry entry keeps `domain`, `visibility` and `private`, written after Living Memory accepted the change. Order of a change: `doc folder set` first (what agents see), then the sidecar when it can be written, then the registry copy.
- **Removing a folder notebook** runs `doc folder unset PATH` (no `--forget`): a hidden or private folder stays out of reach as a tombstone, a searchable one leaves the registry. A failure is reported and the notebook is removed from Hivemind anyway.
- **Proposals.** Living Memory records the proposing session's hash, not an author kind, so the inbox shows the session. Accept runs `doc accept`; a page that changed since the proposal's base opens the page merge with the base text from `doc history --version` (the operation that left the page at the base revision) or, when retention removed it, the current page. Edit then accept and a stale merge write the result with `doc write` against the current revision, then settle the proposal with `doc reject ID --reason "Merged by hand in Hivemind"`, since `doc accept` writes only the staged text.
- **Pictures.** The grant for a Living Memory notebook names the notebook folder but serves only files under its `assets/` folder; the store's protection is lifted for those files alone. Links resolve against the page's folder exactly as in folder notebooks (`../assets/...`). Attaching is Attach file… in the page menu (native dialog, `doc attach --from-file`, a link inserted at the end of the page); paste and drop of images is NS-3A for both kinds.
- **Domain pickers.** `domains()` in `src/lib/lm.ts` returns memory domains only, so every picker that lists domains leaves out notebook-only ones; `allDomains()` keeps them for the Notes page.
- **Gate.** `useDocsEnabled()` checks `capabilities.docs.version >= 1` and the `doc` command. Without it the Notes page shows only folder notebooks, with a line saying Living Memory notebooks need an update.

## Changes from the Codex review

The Codex review of `32fee20` (record: `reviews/ns2c-codex-review.md`) changed these decisions on 2026-11-21. Where the text above or below says otherwise, these win.

- **Store binding (D1).** A Living Memory page belongs to the store it was read from. It saves only there, its draft names the store, and saving Settings pauses every Living Memory save until Hivemind has connected again.
- **Proposal merges (D2, D3, D5).** Edit then accept and a stale merge run `doc accept ID --edited --expected-revision R` (Living Memory `a493525`, capability `docs.accept_edited`): the merge is written and the proposal settled as accepted and edited in one operation, so `MERGED` and the `doc reject` step are gone. A page or proposal the merge could not write unchanged is offered Accept, Reject and Open page only.
- **Registering a folder (P1).** Registration sends `doc folder set PATH --domain D` with no visibility or private flag: Living Memory keeps what it holds for the folder, a tombstone included, and makes a new one searchable. The sidecar is written only when the user changes reach in Notebook settings, and then only the fields they changed (P3).
- **Gate (C1).** Folder reach needs `docs.folder_policy` as well as the docs gate.
- **Arguments (C4).** Every `doc` command sends options, then `--`, then its operands.
- **Attachments (U2).** A relative link in a Living Memory page opens its attachment with the program Windows uses for its kind, from a read-only copy in the temporary folder (never an executable kind), or opens the page it names.

The re-review of `75ce884` (same record, round 2) changed these on 2026-11-21:

- **Bridge generation (R2-D1).** Store binding is also checked in Rust: every `doc` request carries the bridge generation `connect` reported, and the bridge refuses one made before Settings pointed it at another store.
- **Store switch (R2-D2, R2-D3, R2-D7).** A page follows a store switch only once its load, save or move has ended, and never while its latest edits are not in a draft. Moves and deletes leave drafts that name another store alone.
- **Folder policy 2 (R2-C2).** Folder reach needs Living Memory's `docs.folder_policy` 2, where `doc folder set` keeps the fields it is not given.
- **Attachments (R2-P2, R2-P3, R2-P4).** Opened copies are cleared at the next start; SVG is not opened outside Hivemind; a notebook folder reached through any link below the store gets no grant.
- **Argument lists (R2-C1).** A `doc` command without operands has no `--`.

The review of `dd4c1b0` (round 3, the last) changed these on 2026-11-21:

- **Parked pages (R3-D2, R3-U2).** A page whose latest edits are not in a draft when Hivemind switches stores is parked: read-only, its edits shown to save as a copy or discard, and nothing reaches the new store from it. It comes back editable, and autosaves, when its store returns; its edits are reported lost if its tab closes first.
- **One store, one name (R3-D7, R3-D8).** `connect` reports the store root as the filesystem names it, and roots are compared exactly. The bridge keeps the verified root for the rest of the generation, so a restarted process never lands in another default store.
- **Actions keep their store (R3-D1, R3-D4).** A move or delete runs against the generation it started in, and a delete drops only the pages and drafts of the store it ran in.

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

Code landed on 2026-11-21: Hivemind `32fee20` (the phase), then `75ce884`, `dd4c1b0` and `e2e86cc` (fixes from three Codex review rounds) and `2ab51dd` (fixes from the UI pass); Living Memory `a493525`, `7f06bda` and `ad1fc3f`.

**Verified**
- `npm test` (90 files, 700 tests), `npx tsc --noEmit`, `npm run build`, `cargo test` (612), `cargo clippy --all-targets` (the same older warning in `lib.rs`). `bridge::tests::a_script_that_fails_shows_its_stderr` failed in two full runs and passed alone; its cause is known and it stays tracked as its own bug.
- `lmdoc::tests::live_pages_through_the_bridge` against a real Living Memory in a temporary store: a notebook-only domain and notebook, small and staged bodies, a stale write, a move that carries a draft, an attachment, an agent's proposal accepted, a page named `-Draft.md` created, moved, merged with `doc accept --edited` and saved, the webview's `doc notebooks` argv, and a request refused after the bridge switched generations.
- Living Memory: the whole unittest suite (2,369 tests, run in chunks) and `scripts/simulate.py` (103 of 103) at `7f06bda`; `ad1fc3f` changes one test.
- Three read-only Codex reviews (18, 16 and 17 findings), each finding checked against the code before it was fixed, each fix with a regression test checked to fail with the fix undone: [reviews/ns2c-codex-review.md](reviews/ns2c-codex-review.md).

**UI pass (2026-11-21).** The dev app ran against a scratch store (notebook `demo/plans`, notebook-only domain `jot`, two memory notes) and a folder notebook outside any bound folder, driven over WebView2 remote debugging. The exit checks:
- A Living Memory page and a memory note side by side in a split, each edited and saved on its own; the page kept its CRLF line endings.
- An agent's `doc propose` showed in the inbox without a reload (the badge went from 1 to 2), and Accept wrote the proposed bytes and settled the proposal. "Edit, then accept" merged a second proposal through `doc accept --edited`. The same agent's `doc write` was refused by the Living Memory guard.
- Folder notebook reach: before Save, `search` and `ask` found nothing; Searchable registered the folder and both found its page; Hidden, and then Searchable with Private, hid it as soon as Save returned; turning Private off brought it back.
- Memory regression: the library, opening a note from it, editing and saving, a note merge after an outside `update` (with conflict markers resolved by hand), the split and the context rail following the focused pane. Domain pickers left the notebook-only domain out.

The pass found three problems, fixed in `2ab51dd` with tests: "Edit, then accept" and "Merge" on a proposal used the wording of a page that changed on disk (the agent's text was labelled "Version on disk"); the rail beside a Living Memory page showed its container id and the breadcrumb said "Notebook"; and one proposal was announced as "1 agent proposals".

One deviation from the exit check: the agent's `doc propose` ran from a shell with the variables a Hivemind terminal sets (`LIVING_MEMORY_ROOT` for the connected store, `HIVEMIND_SESSION`), not inside a Hivemind terminal, because Hivemind offers a plain shell tab only beside an agent session, and starting one is a paid Claude Code or Codex run.

**Deviations**
- A Living Memory page is a `file` tab whose notebook is `lm:<domain>:<notebook>`, not a `doc` tab kind (section "Changes from building NS-2C").
- Merging a proposal is one Living Memory operation, `doc accept ID --edited`, not a write followed by a reject.
- Pages belong to the store they were read from, and the bridge refuses a request made for an earlier store. A page whose edits could not be drafted is parked read-only across a store switch (section "Changes from the Codex review").

**Open**
- Publishing the store root, watcher and generation in `connect` as one step (R3-D9), and a live test that switches a bridge between two roots through `connect` (R3-T1).
