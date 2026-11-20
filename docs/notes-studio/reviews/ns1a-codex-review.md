# NS-1A code review (Codex, 2026-11-20)

Codex (`gpt-6.2-sol`, effort high, read-only) reviewed commit `32fd236`, the NS-1A implementation. It reported 28 findings and marked every one a confirmed defect. Claude checked each one against the code before fixing it, and found all 28 accurate. Claude added two more of its own (C1, C2). All 30 are fixed in the commit that follows `32fd236`, each with a regression test unless the row says how it was checked instead. They are tracked as action items on the Living Memory note "Notes Studio NS-1A: Codex review findings (commit 32fd236)".

"Test" names the regression test; "UI" means it was checked in the running app over CDP.

## Data loss

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| D1 | A second pane on the same page wrote its older buffer back over the first pane's edits | `CodeEditor` takes `follow`: a file tab applies every store change made elsewhere as a minimal edit, marked so it is not reported back and not added to that pane's undo history | `CodeEditor.test.ts` "two panes of one page"; UI |
| D2 | A merge was saved against whatever outside version had arrived last, not the one the dialog showed | `resolveMerge(key, text, theirs)` saves against the version shown; a newer one makes the save stale and asks for another merge | `store.test.ts` D2 |
| D3 | A merge against a file that had become binary or undecodable could replace it with text | Rust `save` refuses to replace bytes that are not editable text (`not_editable`); the tab shows a banner without Merge | `files::tests::a_save_never_replaces_a_file_that_became_binary_or_undecodable` |
| D4 | A draft kept without its base (pages over 2 MB) merged cleanly over every outside change | Such a draft opens against an empty base, so every difference is a conflict the user resolves | `store.test.ts` D4 |
| D5 | Quitting before the draft timer fired lost the last edits | Both quit paths call `flushAllDrafts()` first; edits that cannot be kept are named and the user decides | `store.test.ts` D5 and D9 |
| D6 | Try again after a failed open deleted the draft | Try again only reopens; `open` retries a failed load and never touches the draft | `store.test.ts` D6 |
| D7 | A draft write could land under the old key after Rust moved the drafts for a rename | Draft writes of one document run in order; `beforeMove` writes pending drafts and waits for writes, saves and loads before Rust moves anything, and defers new ones | `store.test.ts` S2 and D7 |
| D8 | Deleting a page or section with unsaved edits discarded the drafts without saying so | Both delete dialogs name the pages with unsaved edits and the action becomes "Delete and lose my edits" | `store.test.ts` D8; UI |
| D9 | Draft size was measured in characters and failed draft writes were silent | Sizes are UTF-8 bytes (12 MB limit, under Rust's 32 MB); a failed write sets `draftError`, shown as a banner and reported at quit | `store.test.ts` D5 and D9 |

## Path safety

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| P1 | Registering app data, or a folder holding it, let file commands edit `notebooks.json` | Hivemind's data, config and webview folders are protected places (`guard::set_app_dirs`); registry entries with ids Hivemind did not make are ignored | `guard::tests::hiveminds_own_data_cannot_be_a_notebook_or_reached_from_one`, `notebooks::tests::ids_hivemind_did_not_make_are_ignored` |
| P2 | Reserved names were checked on the path as spelled, and read and reveal did not check them | Every command checks the spelled path and the path after links inside the notebook resolve (`contain::resolved_rel`); rename and trash resolve their source as a write | `studio::tests::a_link_to_a_hidden_folder_is_hidden_too` |
| P3 | A vault marked by `.living-memory` below a notebook showed in the tree and moved with its parent | The tree leaves marked vaults out; moving or deleting a folder that holds one is refused (`check_no_vault_inside`) | `guard::tests::a_folder_holding_a_marked_vault_cannot_move`, `notebooks::tests::the_tree_leaves_out_marked_vaults_and_brings_back_interrupted_saves` |
| P4 | A registered folder later replaced by a junction was followed | `root_of` refuses a notebook whose folder no longer resolves to the path that was registered | Checked by reading; a junction swap test needs the registry in app state |
| P5 | The sidecar fallback was written but the notebook copy was still read first | The newer of the two copies is read and patched | `sidecar::tests::a_fallback_written_beside_a_readable_notebook_copy_is_the_one_read` |

## Windows file semantics

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| W1 | A rename could replace a file that appeared at the destination; the case-only branch skipped the check | Moves use `MoveFileExW` without replace; a case-only rename refuses when the folder lists the new spelling as another entry | `atomic::tests::move_no_replace_refuses_an_existing_target`, `files::tests::a_case_only_rename_never_takes_a_different_file` |
| W2 | A crash between the two renames of a save left the page under temporary names | A page that is missing with exactly one aside of its name is put back when it is read, saved or listed in the tree | `files::tests::a_page_left_aside_by_an_interrupted_save_comes_back`, `atomic::tests::an_interrupted_save_leaves_an_aside_that_is_found` |
| W3 | A save dropped NTFS named streams such as `Zone.Identifier` | The new file gets copies of the old file's named streams (up to 16 MB) before the swap | `atomic::tests::a_save_keeps_the_files_extra_data_streams` |
| W4 | Temporary names built from long file names went over 255 characters | Temporary names keep at most 100 UTF-16 units of the original name; raw Win32 calls get the `\\?\` form for long paths | `atomic::tests::a_long_name_gets_a_temp_name_windows_accepts` |
| W5 | Delete hashed the file by path, then moved it by path | The file is held from the hash check to the move, which goes through its own handle | `files::tests::trash_with_a_stamp_moves_only_those_bytes` |

## Document session and store

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| S1 | Two tabs opening a page at once each loaded it, and a late load replaced fresh edits | One shared load per document, numbered; a load that is no longer current is dropped, and events for a document no tab holds are ignored | `store.test.ts` S1 |
| S2 | A rename during a pending save left the tab on Saving | See D7: the move waits for the save, and saves wait for the move | `store.test.ts` S2 and D7 |
| S3 | `gone` on an empty page being saved stuck on Saving; any failed watcher read made a clean page dirty | `gone` makes a saving page unsaved and keeps read-only views read-only; only a missing file counts as gone | `store.test.ts` S3 |
| S4 | Echo suppression hid an outside restore of the bytes Hivemind last wrote | The remembered write is forgotten once the file is seen holding anything else | `files::tests::an_outside_restore_of_hiveminds_last_bytes_is_not_an_echo` |
| S5 | Reload replaced edits typed while it read the file | A reload whose document changed meanwhile does nothing and says so | `store.test.ts` S5 |

## Memory and the Notes UI

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| M1 | With no notebooks, the Notes page hid open tabs, including a Memory note opened with Ctrl+O | The add-notebook screen shows only when there are no notebooks and no tabs | UI |
| U1 | Ctrl+S did nothing in Reading mode | The workspace handles Ctrl+S for the active page tab when no editor took it | UI |
| U2 | Renaming a section with a dot in its name kept the part after the dot | `renamed(path, name, section)` takes the name as typed for sections | `store.test.ts` U2; UI |
| U3 | Tree drag had no `pointercancel` handler and no pointer id | The drag remembers its pointer and a cancelled gesture drops it | Checked by reading; WebView2 does not cancel synthetic pointers |
| C1 | (Claude) A single click on a program or script in the tree ran it with the system | `file_reveal(open)` refuses executable kinds (a fixed list plus `AssocIsDangerous`) and says to use Show in Explorer | `studio::tests::programs_and_scripts_are_not_opened`; UI |
| C2 | (Claude) The in-memory draft cache kept a moved page's draft under its old key, so a new page at that path restored it | `forgetMoved` drops cached drafts of moved pages and cached deletions after a move | `store.test.ts` S2 and D7 |

## Round 2: re-review of c496e1c

Codex (same model and effort, read-only) re-reviewed `c496e1c` against the 30 entries above. It reported 19 findings: 7 on fixes that were incomplete, 6 new defects and 6 tests that would pass with the old code. Claude accepted 18 and disputed the first half of P4 (the row says why). All are handled in the commit after `c496e1c` and tracked on the same Living Memory note with the prefix `R2-`.

Each regression test below was run against the code it guards with the fix taken out, or for T1, T2 and T5 with the guarded behavior broken on purpose, and failed. The component tests in `src/features/notes/FileTab.test.tsx` mount React and CodeMirror in jsdom (a new dev dependency, `jsdom` 31.0.1, used only by files marked `@vitest-environment jsdom`).

### Fixes that were incomplete

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| P4 | `root_of` compared paths in lowercase, which could take one folder for another in a case-sensitive folder; a swap between the check and the operation was followed | Disputed in part. A case-sensitive folder opens only the exact spelling, and a case-insensitive one has one folder for every spelling, so the lowercase comparison never mixes up two folders; it also keeps a notebook working after its folder is renamed by case only. The check moved to `unmoved()` with that reasoning. A swap between the check and the operation needs a same-user process that can already write the files, which the trust model leaves out | `studio::tests::a_notebook_folder_is_found_by_its_own_spelling_and_survives_a_case_only_rename` |
| D8 | Typing into a page while its delete was pending was lost | The page's tabs close before the file moves and open again, with their drafts, when the delete fails. The delete dialog (`DeleteConfirm`) reads the unsaved pages again whenever a document changes | `store.test.ts` "D8: a page's tabs close before its delete settles" |
| D2 | A merge whose result equals the version shown marked the page clean even when a newer version had come in | A clean merge result reads the file again, and the page follows a newer version | `store.test.ts` "D2: a merge that keeps the version shown" |
| S1, S5 | A refresh or reload that ended after the page was closed and reopened applied to the new session | Every document session has a generation number; reads and saves apply only to the session that started them | `store.test.ts` "S1 and S5" |
| P3 | The managed-vault scan skipped folders, entries and file types it could not read | Anything the scan cannot read refuses the move | `guard::tests::a_folder_hivemind_cannot_list_is_not_moved_unchecked` |
| P5 | The sidecar fallback relied on modification times, so a synced copy with a future time won | Writing the fallback also writes `<id>.base` with the sha256 of the notebook copy it replaced; the fallback counts while the notebook copy still has that hash | `sidecar::tests::the_fallback_wins_whatever_the_clocks_say_until_the_notebook_copy_changes` |
| W3 | Any `FindNextStreamW` failure ended stream copying as if the list were complete | Only `ERROR_HANDLE_EOF` ends the list; any other error stops the save | Checked by reading; a test cannot make the call fail |

### New defects

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| N1 | An aside that is a link could be restored into place and then followed | Only plain files count as asides | `atomic::tests::an_aside_that_is_a_link_is_not_restored` |
| N2 | Long names with the same first 100 units shared asides, and a name cut at 99 units (before a two-unit character) looked whole | Temp names carry 8 hex digits of the sha256 of the whole lowercased name, recovery matches that hash, and only names under 99 units count as whole | `atomic::tests::asides_of_long_names_sharing_a_prefix_stay_apart` |
| N3 | A draft deferred during a move was lost when its tab closed or the app quit before the move ended | A document whose tab closes during a move is let go only after the move; quitting waits for moves | `store.test.ts` N3 |
| N4 | Quitting missed edits typed while it wrote drafts | `flushAllDrafts` writes until every unsaved page's text is the text its stored draft holds (at most three rounds) and names the pages where that failed | `store.test.ts` N4 |
| N5 | A page opened during a section rename stayed on "Opening" | Moves hold pages by path, so a page opened during a move is held too, and a page still opening when it moves reads again at its new path | `store.test.ts` N5 |
| N6 | A second pointer could end the first pointer's drag and drop the wrong row | A press during a gesture is ignored, and only the gesture's own pointer ends it | `FileTab.test.tsx` N6 |

### Tests that would pass with the old code

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| T1 | The case-only rename test created one file, so a replacing rename also passed | One test creates the destination between the existence check and the move (a test-only hook); another renames between two spellings in a case-sensitive folder | `files::tests::a_target_that_appears_during_a_rename_is_never_replaced`, `files::tests::a_case_only_rename_in_a_case_sensitive_folder_keeps_both_files` |
| T2 | The stamped trash test changed the file before trash started | The hook runs between the hash check and the move; the held page refuses another program's write and delete there | `files::tests::nothing_changes_the_page_between_trashs_hash_check_and_its_move` |
| T3 | The Try again test called `open` instead of the button | The test mounts the failed page and clicks Try again | `FileTab.test.tsx` T3 |
| T4 | The two-pane test checked `followSpec` alone, not the editor wiring | The test mounts two file tabs of one page, types in both and saves | `FileTab.test.tsx` T4 |
| T5 | The move test held only the save, not the draft write | A test holds the draft write and checks that the rename waits for it | `store.test.ts` "D7: a rename waits for a draft write in flight" |
| T6 | The junction test passed silently when `mklink` failed | `mklink /J` must succeed; it needs no admin rights | `studio::tests::a_link_to_a_hidden_folder_is_hidden_too` |

### Stopping point

Claude set the stopping point at one more Codex pass over the round-two commit. From that pass, confirmed high-severity findings (data loss or escape from a notebook) are fixed in NS-1A; the rest go to the backlog note for the phase that touches the code next.

## Round 3: the last pass, over b82e9ab

Codex (same model and effort, read-only) reviewed `b82e9ab`, the round-two fixes. It reported eight high-severity findings, two medium and one low. By the stopping point above, Claude fixed every confirmed high-severity finding in the commit after `b82e9ab`, plus two cheap ones (TEST-1 and part of N2a); the rest are on the backlog note with the prefix `R3-`. Each regression test fails on `b82e9ab`, or with the fix taken out.

Codex was right about P4: the round-two dispute missed a junction already in place. The lowercase comparison stays for case-only renames, and a link anywhere on the registered path is now refused.

| ID | Severity | Finding | Fix | Test |
| --- | --- | --- | --- | --- |
| P4 | High | A junction put in place of the notebook folder, leading to a sibling spelled with other case, passed the lowercase check | `unmoved()` refuses a registered path with a link on it; the canonical path may differ only by case | `studio::tests::a_notebook_folder_is_found_by_its_own_spelling_and_survives_a_case_only_rename` (junction case added) |
| D8 | High | A page opened again from the tree while its delete ran could be edited and then discarded; a failed delete lost edits too large for a draft | A delete holds its pages like a move: they do not load, a reopened tab shows "Moving to the trash", the documents stay in memory until the delete settles, and tabs opened meanwhile close with it | `store.test.ts` "D8 (round 3)" |
| N2 | High | In a case-sensitive folder, two long names differing only in case after the kept part shared an aside hash | The name hash covers the exact spelling | `atomic::tests::asides_of_long_names_sharing_a_prefix_stay_apart` |
| N3 | High | Closing the window skipped the draft flush when no tab was unsaved, and a closed page whose last draft write failed was never reported | The close guard flushes whenever `draftsPending()`; failed drafts of closed pages are reported at once (a toast) and at quit | `store.test.ts` "N3 (round 3)"; the close guard checked by reading |
| N4 | High | The drafts cache kept a draft whose write failed, and loading counted it as kept | A failed `putDraft` puts back what the cache held; `kept` is set only after a write succeeds | `store.test.ts` "N4 (round 3)" |
| N5 | High | A page opened during a move could read its file before the rename and its draft after it | Pages under a move or delete in progress load only when it ends, at the path they end up at | `store.test.ts` "N5 (round 3)" |
| P5a | High | A sidecar fallback written before the base hash lost to the notebook copy | Without a hash, the old rule applies: the fallback counts when it is at least as new | `sidecar::tests::the_fallback_keeps_its_base_inside_and_a_fallback_from_before_the_hash_keeps_the_old_rule` |
| P5b | High | The base hash and the fallback were two writes, and the hash was read apart from the notebook copy that was merged | The hash is a key inside the fallback JSON (`hivemindReplaced`), computed from the same read of the notebook copy as the merge | same test |
| N2a | Medium | Whole names of 99 or 100 units were not recognised from their aside, and asides in the `c496e1c` format are not recovered | Names are recognised by their hash at any kept length. The old format stays unrecovered: no build that wrote it was installed | `atomic::tests::asides_of_long_names_sharing_a_prefix_stay_apart`; old format on the backlog |
| TEST-1 | Medium | jsdom 31 supports a narrower Node range than vitest | jsdom 28.0.0, whose dependencies accept vitest's whole range | none needed |
| P3 | Low | `is_marked_vault` treats a metadata error as no marker | On the backlog | |
