# NS-1B code review (Codex, 2026-11-20)

Codex (`gpt-6.2-sol`, effort high, read-only) reviewed commit `52051c8`, the NS-1B implementation, and commit `5043bb0`, the last round of NS-1A fixes. It reported 21 findings. Claude checked each one against the code before fixing it and found all 21 accurate. Twenty are fixed in the commit that follows `52051c8`, each with a regression test that fails when its fix is undone (each fix was reverted in turn to check). R1 is deferred. A second pass over that fix commit found 18 more items; 17 are fixed in the commit after it and one is disputed (section "Round 2"). All are tracked as action items on the Living Memory note "Notes Studio NS-1B: Codex review findings (commits 5043bb0 and 52051c8)".

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

## Round 2: re-review of `fa08348`

Codex (same model and effort, read-only) reviewed the fix commit. It found nine fixes incomplete, five new defects and four tests that would not catch a regression. Claude checked each against the code: seventeen are fixed in the next commit, each with a test that fails when its fix is undone, and one (N4) is disputed. Two of the incomplete fixes (D3b, W1) widen behaviour that NS-1A shipped.

### Fixes that were incomplete

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| D2 | Save As re-read the destination, but a load of it in flight could still publish the old bytes | `refresh` waits for a load in flight before it checks the page | `store.test.ts` "D2: Save as over a page that is still loading" |
| D3a | A draft lookup that failed counted as no draft, so Convert could write over the draft it could not see | Convert refuses with an error when the lookup fails | `store.test.ts` "D3: Convert refuses when the draft lookup fails" |
| D3b | A draft of a file that opened read-only for another reason (the read-only attribute) stayed hidden, and Save a copy saved the disk text | The read-only page keeps the draft (`kept`) and shows it: "Save the edits as a copy…", or for a file read-only only for its encoding, a pointer to Convert | `session.test.ts` and `store.test.ts` "D3: a draft the file can no longer take" |
| D5 | Two invalid bytes side by side counted as two runs | Invalid bytes with nothing valid between them count as one run | `files::encoding::tests::a_legacy_file_holding_one_utf8_looking_pair_is_guessed_as_legacy` |
| P1 | Loose files ignored the reserved folders `.git`, `.obsidian` and `.hivemind`, which README 5.3 protects | `guard::reserved`: a loose file there opens read-only (and nothing is put back there), and Save As refuses it | `files::guard::tests::reserved_folders_are_named_whatever_their_case`, `studio::tests::a_loose_file_in_a_reserved_folder_is_read_only` |
| A3 | The app's 30-second `staleTime` still served a withdrawn grant on a quick reopen | Every mount asks for the asset base again (`refetchOnMount: "always"`), and the query is dropped when its page closes (`gcTime: 0`) | `FileTab.test.tsx` A3, now with the app's query defaults |
| W1 | Notebook pages were still keyed by the lowercased path, so `A.txt` and `a.txt` in a case-sensitive notebook folder shared a document and a draft | Page keys and draft keys keep letter case (`keys.ts`, `drafts::file_key`, `movedPath`, `drafts::retarget`). This supersedes the NS-1A rule that keys ignore case; a case-only rename in Hivemind moves the document to its new key | `keys.test.ts`, `store.test.ts` W1, `workspace/files.test.ts`, `drafts::tests::the_file_key_matches_the_webview` |
| F1 | A failed delete could clear the cache entry of a later delete still on its way | Each write or delete carries its own number; a failure forgets the cache only while it is still the newest change | `drafts.test.ts` "a failed delete never hides a later one" |
| F2 | A rename onto a page deleted on disk but still holding unsaved edits overwrote them | The move is refused when a page at the destination has unsaved edits (webview) or a draft (Rust, `drafts::any_under` in `file_rename`) | `store.test.ts` "F2: a rename onto a page with unsaved edits is refused", `drafts::tests::a_draft_at_or_below_a_path_is_found` |

