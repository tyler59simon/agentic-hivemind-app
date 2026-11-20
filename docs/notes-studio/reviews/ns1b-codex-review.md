# NS-1B code review (Codex, 2026-11-20)

Codex (`gpt-6.2-sol`, effort high, read-only) reviewed commit `52051c8`, the NS-1B implementation, and commit `5043bb0`, the last round of NS-1A fixes. It reported 21 findings. Claude checked each one against the code before fixing it and found all 21 accurate. Twenty are fixed in the commit that follows `52051c8`, each with a regression test that fails when its fix is undone (each fix was reverted in turn to check). R1 is deferred. All 21 are tracked as action items on the Living Memory note "Notes Studio NS-1B: Codex review findings (commits 5043bb0 and 52051c8)".

"Test" names the regression test. Rust tests are named by module path; frontend tests by file and the finding ID in the test name.

## Data loss

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| D1 | An untitled text file lost its text when its tab was switched away and back (the pane mounts only its active tab), and tray Quit did not warn about it | Untitled text lives in a module store in `NewFileTab.tsx`, keyed by tab id and dropped when the tab closes. Tray Quit asks "Quit with an unsaved new text file?" through the same `unsavedUntitled` check the window close uses | `FileTab.test.tsx` D1; `App.quit.test.tsx` |
| D2 | Save As over an existing file replaced it unconditionally, and a tab already showing that file kept its old text and stamp | `files::save_as`: a new name is created only if nothing took it meanwhile (`create_new`); a chosen file is saved over like a page, held from its hash check to the replace. After Save As, Save a copy and the Gone banner's Save as, `refresh` re-reads any tab of the destination: a clean one follows, a dirty one gets the changed banner | `files::tests::save_as_over_a_file_keeps_its_streams_and_never_replaces_binary`; `store.test.ts` D2 |
| D3 | A draft written after Convert to UTF-8 was lost when the file changed or reopened read-only, an editable legacy file lost the conversion, and pressing Convert again wrote the file's text over the earlier draft | The `loaded` event carries `convert`; the store restores a converted draft on every draft path (same hash, clean merge, stale). Convert on a read-only page that has a draft reloads it converted, so the draft's edits come back instead of being overwritten | `session.test.ts` D3; `store.test.ts` D3 (both tests) |
| D4 | Shift_JIS writes U+00A5 YEN SIGN as `0x5C` without reporting it, so the save succeeded and the character read back as a backslash | `encode_body` decodes the bytes it wrote for every non-UTF encoding and counts the characters that differ; a mismatch is the same "cannot be written in" error, which offers Convert | `files::encoding::tests::a_character_the_encoder_writes_as_another_is_refused` |
| D5 | A windows-1252 file holding one byte pair that looks like UTF-8 was guessed as UTF-8 and showed replacement characters | Partial UTF-8 counts as UTF-8 only when its valid multi-byte characters outnumber its runs of invalid bytes; otherwise `chardetng` decides | `files::encoding::tests::a_legacy_file_holding_one_utf8_looking_pair_is_guessed_as_legacy` |

## Path safety and grants

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| P1 | `loose_in` put back an interrupted save before checking links and protected places, and `files::read` put one back even for a read-only load | `loose_in` checks the folder first (`contain::unmoved`) and that the file is not a link, then the protected places, and puts back an aside only where Hivemind may write. `files::read_view` reads without putting anything back; loose files in protected places use it | `files::tests::a_read_of_a_file_hivemind_may_not_write_puts_nothing_back`; `studio::tests::nothing_is_put_back_through_a_moved_folder_and_a_dropped_folder_must_stay_put` |
| P2 | A dropped folder replaced by a junction before the user confirmed registered the junction's target | `take_dropped` checks that the folder is unmoved when the user confirms | `studio::tests::nothing_is_put_back_through_a_moved_folder_and_a_dropped_folder_must_stay_put` |
| P3 | `guard::check` probed for vault marker files under the lowercased path, so a marked vault in a case-sensitive folder was missed | `guard::real` keeps the canonical path in its on-disk case for probes; comparisons still use the lowercase form | `files::guard::tests::a_marked_vault_in_a_case_sensitive_folder_is_protected` |

