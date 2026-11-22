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

Code written on 2026-11-22 on main at `81905bb`; commit hashes, the review and the UI pass are filled in when it lands. At the user's request this phase had no Codex review; Claude reviews the diff.

**Living Memory** (a separate repo, `agentic-living-memory`)
- `core/docs.py`: each row of `doc notebooks` carries `settings`, the `settings` object of `notebook.json`, or `{}` when it is absent or not an object. `tests/test_docs.py` `test_notebook_rows_carry_the_settings_object` fails without it. The whole suite passed (`python -m unittest discover -s tests`: 2380 tests, 9 skipped). Not pushed and not installed.

**Rust**
- `src-tauri/src/append.rs` (new): `insert_under` puts a line at the end of a heading's section (before the blank lines that precede the next heading), adds a missing heading at the end of the page, or appends at the end when there is no heading; a heading inside a code fence is not one. `append_page` reads the page, changes it and saves it through `studio::save_kept` against the hash it read; a stale save or a vanished page reads again, up to three times (`ATTEMPTS`), then fails with "kept changing". A missing page is made with `create_kept`. A page that is binary or read-only is refused. Pages keep their encoding, byte order mark and line endings because the text goes through `files::read` and `files::save`.
- `studio.rs`: `notebook_append(notebook, path, heading, text)` (folder notebooks, through `root_of` and `inside`, 256 KB cap, tells the index) and `obsidian_setting(notebook, name)`. The latter reads exactly `.obsidian/daily-notes.json` or `.obsidian/templates.json` (any other name is refused), at most 64 KB, resolved as a write is, so a link or junction on any part of the path is refused, and returns `null` when the file is absent. A byte order mark is skipped.
- `history.rs` and `features/history/timeline.ts`: a new save source `capture` ("Quick capture"), so an append keeps the page as it was first (as every save that is not the user's own typing does).
- `lmdoc.rs` and `lib.rs`: `lm_body` takes an optional `flag`. `call_with_file` passes either `--body-file` or `--settings-file` before the `--`; settings always go through a staged `.json` file (Living Memory reads them from a file only), at most 256 KiB, and `clear_staging` sweeps leftover `.json` files too. Any other option name is refused.

**Webview**
- `features/notes/daily.ts` (pure): `formatDate` with Moment tokens (`YYYY YY MMMM MMM MM M DD D dddd ddd dd d WW W ww w HH H hh h mm m ss s A a Q` and `[text]`; `ww` is the week from Sunday with January 1 in week 1, `WW` the ISO week), `dailyPath`, `dailyDateOf` (the date a path names; the date found must write the same path back), `resolveDaily` (what the user stored, then the Obsidian files, then the defaults `Daily`, `YYYY-MM-DD`, `Templates`, `Inbox.md`), `dailyPatch`, `expandTemplate` (`{{title}} {{date}} {{date:FORMAT}} {{time}} {{time:FORMAT}} {{notebook}} {{project}} {{cursor}}`; anything else is left as written) and `lineAndColumn`.
- `features/notes/append.ts`: `insertUnder` (the same placement as Rust, with Windows line endings kept), `captureLine`, `appendToLmPage` (`docRead`, refused when read `truncated` or not exactly the page's UTF-8 bytes, `docWrite --expected-revision`, three attempts on a stale revision, made with `docCreate` when missing) and `appendToPage`, which sends a folder notebook's page to Rust.
- `features/notes/dailyPages.ts`: `loadNotebookInfo` (a Living Memory notebook's `settings.daily` from `doc notebooks`; a folder notebook's sidecar plus the Obsidian files), `ensureDaily` (the day's page made from the daily template, an existing page left alone, a missing template gives an empty page), no workspace code, so the capture window uses it. `dailyActions.ts`: `openDay`, `openToday`, `listTemplates`, `newPageFromTemplate`, `placeCursor`. `DailyViews.tsx`: the **New page from template** dialog, previous and next day buttons on a daily page (`DayNav`, in the page header) and the rail's month calendar (`DailyCalendar`, in a **Calendar** disclosure of the page rail; days with a page are marked, a click opens a day and makes its page from the template when missing).
- **Today** is a button on each notebook (Notebook tree header) and a palette command; **New page from template…** is in a notebook's menu, a section's context menu and the palette. Notebook settings has a **Daily notes** block (folder, date format, template page); a Living Memory notebook's settings dialog also has the templates folder and inbox page, and only when its Living Memory reports `settings`. `docNotebookUpdate` takes `settings`.
- **Quick capture** has a target switch (Memory note, Today's page, Inbox) and a notebook picker, kept in `hivemind.captureTarget`. Today's page is made from the template when missing and gets `- HH:mm Title: summary` (details as sub-bullets) under `## Captured`; the inbox page gets the same line with the date, at the end. After a write the window emits `page-appended`, and the main window refreshes that page (`documents/sync.ts` `onPageAppended`): a page with no unsaved edits follows the file, one with unsaved edits keeps them and shows the "changed on disk" banner, and its merge keeps the new line.
- The cursor of `{{cursor}}` is placed through the tab's reveal request, which now takes a column (`revealLine(tabId, line, col)`, `CodeEditor`).
- Follow-ups: `useCloseTab` (`workspace/Workspace.tsx`) closes one of two tabs that show the same page, or the same Memory note, without the "Discard unsaved changes?" dialog; the last one still asks. `rewriteIncoming` takes the bridge generation of the rename (the editor's session, else the one now) and passes it to every `update`; `Evidence` in `ChangeDetail` passes the generation the brief was read in.

**Tests**
- vitest: `daily.test.ts` (date tokens, the daily path and its inverse, settings resolution, template expansion), `append.test.ts` (placement with an existing heading, a missing heading and Windows line endings; the Living Memory append: written against the revision read, retried on a stale revision, three attempts, refused when read truncated, a missing page made), `dailyPages.test.ts`, `capture.page.test.ts` (Today and Inbox for a folder and a Living Memory notebook), `store.append.test.ts` (an append to a page open with unsaved edits keeps them), `Workspace.close.test.tsx`, `rewriteIncoming.test.ts` and `ChangeDetail.evidence.test.tsx` (the generation), `lm.settings.test.ts`, `prefs.capture.test.ts`, `DailyViews.test.ts`.
- cargo: `append::tests` (placement, Windows line endings kept byte for byte, a missing page, a retry that keeps another writer's change, giving up after three attempts, a page that cannot be edited or reached), `studio::tests` (the Obsidian read refuses every other name and a link or junction out, size and damaged JSON), `lmdoc::tests` (only the two file options, the settings bound, `.json` staging swept; and in the gated live test the settings round trip through the real `doc notebook update --settings-file` and `doc notebooks`, run with `HIVEMIND_TEST_LM_SCRIPT` against a temporary store).
- Each of these was checked against a mutation that removes the code it covers (the truncated check, the stale retry, the generation on both writes, the twin check, the refresh after a capture, the Obsidian allowlist, the Rust retry); every one failed its test.
- Results: `cargo test` 785 passed and 3 ignored; the gated live test (`HIVEMIND_TEST_LM_SCRIPT=...living_memory.py cargo test live_pages_through_the_bridge`) passed; `cargo clippy --all-targets -- -D warnings` clean; the whole `npx vitest run` 183 files, 1836 passed and 1 skipped, with `src/workspace/store.test.ts` unedited; `npx tsc --noEmit` and `npm run build` clean.

**Deviations**
- A folder notebook's older top-level `templates` and `inbox` (the fields of Notebook settings, README 5.4) stay where they are, and the `daily` object is `{ folder, format, template }` for such a notebook; `daily.templates` and `daily.inbox` are read too and win when present. A Living Memory notebook has all five in `settings.daily`.
- The append from the capture window goes through Rust and a `page-appended` event, not through the main window's document session: the capture window is another webview with no session. The open page follows or warns through `refresh`, as it does after the link rewrite.
- The Rust `notebook_append` takes an optional heading (none for the inbox) and makes a missing page, which the design did not say.
- New save source `capture`.
- `{{cursor}}` lands on its line and column when the page opens for editing; the rich and Rich-mode editors take the line only.
- The previous and next day buttons make the neighbouring page from the template when it does not exist, as the calendar does.
- The Obsidian reader is the NS-9A "vault settings reader" built early; NS-9A still has to complete vault support.

**Known limits**
- `dateFormat` and `timeFormat` of Obsidian's `templates.json` are not used for `{{date}}` and `{{time}}`.
- A daily format with only a week (`YYYY-[W]WW`) has no date to find, so such a page gets no day buttons and no calendar mark.
- Until the user installs a Living Memory with `settings` on `doc notebooks`, a Living Memory notebook uses the defaults and its settings dialog has no daily fields.
- The calendar marks days from the notebook tree, so a page made by another program shows after the tree refreshes.