### New defects

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| N1 | Save As over a link would hold the file it points to and rename that | `files::save_as` refuses a link (a junction is the same kind of link to this check) | `files::tests::save_as_refuses_a_link` (a junction where a file symlink needs Developer Mode) |
| N2 | Save As and the held save read a file of any size | Save As refuses a file over 64 MB before reading it; the held save refuses one that grew past 64 MB | `files::tests::neither_save_nor_save_as_reads_a_file_over_64_mb` |
| N3 | Text typed during an untitled file's Save As was dropped when the tab became the saved file | Text that changed meanwhile stays as unsaved edits of the saved file; a second Save As while one runs does nothing | `store.test.ts` N3 |
| N4 | `unmoved` checks a path and lets it go; a junction swapped in between the check and the use is followed | **Disputed.** The swap needs a same-user process that can already write these folders, which the trust model (README section 4) leaves out; junctions present when the check runs are refused, which is the consistency NS-1A set. Binding each use to an opened directory handle is not done | none |
| N5 | After a case-only rename in a case-insensitive folder, reopening a loose file made a second grant, so its tab and draft were left behind | `Grants::add` keeps the grant whose stored path still resolves to the same file, and the file keeps its granted name | `studio::tests::a_case_only_rename_keeps_a_loose_files_grant_and_tab` |

### Tests that would pass with the old code

| ID | Finding | Fix |
| --- | --- | --- |
| A3 | The test used a bare `QueryClient` (stale time zero) | It uses the app's defaults |
| D2, W2 | Nothing raced the Save As write | `files::tests::save_as_never_replaces_what_appeared_or_changed_after_it_looked` creates the file, and changes it, between Save As's look and its write |
| I1 | The test counted tabs, which the stopped effect could also open | It also asserts that the queue is drained once |
| F2 | The source session was in memory and a fixed delay guessed when the rename started | The source is closed with its draft only on disk, and the test waits for the rename call |

## Limits that remain

- D2: the native save dialog does not report which version of a file the user agreed to replace. Hivemind reads the file right after the dialog returns and saves against that version, so a change in the moment between the two is still replaced.
- D3: a draft of a file that became undecodable is shown beside the read-only page and comes back into the editor when the user presses Convert. It is never deleted or overwritten meanwhile.
- I2: the unit test covers the part of the knock that must not touch the disk. The order of the answer and the window activation was checked in the dev app.
- N4: each check of a granted or registered folder looks at its path, then the operation uses the path again; a junction swapped in between is followed (trust model).
- In a case-insensitive folder, a file opened under two spellings (a stale tab after a rename outside Hivemind) is two documents. Both saves are checked against the file's hash, so neither overwrites the other's changes unseen.

## Codex's report

Both reports as Codex wrote them, with their headings moved down. Locations in the first refer to `52051c8`, in the second to `fa08348`.

### Round 1

#### Summary

`52051c8` can lose untitled edits on tab switches, overwrite a Save As destination that changed after confirmation, and drop converted drafts during recovery. Loose-file grants can collide on case-sensitive NTFS, and `hmfile` can follow a replaced grant root or a visible alias into a hidden directory. In `5043bb0`, the move hold leaves the destination open to an early read, and overlapping draft failures can put a failed write back into the cache.

#### Severity scale

- **High** means data loss or webview access to a file the user did not choose.
- **Medium** means incorrect behavior a user is likely to encounter.
- **Low** means an edge case.