## The `hmfile` scheme

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| A1 | A grant root replaced by a junction served another folder | Every request checks that the granted root is unmoved (`contain::unmoved`: no link on its path, and it resolves to itself apart from letter case) and answers 404 otherwise | `assets::tests::a_moved_root_or_a_visible_alias_of_a_hidden_folder_serves_nothing` |
| A2 | Hidden parts were checked on the requested path only, so a visible link to `.private/` was served | The hidden-part check also runs on the path after links resolve (`resolved_rel`) | Same test as A1 |
| A3 | The asset base query had `staleTime: Infinity`, so a tab reopened after its grant was pruned kept a dead URL | The query is asked again on every mount | `FileTab.test.tsx` A3 |
| A4 | `HEAD` with a `Range` header answered 206 or 416 | Range applies to `GET` only (RFC 9110 section 14.2) | `assets::tests::head_ignores_range` |

## Instance protocol v2

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| I1 | Under Strict Mode the first, already stopped effect could drain the open queue and drop the files | An effect that ended before its listeners were in place does not drain; a drain that started always opens what Rust handed over | `opening.test.tsx` |
| I2 | The running instance answered a knock only after checking paths on disk and bringing its window forward, so a slow answer made the launcher report an older version | The knock queues the paths as given (`opens::knock_paths`: no disk access) and answers; the window comes forward and `open-requested` is emitted on another thread. `open_pending` checks the paths, as it does for the open dialog. The launcher's message now says the running Hivemind did not take the files and an older version needs a restart | `opens::prune_tests::knock_paths_touch_nothing_and_keep_only_usable_paths`; UI (second launch with paths) |

## Windows specifics

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| W1 | Grant ids hashed the lowercased path, so `A.txt` and `a.txt` in a case-sensitive folder shared one grant and one document | `grant_id` hashes the canonical path in its on-disk case; `Grants::add` also replaces an entry with the same path. NS-1B was not released, so no stored grant ids need migrating | `studio::tests::two_files_differing_only_in_case_get_their_own_grants` |
| W2 | Save As over a file used the settings-file replace and dropped named streams, the creation time and attributes | Fixed with D2: `files::save_as` saves over a file through `files::save` | `files::tests::save_as_over_a_file_keeps_its_streams_and_never_replaces_binary` |

## Regressions

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| R1 | A loose file whose folder later becomes a notebook has two sessions: the recent list opens the loose key, the tree the notebook key | **Deferred.** No data is lost: saves of both are guarded by the hash precondition, and the recent entry still restores the loose draft. A fix needs drafts and tabs moved from one key to the other when a notebook is added | none |
| R2 | Ctrl+N with a loose file focused sent its `@` id to `file_create` | `currentNotebook` ignores loose files, so the fallback notebook (or an untitled file) is used | `store.test.ts` R2 |
| R3 | A merge into a page being converted put the disk's legacy format back | `merged` keeps the UTF-8 format while `convert` is set, and stays dirty even when the result equals their text. `mergeable(l, convert)` accepts a version whose only problem is its encoding | `session.test.ts` R3 |

## Round-3 fixes in `5043bb0`

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| F1 | Two overlapping draft writes that both failed could leave the cache holding a value never written | Writes of one key run one after another (`inOrder`); a failed write or delete makes the cache forget the key, so the next read goes to the disk | `drafts.test.ts` "writes of one key reach the disk in the order they were made", "after failed writes a read goes to the disk" |
| F2 | A rename held only its source path, so the destination could load before its draft moved | `movePath` holds the destination too | `store.test.ts` F2 |

## Limits that remain

- D2: the native save dialog does not report which version of a file the user agreed to replace. Hivemind reads the file right after the dialog returns and saves against that version, so a change in the moment between the two is still replaced.
- D3: a plain draft of a file that later became undecodable stays hidden until the user presses Convert. It is never deleted or overwritten meanwhile.
- I2: the unit test covers the part of the knock that must not touch the disk. The order of the answer and the window activation was checked in the dev app.

## Codex's report

The report as Codex wrote it, with its headings moved one level down. Locations refer to `52051c8`.

### Summary

`52051c8` can lose untitled edits on tab switches, overwrite a Save As destination that changed after confirmation, and drop converted drafts during recovery. Loose-file grants can collide on case-sensitive NTFS, and `hmfile` can follow a replaced grant root or a visible alias into a hidden directory. In `5043bb0`, the move hold leaves the destination open to an early read, and overlapping draft failures can put a failed write back into the cache.

### Severity scale

- **High** means data loss or webview access to a file the user did not choose.
- **Medium** means incorrect behavior a user is likely to encounter.
- **Low** means an edge case.

