# NS-7A: daily notes, templates and Quick capture targets

Read [README.md](README.md) and [phase-2c-lm-notebooks.md](phase-2c-lm-notebooks.md) first.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Daily folder, date format, template and inbox page of a Living Memory notebook are stored in its `notebook.json` `settings` object through `doc notebook update --settings-file` (U7).

## Changes from the code survey before NS-7A

Claude surveyed main at `5039613` on 2026-11-22. Where the text below says otherwise, these win.

- **Folder notebook settings** go in the notebook's sidecar through the existing `notebook_meta_get` and `notebook_meta_set` (`src-tauri/src/studio.rs`, merge patch in `notebooks/sidecar.rs`), under one key `daily`: `{ folder, format, template, templates, inbox }` (`templates` is the templates folder). No new settings store.
- **Living Memory notebook settings** are written with `doc notebook update --settings-file` as U7 says, but Hivemind cannot read them back today: `doc notebooks` rows carry no `settings` and no other command returns them. This phase adds `settings` (the `settings` object of `notebook.json`, or `{}`) to each `doc notebooks` row in Living Memory (`core/docs.py`, with a test), pushed to Living Memory's main. Until the user installs that build, Hivemind treats a missing `settings` as defaults and offers no daily settings for Living Memory notebooks.
- **Passing JSON files to Living Memory:** Hivemind has no path for `--*-file` options other than `--body-file`. `lm_body` (`src-tauri/src/lib.rs`) gains the flag name to use, so `--settings-file` goes the same way as a body (temp file, bounded size, before the `--`).
- **Quick capture** is the `#capture` window of the same bundle; `src-tauri/capabilities/default.json` already lists `capture`, so it can call the notebook and file commands. It reads notebooks with the same queries as the main window.
- **Appending to a Living Memory page** reads with `doc read` and refuses a page read `truncated` (as Memory notes do since the whole-app review, DATA-1), then writes with `doc write --expected-revision` and retries on a stale revision up to three times.
- **Obsidian settings:** `.obsidian/` is a hidden folder, which `studio::inside` refuses. A read-only Rust command reads exactly `.obsidian/daily-notes.json` and `.obsidian/templates.json` at a notebook's root (size-capped, through `root_of`, never following a link out), and nothing else under `.obsidian`. Vaults Living Memory manages are protected and never notebooks, so this only touches the user's own vaults.
- **Dates** use the local time zone; "today" changes at local midnight.
- **Follow-ups from the whole-app review** ride along:
  - Closing one of two tabs that show the same page or Memory note no longer asks "Discard unsaved changes?" (`useCloseTab` in `src/workspace/Workspace.tsx`, which only checks file tabs today).
  - The rename link rewrite (`src/features/editor/rewriteIncoming.ts`) and `ChangeDetail` pass the bridge generation to `update`, as the editor does since batch C.

## 1. What the user sees

- **Today** (palette, and a button on each notebook): opens today's daily page, creating it from the daily template if needed. Settings per notebook: folder, date format (Moment-style tokens `YYYY`, `MM`, `DD`, `ddd`, `ww`, as Obsidian uses), template. Previous and next day buttons on a daily page; a small calendar in the rail marks days that have a page.
- **Templates:** pages in the notebook's templates folder. **New page from template** asks for a title and fills variables: `{{title}}`, `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{notebook}}`, `{{project}}` (the picked project), `{{cursor}}` (where the cursor lands). Unknown variables are left as written.
- **Quick capture** (the global hotkey window, `src/features/capture/QuickCapture.tsx`) gets a target switch: **Memory note** (today's behaviour), **Today's page** (appends under a `## Captured` heading with the time), **Inbox** (appends to the notebook's inbox page). The notebook is chosen in the window and remembered (`hivemind.captureTarget`).
- For Obsidian vaults, the daily and template settings are read from `.obsidian/daily-notes.json` and `templates.json` when present (read-only; NS-9A completes vault support).

## 2. Design

- `src/features/notes/daily.ts` (pure): date formatting, daily path, template expansion.
- Appending: Rust `notebook_append(ref, heading, text)` reads, inserts under the heading (creating it at the end if missing), and saves with the read hash; on `Stale` it retries up to three times. Living Memory pages use `doc read` and `doc write --expected-revision` with the same retry in TypeScript.
- `src-tauri/src/capture.rs` is unchanged except for passing the target to the capture window; the capture window stays one bundle with `#capture`.

## 3. Tests and exit

vitest: date tokens, template expansion, append placement (existing heading, missing heading, CRLF). cargo: append retry on a concurrent edit. Exit: the hotkey appends to today's page in a folder notebook and in a Living Memory notebook; Memory capture unchanged; Memory regression pass.

## 4. Shipped

(Filled in when the phase lands.)