#### 1. Data loss

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| D1 | High | Confirmed defect | `src/features/notes/NewFileTab.tsx:15`; `src/workspace/Workspace.tsx:87`, `:110`; `src/App.tsx:122` | Type into an untitled tab, switch to another tab in the same pane, then switch back. The pane renders only its active tab, and `NewFileTab` initializes its local text to `""` on remount. Tray Quit also skips the untitled-file warning when nothing is running. | Ordinary navigation can discard the whole buffer without a close confirmation. Tray Quit can discard it without warning. | Keep untitled buffers in a store keyed by tab ID. Use the same unsaved check for all quit routes. |
| D2 | High | Confirmed defect | `src-tauri/src/opens.rs:231`, `:237`; `src-tauri/src/files/atomic.rs:90`; `src/features/notes/NewFileTab.tsx:24`; `src/documents/store.ts:102` | Save As checks whether the destination exists after the native dialog returns, then uses an unconditional rename over that path. A file created after the dialog accepted a new name, or updated after overwrite confirmation, can be replaced. If the destination already has a loose-file tab, Save As reuses its document key and `open()` keeps the old buffer and stamp. | Save As can overwrite another program's bytes without confirmation for that version. An already-open destination can then show stale text after the save succeeded. | Keep new-file creation exclusive. For replacement, confirm a specific destination version and replace it under the held-file precondition. Reconcile open sessions and retain any dirty destination buffer. |
| D3 | High | Confirmed defect | `src/documents/store.ts:124`, `:136`, `:210`, `:257` | Convert an invalid UTF-8 file, edit it, and close it after the draft is written. If another editor changes the file and it still opens read-only, the new hash skips converted-draft recovery and the read-only branch hides the draft. Clicking Convert again schedules a write to the same draft key with the newly loaded text. An unchanged, initially editable legacy file also loses the draft's conversion intent because `loaded.convertible` is false. | A second conversion can replace the only copy of the earlier edits. For an initially editable file, the user must request conversion again. | Restore conversion intent independently of `loaded.convertible`. Surface a stale or read-only draft for recovery without replacing it or authorizing a write against the new disk version. |
| D4 | High | Confirmed defect | `src-tauri/src/files/encoding.rs:80`, `:126`, `:142`; `src-tauri/src/files/mod.rs:263` | Insert U+00A5 into an editable Shift_JIS file. The pinned encoder accepts it as byte `5C`, which the decoder reads as U+005C. The byte round-trip check runs on the original file at load time. The save checks encoder errors and never checks that decoding the edited bytes returns the edited text. | Save succeeds and marks the tab clean even though the character changes on reopen. | Check that the encoded body decodes back to the edited text. Route lossy mappings through the same conversion option as unmappable characters. |
| D5 | Medium | Confirmed defect | `src-tauri/src/files/encoding.rs:44`, `:49`, `:52` | A Windows-1252 file containing both `E9` and `C2 A3` has an invalid UTF-8 byte and a valid UTF-8 multibyte sequence. The presence of the latter forces guessed UTF-8 and skips the legacy detector. | Valid legacy text displays replacement characters. Converting that preview writes the replacement characters in place of valid source text. | Treat partial UTF-8 as one detection signal. Compare it with the legacy candidate and offer an encoding choice when the result is ambiguous. |

#### 2. Path safety and grants

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| P1 | High | Confirmed defect | `src-tauri/src/studio.rs:46`, `:59`, `:247`; `src-tauri/src/files/mod.rs:171`, `:181` | When the granted file is missing, `loose_in()` attempts recovery before it checks links or protected folders. If the original folder path now leads through a junction to a folder holding a matching interrupted-save aside, recovery moves the aside into place before the grant is refused. `files::read()` also has its own recovery path even when the loose-file caller applies read-only status. | Opening, revealing, or requesting an asset base for a loose file can mutate a directory outside the grant or a directory that has become protected. | Validate the whole path and write permission before trying recovery. Disable implicit recovery on read-only loads. |
| P2 | High | Confirmed defect | `src-tauri/src/opens.rs:259`, `:265`; `src-tauri/src/studio.rs:387`; `src-tauri/src/notebooks/mod.rs:190` | Drop a folder and leave the confirmation open. If its path is replaced by a junction before confirmation, the token still resolves to that pathname. `Registry::add()` canonicalizes it again and registers the junction target. | The webview gains notebook access to a different folder from the one dropped. | Bind the token to the dropped directory's identity and reject confirmation if that identity or path resolution changes. |
| P3 | High | Confirmed defect | `src-tauri/src/files/guard.rs:24`, `:97`, `:105`; `src-tauri/src/opens.rs:234`; `src-tauri/src/studio.rs:63` | In a case-sensitive parent, a marker-only managed vault named `CaseVault` has no entry in the current store's managed-vault list. `check()` lowercases the canonical path before probing for `.living-memory/copies.json` or `vault.json`, so it probes `casevault` instead. | Loose saves and Save As can write into a marked vault that should be read-only. | Use the actual canonical path for filesystem probes. Keep the comparison form separate. |

