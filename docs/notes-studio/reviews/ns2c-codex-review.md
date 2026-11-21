# NS-2C code review (Codex, 2026-11-21)

Codex (`gpt-6.2-sol`, effort high, read-only) reviewed commit `32fee20`, the NS-2C implementation, against Living Memory `8a003ba`. It reported 18 findings. Claude checked each one against the code before fixing it and found all 18 accurate; C4 was also reproduced against a scratch store (`doc read demo nb1 -Draft.md` fails with "the following arguments are required: path"). All 18 are fixed in the commit that follows `32fee20`, each with a regression test; the D1, D6, P2 and B1 tests were checked to fail with their fix undone. Two fixes needed Living Memory changes, made in Living Memory `a493525`: `doc accept --edited` (D3) and `doc folder set` without `--visibility` (P1). All findings are tracked as action items on the Living Memory note "Notes Studio NS-2C: Codex review findings (commit 32fee20)".

"Test" names the regression test. Rust tests are named by module path; frontend tests by file and the finding ID in the test name; Living Memory tests by file and name.

## Data loss and wrong writes

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| D1 | A Living Memory page's autosave, or its draft, could land in another store after the user switched stores in Settings, when that store had a page of the same domain, notebook, path and bytes | Each open page belongs to the store it was read from (`pageStores` in `store.ts`, filled from the root `connect` reports through `setLmStore`). It saves only into that store; Settings pauses every Living Memory save while it saves (`pauseLmStore`); on a new store, open pages keep their edits as that store's draft and show the new store's page. A draft names its store, and a draft from another store comes back read-only beside the page, to copy or discard | `store.test.ts` D1 |
| D2 | The proposal inbox merged against `doc read` text, which holds replacement characters for bytes that are not UTF-8 and mixed line endings, so a merge could change lines the user never edited | The inbox reads the page through the adapter's `readPage` (exact-bytes check and line-ending rules). A page or proposal that cannot be written unchanged offers Accept, Reject and Open page only, and says why | `lmnotebooks.test.ts` D2 |
| D3 | A merge closed its dialog before writing, so a failed write lost the merge, and the write and the settling were two steps (`doc write`, then `doc reject`) | Living Memory's `doc accept ID --edited [--expected-revision R]` writes the merge and settles the proposal as accepted and edited in one operation, against the revision the merge was made from. The dialog stays open until that succeeds; a stale page says so and keeps the merge in the dialog. Merging needs `docs.accept_edited` | Living Memory `test_docs.py` `test_accept_edited_writes_the_merge_and_settles_it_in_one_operation` and `test_accept_edited_refuses_a_settled_proposal_and_a_new_page_that_exists_now`; `lmnotebooks.test.ts` C4 (argv) |
| D4 | A move whose reply was lost put the drafts back although Living Memory may have moved the pages | `lmdoc::settle_move`: a lost reply is settled by `doc list`; when the notebook cannot be listed either, both draft copies stay and the error says so | `lmdoc::tests::a_move_whose_reply_was_lost_is_settled_by_the_notebook` |
| D5 | A merged new page and a gone page created again lost the line endings and byte order mark they had | The merge writes with the page's format, or the proposal's for a new page (`mergedBody`); `createDoc` takes the session's format for Living Memory pages | `lmnotebooks.test.ts` D5; `lmdoc.test.ts` D5 |
| D6 | A tab closed within 5 s of an edit left its autosave timer behind, and the page reopened dirty with no save scheduled | Closing releases the timer; a page that comes back with unsaved edits schedules its autosave (`autosaveRestored`) | `store.test.ts` D6 |