### 1. Data loss

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| D1 | High | Confirmed defect | `src/features/notes/NewFileTab.tsx:15`; `src/workspace/Workspace.tsx:87`, `:110`; `src/App.tsx:122` | Type into an untitled tab, switch to another tab in the same pane, then switch back. The pane renders only its active tab, and `NewFileTab` initializes its local text to `""` on remount. Tray Quit also skips the untitled-file warning when nothing is running. | Ordinary navigation can discard the whole buffer without a close confirmation. Tray Quit can discard it without warning. | Keep untitled buffers in a store keyed by tab ID. Use the same unsaved check for all quit routes. |
| D2 | High | Confirmed defect | `src-tauri/src/opens.rs:231`, `:237`; `src-tauri/src/files/atomic.rs:90`; `src/features/notes/NewFileTab.tsx:24`; `src/documents/store.ts:102` | Save As checks whether the destination exists after the native dialog returns, then uses an unconditional rename over that path. A file created after the dialog accepted a new name, or updated after overwrite confirmation, can be replaced. If the destination already has a loose-file tab, Save As reuses its document key and `open()` keeps the old buffer and stamp. | Save As can overwrite another program's bytes without confirmation for that version. An already-open destination can then show stale text after the save succeeded. | Keep new-file creation exclusive. For replacement, confirm a specific destination version and replace it under the held-file precondition. Reconcile open sessions and retain any dirty destination buffer. |
| D3 | High | Confirmed defect | `src/documents/store.ts:124`, `:136`, `:210`, `:257` | Convert an invalid UTF-8 file, edit it, and close it after the draft is written. If another editor changes the file and it still opens read-only, the new hash skips converted-draft recovery and the read-only branch hides the draft. Clicking Convert again schedules a write to the same draft key with the newly loaded text. An unchanged, initially editable legacy file also loses the draft's conversion intent because `loaded.convertible` is false. | A second conversion can replace the only copy of the earlier edits. For an initially editable file, the user must request conversion again. | Restore conversion intent independently of `loaded.convertible`. Surface a stale or read-only draft for recovery without replacing it or authorizing a write against the new disk version. |
| D4 | High | Confirmed defect | `src-tauri/src/files/encoding.rs:80`, `:126`, `:142`; `src-tauri/src/files/mod.rs:263` | Insert U+00A5 into an editable Shift_JIS file. The pinned encoder accepts it as byte `5C`, which the decoder reads as U+005C. The byte round-trip check runs on the original file at load time. The save checks encoder errors and never checks that decoding the edited bytes returns the edited text. | Save succeeds and marks the tab clean even though the character changes on reopen. | Check that the encoded body decodes back to the edited text. Route lossy mappings through the same conversion option as unmappable characters. |
| D5 | Medium | Confirmed defect | `src-tauri/src/files/encoding.rs:44`, `:49`, `:52` | A Windows-1252 file containing both `E9` and `C2 A3` has an invalid UTF-8 byte and a valid UTF-8 multibyte sequence. The presence of the latter forces guessed UTF-8 and skips the legacy detector. | Valid legacy text displays replacement characters. Converting that preview writes the replacement characters in place of valid source text. | Treat partial UTF-8 as one detection signal. Compare it with the legacy candidate and offer an encoding choice when the result is ambiguous. |

### 2. Path safety and grants

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| P1 | High | Confirmed defect | `src-tauri/src/studio.rs:46`, `:59`, `:247`; `src-tauri/src/files/mod.rs:171`, `:181` | When the granted file is missing, `loose_in()` attempts recovery before it checks links or protected folders. If the original folder path now leads through a junction to a folder holding a matching interrupted-save aside, recovery moves the aside into place before the grant is refused. `files::read()` also has its own recovery path even when the loose-file caller applies read-only status. | Opening, revealing, or requesting an asset base for a loose file can mutate a directory outside the grant or a directory that has become protected. | Validate the whole path and write permission before trying recovery. Disable implicit recovery on read-only loads. |
| P2 | High | Confirmed defect | `src-tauri/src/opens.rs:259`, `:265`; `src-tauri/src/studio.rs:387`; `src-tauri/src/notebooks/mod.rs:190` | Drop a folder and leave the confirmation open. If its path is replaced by a junction before confirmation, the token still resolves to that pathname. `Registry::add()` canonicalizes it again and registers the junction target. | The webview gains notebook access to a different folder from the one dropped. | Bind the token to the dropped directory's identity and reject confirmation if that identity or path resolution changes. |
| P3 | High | Confirmed defect | `src-tauri/src/files/guard.rs:24`, `:97`, `:105`; `src-tauri/src/opens.rs:234`; `src-tauri/src/studio.rs:63` | In a case-sensitive parent, a marker-only managed vault named `CaseVault` has no entry in the current store's managed-vault list. `check()` lowercases the canonical path before probing for `.living-memory/copies.json` or `vault.json`, so it probes `casevault` instead. | Loose saves and Save As can write into a marked vault that should be read-only. | Use the actual canonical path for filesystem probes. Keep the comparison form separate. |