#### 3. `hmfile`

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| A1 | High | Confirmed defect | `src-tauri/src/assets.rs:27`, `:42`, `:131`; `src-tauri/src/files/contain.rs:53` | After an asset URL is issued, replace the granted notebook or loose-file folder with a junction to another unprotected folder. The grant stores a pathname, and `resolve_inside()` treats that pathname's current canonical target as the containment boundary. | An existing URL can serve an allowed file type from a folder the user never granted. | Store and verify the original root identity on each request. Reject a redirected root or ancestor before resolving the asset. |
| A2 | High | Confirmed defect | `src-tauri/src/assets.rs:133`; `src-tauri/src/files/contain.rs:76`; `src-tauri/src/studio.rs:128` | A visible alias such as `preview.png` can resolve to `.private/scan.png` inside the same granted root. Containment passes, and the hidden-part check examines `preview.png`. The notebook text path already checks the resolved relative path as well. | A visible alias exposes a hidden image or PDF that the handler's hidden-path rule would otherwise block. | Apply the hidden-path check to both the requested path and the resolved path. |
| A3 | Medium | Confirmed defect | `src-tauri/src/opens.rs:205`, `:218`; `src/features/notes/FileTab.tsx:214` | Forget the last recent file in a folder, or remove its notebook, then reopen it while its asset-base query is still cached. Pruning removes the opaque ID, but `staleTime: Infinity` lets the remounted tab reuse that URL. | Relative pictures stay broken after the user grants access again, until the query is evicted or the app restarts. | Invalidate affected asset-base queries on grant changes, or key the query by a grant generation. |
| A4 | Low | Confirmed defect | `src-tauri/src/assets.rs:86`, `:158`, `:176` | `HEAD` with `Range: bytes=0-0` returns 206 and a partial length. `HEAD` with an unsatisfiable range returns 416. The handler applies ranges before checking the method. RFC 9110 defines Range for GET and requires servers to ignore it on HEAD. [RFC 9110 section 14.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.2) | A metadata probe can report the wrong length or fail on an otherwise readable asset. | Handle HEAD with full-file headers. Apply range parsing only to GET. |

#### 4. Instance protocol v2

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| I1 | Medium | Potential risk | `src/main.tsx:21`; `src/features/notes/opening.tsx:37`, `:51`; `src-tauri/src/opens.rs:166` | In the development app's Strict Mode effect replay, the first effect can finish registering after cleanup and still call `drain()`. If its `open_pending()` wins, Rust removes the queued paths and the stopped effect discards the returned refs. | A cold-start or early second-launch request can disappear after the sender received an acknowledgement. | Check the effect's lifetime before draining and give the drain a single consumer that survives effect replay. |
| I2 | Medium | Potential risk | `src-tauri/src/instance.rs:166`, `:181`; `src-tauri/src/lib.rs:1702`, `:1736` | The holder acknowledges only after path validation, queueing, and window activation. If validation of a slow path or window activation delays a current holder past the payload deadline, a later successful token-only knock is classified as `RaisedOnly`. The launcher then says the holder is an older build. | A current holder can prompt an unnecessary restart even if it later queues the files. | Acknowledge immediately after queueing, move window activation off the acknowledgement path, and distinguish a protocol mismatch from a delivery timeout. |