## Containment and privacy

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| P1 | Registering a folder always sent `--visibility searchable`, so a hidden tombstone became searchable, and the reply was written to the sidecar, overwriting a stricter sidecar value | Living Memory's `doc folder set` without `--visibility` keeps the entry's or tombstone's visibility (a new folder is searchable). Registration sends neither visibility nor private and leaves the sidecar alone; Living Memory reads it and the stricter of the two holds. The toast reports the stricter of the two | Living Memory `test_sources_notebooks.py` `test_set_without_visibility_keeps_what_the_registry_holds`; `lmnotebooks.test.ts` P1 |
| P2 | `lmdoc::folder` accepted a notebook folder that a junction led elsewhere inside the store, and the grant matched `assets` in any letter case | The canonical folder must equal `domains/<domain>/notebooks/<notebook>` under the canonical store, compared without letter case only. The grant serves `assets` exactly as Living Memory names it | `lmdoc::tests::a_notebook_that_leads_elsewhere_in_the_store_is_refused`; `assets::tests::a_folder_named_otherwise_than_assets_is_not_served` |
| P3 | Notebook settings sent the dialog's Private value whenever reach changed, so a visibility edit could undo a newer privacy decision made elsewhere | Settings send only the fields the user changed (`ReachChange`), and the sidecar gets only those | `lmnotebooks.test.ts` P3 |

## Bridge and staging

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| B1 | The 2 MiB check ran only for a large stdin, so a request made large by its arguments reached Living Memory and cost a restart | The raw size of arguments and stdin decides whether the frame is measured | `bridge::tests::a_request_over_the_serve_limit_is_refused_before_it_is_sent` |
| B2 | A staging write that failed partway left the file behind until the next start | `Staged` removes the file when it goes out of scope, on every path, retrying once | `lmdoc::tests::a_staging_file_goes_whatever_happens` |

## Living Memory contract

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| C1 | Folder reach used the general docs gate, which an NS-2A Living Memory passes without having `doc folder` | `useFolderPolicyEnabled` and `folderPolicyEnabled` check `docs.folder_policy` for registration, settings and removal | `lmnotebooks.test.ts` C1 |
| C2 | A damaged notebook row (`error`, no `title`) could crash the Notes page's sort | `docNotebooks` returns healthy notebooks and damaged ones apart; the Notes page lists the damaged ones with their error | `lmnotebooks.test.ts` C2 |
| C3 | The webview accepted any container id, Rust capped domains at 120 characters, and neither matched Living Memory's names | Both use Living Memory's rules: domain `[A-Za-z0-9_][A-Za-z0-9._-]*` (a folder name, at most 255), notebook `[a-z0-9][a-z0-9-]{1,39}` | `lmdoc::tests::container_ids_follow_living_memory_names`; `lmnotebooks.test.ts` C3 |
| C4 | A page named like an option (`-Draft.md`) was listed but could not be read, saved or moved, because operands came before options with no `--` | Every `doc` command puts options first, then `--`, then the operands; free text goes as `--option=value`; `lm_body` puts `--body-file` before the `--` | `lmdoc::tests::options_go_before_the_operands`; `lmdoc::tests::live_pages_through_the_bridge`; `lmnotebooks.test.ts` C4 |

## UI state

| ID | Finding | Fix | Test |
| --- | --- | --- | --- |
| U1 | The proposal open in the inbox did not refresh when its page or the proposals changed, so Accept stayed offered and failed | `docs-changed` asks again for the open proposal when pages or proposals change; a stale Accept reloads it, so the inbox moves to Merge | `lmnotebooks.test.ts` U1 |
| U2 | A non-image attachment link did nothing when clicked in the reading view, and Attach copied the file before checking the page could take the link | A relative link in a Living Memory page opens its attachment (`lmdoc_open_asset`: inside `assets/` after links resolve, documents, pictures and media only, a read-only copy in the temporary folder) or its page. Attach checks the page first | `PageView.test.tsx`; `lmdoc::tests::a_notebook_that_leads_elsewhere_in_the_store_is_refused` (kinds and copy) |
| U3 | With only Living Memory notebooks, Ctrl+N opened an untitled loose file | `newPageHere` falls back to the first Living Memory notebook shown | `lmnotebooks.test.ts` U3 |