### 3. `hmfile`

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| A1 | High | Confirmed defect | `src-tauri/src/assets.rs:27`, `:42`, `:131`; `src-tauri/src/files/contain.rs:53` | After an asset URL is issued, replace the granted notebook or loose-file folder with a junction to another unprotected folder. The grant stores a pathname, and `resolve_inside()` treats that pathname's current canonical target as the containment boundary. | An existing URL can serve an allowed file type from a folder the user never granted. | Store and verify the original root identity on each request. Reject a redirected root or ancestor before resolving the asset. |
| A2 | High | Confirmed defect | `src-tauri/src/assets.rs:133`; `src-tauri/src/files/contain.rs:76`; `src-tauri/src/studio.rs:128` | A visible alias such as `preview.png` can resolve to `.private/scan.png` inside the same granted root. Containment passes, and the hidden-part check examines `preview.png`. The notebook text path already checks the resolved relative path as well. | A visible alias exposes a hidden image or PDF that the handler's hidden-path rule would otherwise block. | Apply the hidden-path check to both the requested path and the resolved path. |
| A3 | Medium | Confirmed defect | `src-tauri/src/opens.rs:205`, `:218`; `src/features/notes/FileTab.tsx:214` | Forget the last recent file in a folder, or remove its notebook, then reopen it while its asset-base query is still cached. Pruning removes the opaque ID, but `staleTime: Infinity` lets the remounted tab reuse that URL. | Relative pictures stay broken after the user grants access again, until the query is evicted or the app restarts. | Invalidate affected asset-base queries on grant changes, or key the query by a grant generation. |
| A4 | Low | Confirmed defect | `src-tauri/src/assets.rs:86`, `:158`, `:176` | `HEAD` with `Range: bytes=0-0` returns 206 and a partial length. `HEAD` with an unsatisfiable range returns 416. The handler applies ranges before checking the method. RFC 9110 defines Range for GET and requires servers to ignore it on HEAD. [RFC 9110 section 14.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2) | A metadata probe can report the wrong length or fail on an otherwise readable asset. | Handle HEAD with full-file headers. Apply range parsing only to GET. |

### 4. Instance protocol v2

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| I1 | Medium | Potential risk | `src/main.tsx:21`; `src/features/notes/opening.tsx:37`, `:51`; `src-tauri/src/opens.rs:166` | In the development app's Strict Mode effect replay, the first effect can finish registering after cleanup and still call `drain()`. If its `open_pending()` wins, Rust removes the queued paths and the stopped effect discards the returned refs. | A cold-start or early second-launch request can disappear after the sender received an acknowledgement. | Check the effect's lifetime before draining and give the drain a single consumer that survives effect replay. |
| I2 | Medium | Potential risk | `src-tauri/src/instance.rs:166`, `:181`; `src-tauri/src/lib.rs:1702`, `:1736` | The holder acknowledges only after path validation, queueing, and window activation. If validation of a slow path or window activation delays a current holder past the payload deadline, a later successful token-only knock is classified as `RaisedOnly`. The launcher then says the holder is an older build. | A current holder can prompt an unnecessary restart even if it later queues the files. | Acknowledge immediately after queueing, move window activation off the acknowledgement path, and distinguish a protocol mismatch from a delivery timeout. |