#### 5. Windows specifics

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| W1 | High | Confirmed defect | `src-tauri/src/opens.rs:75`, `:120`; `src-tauri/src/studio.rs:40`; `src/documents/keys.ts:7` | Open `A.txt`, edit it, then open a distinct `a.txt` with identical original bytes in a case-sensitive NTFS directory. The second open replaces the first grant under the same lowercase ID and focuses the same document key. The name check ignores case, and the second file passes the first file's byte-hash precondition. | Saving the first tab writes its edits over the second file. | Give distinct filesystem entries distinct grant and document identities. Reuse a grant across case variants only when Windows resolves them to the same entry. |
| W2 | High | Confirmed defect | `src-tauri/src/opens.rs:237`; `src-tauri/src/files/atomic.rs:90`, `:316` | Save As over an NTFS file with a named data stream. The settings-file replacement creates a fresh temp file and renames it over the destination. It bypasses the held replacement's stream and metadata copy. | Save As silently drops bytes in alternate data streams and can discard the destination's creation time and preserved attributes. | Use the checked, metadata-preserving replacement for existing Save As destinations. |

#### 6. Regressions

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| R1 | Medium | Confirmed defect | `src-tauri/src/studio.rs:185`, `:387`, `:77`; `src/lib/opens.ts:15`; `src/documents/keys.ts:7` | Open and edit a loose file, then register its parent as a notebook. Opening from the notebook tree creates a notebook key, and the recent list still opens the old `@` key. Neither registration path migrates the tab or draft. | The same file has independent sessions. The notebook tab can hide unsaved edits and drafts that remain under the loose key. | Reconcile affected grants, tabs, and draft keys on registration, with a recovery path if both keys have edits. |
| R2 | Medium | Confirmed defect | `src/features/notes/actions.ts:21`, `:121`; `src-tauri/src/studio.rs:98`, `:291` | Press Ctrl+N on the Notes page with a loose file focused. `currentNotebook()` returns its `@` ID and `newPageHere()` calls `file_create`. Rust refuses the ID. | Ctrl+N fails even when no notebook exists and it should open a new text file. A registered fallback notebook is also ignored. | Exclude loose refs when choosing a notebook and fall back to the first notebook or an untitled file. |
| R3 | Medium | Confirmed defect | `src/documents/session.ts:90`, `:99`; `src/documents/store.ts:277`, `:301` | Choose Convert to UTF-8 on a dirty legacy file, let another editor change the disk version while retaining the legacy encoding, then resolve the merge with text different from the disk version. `merged` preserves `convert` but replaces the UTF-8 format with `theirs.format`. | The UI still promises UTF-8. Save uses the legacy encoding and can repeat the same unmappable-character error. | Keep the intended output format separate from the disk base. Carry it through a merge unless the user changes it. |

#### 7. Round-3 fixes in `5043bb0`

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| F1 | High | Confirmed defect | `src/lib/drafts.ts:41`; `src/features/editor/NoteEditor.tsx:97`, `:106` | A Memory note's debounce write can overlap its unmount write. If write A fails while optimistic write B is current, A's rollback does nothing. If B then fails, B restores its captured predecessor A, even though A also failed. | A subsequent load can restore text from a cache entry that was never persisted. The edits disappear on restart. | Serialize writes per draft key or track the last confirmed value separately from in-flight writes. |
| F2 | High | Potential risk | `src/features/notes/actions.ts:59`; `src/documents/store.ts:84`, `:353`; `src-tauri/src/studio.rs:322` | Rename a closed page with a saved draft from A to B. The hold covers A only. Rust renames the file before moving its draft. If another open entry point opens B in that interval, B can load the file and miss its draft. The hold release only starts documents still in `loading`. | B can appear clean while its unsaved edits are hidden. Editing B can overwrite the draft after it arrives. | Hold source and destination keys until the file and draft moves settle. Restart destination loads that began during the operation. |

#### Coverage and limits

Reviewed both full patches and their `--stat` output, the phase contract including Shipped and its Deviations, README sections 4 and 5.5 through 5.6, spikes S1 and S7, and the NS-1A round-3 record. Locations refer to `52051c8`, including code carried forward from `5043bb0`.

Traced ordinary loose-file deletion through `Gone`, external replacement through the held hash check, and the UTF-8, BOM, UTF-16, CR, CRLF, and mixed-EOL paths. Checked notebook-only `@` rejection, grant persistence and pruning, asset request headers and containment, instance request limits and deduplication, and the NSIS registration and uninstall hooks. For round 3, also checked registered-path links, exact-name aside recovery, the sidecar fallback and its inline base hash, failed-delete recovery, and the window-close flush.

