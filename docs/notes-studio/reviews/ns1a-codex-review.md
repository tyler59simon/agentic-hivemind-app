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
