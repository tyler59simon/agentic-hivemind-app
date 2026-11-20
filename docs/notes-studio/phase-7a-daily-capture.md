# NS-7A: daily notes, templates and Quick capture targets

Read [README.md](README.md) and [phase-2c-lm-notebooks.md](phase-2c-lm-notebooks.md) first.

## Changes from the NS-0 review

These rules come from the Codex review of the design ([reviews/ns0-codex-review.md](reviews/ns0-codex-review.md)). Where the text below says otherwise, these win.

- Daily folder, date format, template and inbox page of a Living Memory notebook are stored in its `notebook.json` `settings` object through `doc notebook update --settings-file` (U7).

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