This was a static, read-only review. I did not run tests, launch the app, or install a build. Explorer associations and multi-select, native dialog timing, real drag and drop, WebView2 response behavior, and a live Memory regression pass remain unverified.

### Round 2

#### Summary

`fa08348` fixes several of the reported paths, including untitled tab switches, lossy Shift_JIS saves, loose-file grant collisions, and `HEAD` range handling. Draft recovery can still overwrite an earlier draft after a read error, and renaming onto a missing file can overwrite edits still held under the destination path. Save As can discard edits typed while it refreshes the destination, and its Windows replacement path can move the target of a file symlink if the picker returns the link itself. The asset grant refresh still fails for quick reopens in the app, even though its regression test passes with the test client's cache defaults.

#### Severity scale

- **High** means data loss or access to a file the user did not choose.
- **Medium** means wrong behavior a user will hit.
- **Low** means an edge case.

#### Fix completeness

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| D2 | Medium | Confirmed defect | `src/features/notes/actions.ts:80`; `src/documents/store.ts:102`, `:124`, `:338` | Save As calls `refresh`, but `recheck` skips a destination in `loading`. If that load already read the old bytes and is waiting for its draft, it can publish the old bytes after Save As succeeds. Later `open` calls reuse the session. | An already-open destination can show the old text and stamp. Loose files have no watcher to correct it. | Wait for the in-flight load and recheck the current session, or restart that load against the saved destination. |
| D3a | High | Confirmed defect | `src/documents/store.ts:124`, `:256`, `:207`; `src-tauri/src/drafts.rs:30` | Both draft lookups turn errors into `null`. If the Convert lookup fails, the code converts the disk preview and schedules a `draft_put` under the existing key. A transient read failure can clear before that write. | Convert can replace the only copy of the user's earlier edits. | Distinguish a missing draft from a failed lookup. Block draft writes for that conversion until recovery succeeds or the user explicitly discards the old draft. |
| D3b | Medium | Confirmed defect | `src/documents/store.ts:131`; `src-tauri/src/files/mod.rs:204`; `src/features/notes/FileTab.tsx:87` | A converted draft is still hidden if the file becomes read-only for a reason other than encoding. Setting the Windows read-only attribute is enough, even with the original hash. The copy action receives `doc.text`, which contains the disk preview. | The user cannot recover the converted edits through the tab or its Save a copy action while the restriction remains. | Surface the stored draft as recoverable text and allow copying or saving it elsewhere while keeping the original read-only. |
| D5 | Low | Confirmed defect | `src-tauri/src/files/encoding.rs:47` | The loop counts invalid UTF-8 chunks rather than contiguous invalid byte runs. Two adjacent `FF` bytes produce two invalid chunks. With two valid multibyte characters elsewhere, the counts tie and the file falls through to legacy detection despite having one contiguous invalid run. | A damaged UTF-8 file can display legacy mojibake where the documented rule would show its valid characters and a read-only warning. | Define the intended invalid-run rule, count consecutive invalid bytes accordingly, and cover the boundary with a fixture. |
| P1 | Medium | Confirmed defect | `docs/notes-studio/README.md:125`; `src-tauri/src/files/guard.rs:104`; `src-tauri/src/studio.rs:54`, `:77`; `src-tauri/src/opens.rs:253` | `Protected::check` checks the app data, store and vaults, but omits the reserved `.git`, `.obsidian` and `.hivemind` components. `ref_in` can grant a file under one of those components as a loose file after notebook visibility rejects it. Loose recovery and Save As then use the shared guard. | A reserved file can be restored or written through the loose-file path despite the protected-target contract. | Check reserved components after resolution and keep explicit exceptions in the sidecar and trash operations. |
| A3 | Medium | Confirmed defect | `src/features/notes/FileTab.tsx:208`; `src/main.tsx:13` | Removing `staleTime: Infinity` exposes the app-wide 30-second `staleTime`. A quick remount can reuse a fresh cached URL after Rust has withdrawn its grant. | Relative pictures can remain broken when the user promptly reopens a file. | Invalidate the affected query when a grant changes, or explicitly refetch the asset base on mount. |
| W1 | High | Confirmed defect | `src-tauri/src/studio.rs:77`; `src/documents/keys.ts:7`; `src/documents/store.ts:102`, `:274`; `src/features/notes/NotebookTree.tsx:117` | Loose grants now distinguish `A.txt` and `a.txt`. Inside a notebook those paths still share a lowercased key. Opening `a.txt` beside a dirty `A.txt` replaces the shared session's target ref and retains its buffer and stamp. Identical originals satisfy the hash check. | Saving the shared buffer can write `A.txt`'s edits into `a.txt`. | Use canonical file identity consistently for notebook sessions, save targets and draft keys. |
| F1 | Low | Confirmed defect | `src/lib/drafts.ts:59`, `:76`; `src/features/editor/NoteEditor.tsx:73`, `:97` | Every queued delete uses the same `null` cache value. If delete A fails after delete B has been queued, A's handler can clear B's pending cache entry. A Memory note remounted before B finishes can read the old draft from disk. | A draft pending deletion can reappear in the Memory editor. | Give each queued mutation a distinct cache token and let failures invalidate only their own entry. |
| F2 | High | Confirmed defect | `src/features/notes/actions.ts:63`; `src/documents/store.ts:357`, `:385`; `src-tauri/src/drafts.rs:65` | The hold waits for destination drafts without checking for a collision. If `B.md` was deleted on disk but still has unsaved edits, renaming a dirty `A.md` to `B.md` can overwrite B's draft in Rust and assign A's session over B's in the frontend. | B's unsaved edits can disappear from both the editor and disk recovery. | Detect destination session and draft conflicts before renaming. Refuse the move or preserve both buffers for recovery. |