### 5. Windows specifics

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| W1 | High | Confirmed defect | `src-tauri/src/opens.rs:75`, `:120`; `src-tauri/src/studio.rs:40`; `src/documents/keys.ts:7` | Open `A.txt`, edit it, then open a distinct `a.txt` with identical original bytes in a case-sensitive NTFS directory. The second open replaces the first grant under the same lowercase ID and focuses the same document key. The name check ignores case, and the second file passes the first file's byte-hash precondition. | Saving the first tab writes its edits over the second file. | Give distinct filesystem entries distinct grant and document identities. Reuse a grant across case variants only when Windows resolves them to the same entry. |
| W2 | High | Confirmed defect | `src-tauri/src/opens.rs:237`; `src-tauri/src/files/atomic.rs:90`, `:316` | Save As over an NTFS file with a named data stream. The settings-file replacement creates a fresh temp file and renames it over the destination. It bypasses the held replacement's stream and metadata copy. | Save As silently drops bytes in alternate data streams and can discard the destination's creation time and preserved attributes. | Use the checked, metadata-preserving replacement for existing Save As destinations. |

### 6. Regressions

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| R1 | Medium | Confirmed defect | `src-tauri/src/studio.rs:185`, `:387`, `:77`; `src/lib/opens.ts:15`; `src/documents/keys.ts:7` | Open and edit a loose file, then register its parent as a notebook. Opening from the notebook tree creates a notebook key, and the recent list still opens the old `@` key. Neither registration path migrates the tab or draft. | The same file has independent sessions. The notebook tab can hide unsaved edits and drafts that remain under the loose key. | Reconcile affected grants, tabs, and draft keys on registration, with a recovery path if both keys have edits. |
| R2 | Medium | Confirmed defect | `src/features/notes/actions.ts:21`, `:121`; `src-tauri/src/studio.rs:98`, `:291` | Press Ctrl+N on the Notes page with a loose file focused. `currentNotebook()` returns its `@` ID and `newPageHere()` calls `file_create`. Rust refuses the ID. | Ctrl+N fails even when no notebook exists and it should open a new text file. A registered fallback notebook is also ignored. | Exclude loose refs when choosing a notebook and fall back to the first notebook or an untitled file. |
| R3 | Medium | Confirmed defect | `src/documents/session.ts:90`, `:99`; `src/documents/store.ts:277`, `:301` | Choose Convert to UTF-8 on a dirty legacy file, let another editor change the disk version while retaining the legacy encoding, then resolve the merge with text different from the disk version. `merged` preserves `convert` but replaces the UTF-8 format with `theirs.format`. | The UI still promises UTF-8. Save uses the legacy encoding and can repeat the same unmappable-character error. | Keep the intended output format separate from the disk base. Carry it through a merge unless the user changes it. |

### 7. Round-3 fixes in `5043bb0`

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| F1 | High | Confirmed defect | `src/lib/drafts.ts:41`; `src/features/editor/NoteEditor.tsx:97`, `:106` | A Memory note's debounce write can overlap its unmount write. If write A fails while optimistic write B is current, A's rollback does nothing. If B then fails, B restores its captured predecessor A, even though A also failed. | A subsequent load can restore text from a cache entry that was never persisted. The edits disappear on restart. | Serialize writes per draft key or track the last confirmed value separately from in-flight writes. |
| F2 | High | Potential risk | `src/features/notes/actions.ts:59`; `src/documents/store.ts:84`, `:353`; `src-tauri/src/studio.rs:322` | Rename a closed page with a saved draft from A to B. The hold covers A only. Rust renames the file before moving its draft. If another open entry point opens B in that interval, B can load the file and miss its draft. The hold release only starts documents still in `loading`. | B can appear clean while its unsaved edits are hidden. Editing B can overwrite the draft after it arrives. | Hold source and destination keys until the file and draft moves settle. Restart destination loads that began during the operation. |

### Coverage and limits

Reviewed both full patches and their `--stat` output, the phase contract including Shipped and its Deviations, README sections 4 and 5.5 through 5.6, spikes S1 and S7, and the NS-1A round-3 record. Locations refer to `52051c8`, including code carried forward from `5043bb0`.

Traced ordinary loose-file deletion through `Gone`, external replacement through the held hash check, and the UTF-8, BOM, UTF-16, CR, CRLF, and mixed-EOL paths. Checked notebook-only `@` rejection, grant persistence and pruning, asset request headers and containment, instance request limits and deduplication, and the NSIS registration and uninstall hooks. For round 3, also checked registered-path links, exact-name aside recovery, the sidecar fallback and its inline base hash, failed-delete recovery, and the window-close flush.

This was a static, read-only review. I did not run tests, launch the app, or install a build. Explorer associations and multi-select, native dialog timing, real drag and drop, WebView2 response behavior, and a live Memory regression pass remain unverified.