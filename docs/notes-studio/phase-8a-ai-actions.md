# NS-8A: AI engine and page actions

Read [README.md](README.md) section 5.9 and the S6 spike verdict first. This phase adds the Notes AI engine (Claude or Codex per action, with its own budget) and selection and page actions that return a diff the user accepts, edits or rejects.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- One apply rule (README section 3): a selection result applies when its anchor text is still in the page and is saved through the session save against the latest base; a whole-page result applies only if the page still has the captured hash or revision (C6).
- Rust checks the origin of every input at dispatch, not the webview: the page and its notebook must not be private, embeds are expanded in Rust and each embedded source is checked the same way, and the check runs again right before the model is called, so a notebook made private while work is queued is refused (S10).
- Round 2: the effective Private of a folder notebook is the stricter of Hivemind's registry copy and the sidecar (NS-2C), the same rule Living Memory uses, at every AI entry point, embedded sources included (S10).

## 1. What the user sees

- Select text and press Ctrl+J (editor-local) or use the selection menu: **Rewrite**, **Shorten**, **Expand**, **Fix grammar**, **Translate to…**, **Change tone…**, **Turn into tasks**, **Explain**, **Custom instruction…**. Without a selection, page actions: **Summarise**, **Outline**, **Continue writing**, **Suggest headings**, **Find gaps**.
- Each action shows a spinner with Cancel, then an inline diff (old struck through, new highlighted) with **Accept**, **Edit** (edit the proposal before accepting) and **Reject**. Explain and Find gaps show their answer in a panel and never change the page.
- Accept applies only if the selected text is still exactly what was sent (positions mapped through any edits since); otherwise "The text changed while the AI was working" and the proposal stays visible to copy.
- Settings > Notes AI: daily cap (default 2 USD), per-action caps, engine per action (Claude or Codex) with a note under Codex: "No hard spending cap and can read files on disk; cost is estimated." Today's spend shows in the status line of the AI panel.
- Private notebooks show no AI actions. A managed Claude policy (see `managed.rs`) disables Claude actions with the reason.

## 2. Design

- `src-tauri/src/oneshot.rs`: `run` unchanged for its existing callers. New `run_codex(cli, dir, ledger, cap, id, call, input, timeout, cancel)`: `codex exec --json --ephemeral --sandbox read-only --skip-git-repo-check --ignore-user-config --ignore-rules --output-schema <dir>/schema.json -o <dir>/answer.json -C <dir> -m <model> -` with the policy at the top of stdin, `LIVING_MEMORY_OFF=1`, `HIVEMIND_SESSION` removed, input through `learning::redact`, `git::run_cancellable` for cancel and timeout. Cost from the `turn.completed` usage event priced with a Codex table added to `src-tauri/src/term/pricing.rs`; unknown model settles the whole reservation. Exact flags per spike S6.
- Schemas are written in the strict subset both engines accept (every property required, `additionalProperties: false`) and validated again in Rust.
- `learning.rs Ledger` gains a label for its budget message; Notes AI uses `Ledger::new(app_data/notes-spend.json)`.
- `src-tauri/src/notes_ai.rs`: the action catalogue (id, prompt, schema, default cap, which input it takes), `notes_ai_run(action, ref, input, context)` returning a proposal id, `notes_ai_cancel`, `notes_ai_status`; refuses Private notebooks (checked in Rust from the sidecar or Living Memory notebook settings, never trusted from the webview).
- Settings: `notes_daily_usd`, `notes_call_usd`, `notes_engine` in `settings.rs` with getters and the existing `per_call` clamping; Settings UI in `src/features/settings/budgets.ts` and the form.
- Frontend: `src/features/notes-ai/{actions.ts, anchor.ts, AiDiff.tsx, AiMenu.tsx}`; the anchor captures `{ docKey, version, from, to, text, baseHash }` and maps positions through transactions.
- A history snapshot (NS-5) is taken before an accepted change is saved.

## 3. Tests and exit

cargo: Codex argv, JSONL usage parsing, estimated cost and settlement, the 25% suggestions gate, the managed refusal still applying to Claude, Private refusal, fake CLIs as libtest binaries (never the real CLIs). vitest: anchor mapping and stale refusal, diff model. Exit: no write without Accept; stale selections refused; the cap stops further calls; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