#### New defects

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| N1 (D2/W2) | High | Potential risk | `src-tauri/src/opens.rs:250`; `src-tauri/src/files/mod.rs:333`; `src-tauri/src/files/atomic.rs:128`, `:316` | If the native picker returns a final symlink pathname, the read and held open follow the link, but `Held` keeps the link pathname. On the same volume, the handle rename can move the target aside while the link remains at the destination. Both installing the replacement and rolling back to that pathname can then fail. | Save As can return an error after moving a different file away from its original pathname. | Reject final links before opening for replacement, and verify that the held entry is the one the operation will rename. |
| N2 (D2) | Medium | Confirmed defect | `src-tauri/src/files/mod.rs:199`, `:292`, `:333` | Save As reads the entire existing destination, then `save` reads it again through the held handle and decodes it. Neither path enforces the editor's 64 MB limit. | Selecting a large existing log can stall or terminate the app under memory pressure. | Bound both the initial snapshot and the held read before allocating or decoding the file. |
| N3 (D1/D2) | High | Confirmed defect | `src/features/notes/NewFileTab.tsx:22`, `:35`, `:54`; `src/features/notes/actions.ts:80`, `:87` | The save captures one text snapshot and leaves the untitled editor editable while it awaits the destination refresh. Completion clears the dirty bit and converts the tab. The workspace subscription then deletes the untitled buffer, even if the user typed after the snapshot. | Text entered after the save began can disappear when the tab switches to the saved file. | Check the buffer revision before converting the tab. Preserve newer edits as dirty text and coalesce concurrent saves. |
| N4 (A1/P1/P2) | High | Potential risk | `src-tauri/src/files/contain.rs:99`; `src-tauri/src/assets.rs:134`; `src-tauri/src/studio.rs:49`, `:386`; `src-tauri/src/notebooks/mod.rs:190` | `unmoved` checks a pathname and releases it. Asset serving canonicalizes the original pathname again, loose recovery uses it again, and dropped-folder registration canonicalizes it again after checking the token. A junction swap between those steps can change what the operation uses. | A grant can serve from the replacement folder, recovery can mutate it, or a drop can register it. | Bind validation and use to the same opened directory and its identity. Reject a redirected root before serving, recovering or registering. |
| N5 (W1) | Medium | Confirmed defect | `src-tauri/src/opens.rs:94`, `:139`; `src-tauri/src/studio.rs:85`; `src/documents/keys.ts:7`, `:24` | After a case-only rename in a case-insensitive folder, reopening the same file under its new on-disk spelling produces a new grant and draft key. `Grants::add` compares the old and new stored paths case-sensitively and keeps both entries. | Reopening the renamed file through Explorer can show a clean tab while the user's edits remain under the old recent entry. | Reuse or migrate the grant when both spellings resolve to the same filesystem entry, while keeping distinct case-sensitive entries separate. |

