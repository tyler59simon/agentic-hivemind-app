# NS-8C: agent sessions on folder notebooks

Read [README.md](README.md), [phase-5-history.md](phase-5-history.md) and `../plans/phase-6-terminal-parity.md` (sessions in a checkout or folder) first.

## 1. What the user sees

- On a folder notebook: **Start agent session** (Claude Code or Codex, chat or terminal as on the Start screen) with a task such as "tidy the meeting notes from last week into one summary page".
- The agent works on a **copy** of the notebook. When it stops, the Review page shows its changes as a diff for any notebook, git or not.
- **Apply to notebook** replaces Approve: each accepted file is written to the real notebook; a page the user also edited since the session started is merged (text) or offered keep mine, keep theirs, save both (`.hmdoc`, `.canvas`); every applied file gets a history snapshot first. **Discard** deletes the copy.
- Private notebooks cannot start sessions. Living Memory notebooks have no sessions; agents use `alm doc propose`.

## 2. Design

- `AgentTask::Notebook { id }` in `src-tauri/src/agent/scope.rs`; the folder comes from the notebook registry in Rust, never from the webview.
- Start: copy text files (`ignore` walker, skip `.git` and `.hivemind`, caps 100 MB and 20,000 files; attachments are copied too unless over the cap, in which case they are skipped and listed) into `app_data/notebook-sessions/<id>/work/`; create a bare shadow repository `app_data/notebook-sessions/<id>/git` and commit the start snapshot with `GIT_DIR` and `GIT_WORK_TREE` (generalising the `GIT_INDEX_FILE` approach of `agent/direct.rs` `snapshot_within`). Record each copied file's original hash.
- The agent's working folder is the copy; scope deny rules allow writes only there.
- Review reuses `review.rs` diff functions through a `git_shadow(git_dir, work_tree)` command builder; the Review page's file list and `CodeDiff` are unchanged; the action bar shows Apply to notebook and Discard for this session kind.
- Apply: for each accepted path, compare the real file's hash with the recorded original: unchanged, write with `file_save` and the original as precondition; changed, three-way merge with `mergeBody` (base from the shadow start commit) or the binary-format conflict choice; new file, create with "absent" as precondition; deleted, delete with the original hash.

## 3. Tests and exit

cargo with libtest-binary fake CLIs: copy caps, shadow repo diff on a non-git notebook, apply with no concurrent edit, apply with a concurrent edit (merge), apply of a new and a deleted file, discard removes everything. Exit: works on a non-git notebook; a concurrent outside edit merges; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