#### Tests

| ID | Severity | Status | Location | Evidence | Impact | Fix |
|---|---|---|---|---|---|---|
| A3 | Medium | Confirmed defect | `src/features/notes/FileTab.test.tsx:117`; `src/main.tsx:13` | The test uses a bare `QueryClient`, whose default stale time is zero. It fails with the old explicit `Infinity`, but passes with the current query while the production failure remains. It checks call count only. | The test does not establish that a quick reopen gets a usable grant in the app. | Use the app's query defaults, withdraw the first grant, and assert that the remounted page uses the new URL. |
| D2/W2 | High | Confirmed defect | `src-tauri/src/files/mod.rs:606`; `src/documents/store.test.ts:628` | The Rust test checks streams and binary refusal, so it distinguishes those changes from the old writer. Its new-name case has no competing creation, and its overwrite case never changes the file after the snapshot. Those assertions also pass with an unconditional writer that preserves streams and rejects binary. The frontend test covers an already-clean destination only. | The tests leave both overwrite races and the in-flight destination load unverified. | Gate a competing create and a post-snapshot change. Add a frontend test that holds the old load after it reads the file. |
| I1 | Low | Confirmed defect | `src/features/notes/opening.test.tsx:14`, `:31`; `src/features/notes/opening.tsx:39`, `:53` | The test fails if both changes revert. It passes with or without the stopped-effect check before `drain`, because the stopped effect can consume the queue and still open the returned refs under the new result handling. It asserts tabs rather than drain calls. | The test does not enforce that only the live effect starts the initial drain. | Assert which effect starts the drain. Separately hold a valid drain across cleanup and verify that its result still opens. |
| F2 | Low | Confirmed defect | `src/documents/store.test.ts:644`; `src/documents/store.ts:385` | The no-read assertion detects removal of the destination hold once the rename has started. The final dirty-text assertion can pass either way because the test already has the source session in memory and `retarget` copies it over the destination. The test uses a fixed delay to guess when the rename starts. | It does not prove that a closed page opened at the destination reads its moved draft. | Wait for an explicit signal from the rename mock, start with a closed source and a disk-only draft, and verify the destination restores it. |

#### Coverage and limits

I reviewed `fa08348` against its parent `52051c8`, the touched files, the findings ledger and the phase contract. Static tracing supports the original cases for D1 tab switching and tray Quit, D4, P3, A2's hidden-path check, A4, I1, I2's holder-side latency, R2 and R3. It also supports W2's ordinary stream-preserving replacement and W1's distinct loose grants. The moved-root and dropped-folder checks reject junctions already present when validation runs, and the D3 and F1 tests distinguish the original failures from their ordinary fixed paths.

The I2 helper test passes if the holder callback is reverted while the helper remains available. The review ledger already records that the callback ordering was checked separately in the dev app. The revised D5 fixtures in `binary_undecodable_and_mixed_files_are_read_only`, `convert_to_utf8_saves_over_undecodable_text_but_never_binary`, and `a_save_never_replaces_a_file_that_became_binary_or_undecodable` also pass with either detector. The legacy input in the dedicated D5 test distinguishes the thresholds.

This was a read-only review. I did not run tests, build, install, or launch the app. Native picker behavior for symlinks, live Windows and WebView2 behavior, and a live Memory regression pass remain unverified.
