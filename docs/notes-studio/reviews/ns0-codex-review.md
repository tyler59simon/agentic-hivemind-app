# NS-0 design review (Codex, 2026-11-20)

Codex (`gpt-6.2-sol`, effort high, read-only) reviewed commit `7a4639a` here and `df99fc4` in Living Memory. It reported 38 findings. Claude checked the ones that rest on code (the 1 MiB payload and 2 MiB serve caps in `core/cli.py`, `validate.py` requiring `notes/`, `protected_rule`, self-declared `--actor`, the `source_write` fields) and found them accurate.

Verdicts: **accepted** means the design changed as described; **partly** means part of the finding was adopted and the rest is explained. "Where" names the document that now holds the rule.

## Trust model behind the verdicts

Three verdicts depend on one assumption, now written down in README section 4: Hivemind protects against its own mistakes, against links planted inside a notebook, and against agents that Living Memory governs through hooks. It does not protect against another process of the same Windows user that can already write the files. Living Memory's `--actor` is self-declared, so it is never a security boundary; agents are told apart only by the PreToolUse hook and by `HIVEMIND_SESSION` inside Hivemind terminals.

## Findings

| ID | Verdict | Resolution | Where |
| --- | --- | --- | --- |
| W1 | accepted | Cite `folder_pick` in `lib.rs`; identity is canonicalise then compare lowercased `plain()` spellings | README 5.4, phase-1b |
| W2 | accepted | `windows-sys` (NS-1B, `ReplaceFileW`) and `regex` (NS-6B) added as direct dependencies | README 4 |
| W3 | accepted | Architecture embeds store system slug plus manifest-relative diagram path; missing diagram shows a placeholder | phase-3d |
| W4 | accepted | Folder notebook policy gets its own registry and commands instead of `source_write` | LM design 8.2 |
| W5 | accepted | Relocation skips `docs.sqlite3` and its side files; the destination rebuilds it | LM design 7 |
| W6 | accepted | Semantic tests follow Living Memory's real install and remove behaviour; long single paragraphs stay whole, as `units.py` does | phase-4b |
| W7 | accepted | Notebook excerpts inherit every rule of the source channel (no subagents, no machine prompts, once per session, fit check) | LM design 8.3 |
| C1 | accepted | Dependency edges added; features that need a later phase are gated in their exit criteria | README 6 |
| C2 | accepted | Page bodies over 512 KiB go through a staging file and `--body-file`; Hivemind never sends a frame over the serve cap | LM design 3, phase-2c |
| C3 | accepted | One `pages` array for both notebook kinds with `origin`, in `search`, `ask` and per-question results; folder notebook excerpts leave `sources` | LM design 8.1 |
| C4 | partly | Mixed line endings are read-only, so Rich mode never sees them. Accepted: Rich round trips are tested through the file adapter and save path | phase-3b |
| C5 | accepted | Block ownership moves to a `srcId` attribute set at parse; first owner equal to its original keeps the slice; gaps only between consecutive originals | phase-3b |
| C6 | accepted | One rule: an AI result applies when its anchor text still matches, through a normal save against the latest base | README 3, phase-8a |
| U1 | partly | Saves hold the target open without write sharing from the hash check to the rename, so no other writer can slip in; a sharing violation fails the save with "in use". A process that already has the file open for writing cannot be detected beforehand | README 5.3, phase-1a |
| U2 | accepted | Request ids, acknowledgement after enqueue, subscribe before drain, 5 s startup allowance, old-client fallback tests | phase-1b |
| U3 | accepted | Attachments use staged, hash-addressed blobs written before the journal intent; undo moves the blob back into the operation folder | LM design 4 |
| U4 | accepted | Backup manifest v2 lists covered and omitted members; restore never deletes what a snapshot does not cover; binary-aware plan and diff | LM design 7 |
| U5 | accepted | Kind-aware validation and relocation; conversion journaled; a notebook-only domain gets a vault through `sync DOMAIN VAULT` like any domain | LM design 5 |
| U6 | partly | The page index is refreshed by a bounded stat walk at query time, so undo, restore and recovery need no hook. Read commands get a bridge deadline in NS-2C; writes keep none, because an unknown outcome is worse than waiting | LM design 8.1, phase-2c |
| U7 | accepted | NS-2B indexes tasks and properties; `doc tasks` and `doc query` read them; LM notebook daily and inbox settings live in `notebook.json` | LM design 3 and 8.1, phase-7a, phase-7b |
| U8 | accepted | File sessions live in the documents store; drafts get an in-memory cache written synchronously, so a remount never reads an older draft | phase-1a |
| U9 | accepted | Rename and move migrate open tabs and drafts in the same command; history follows renames (NS-5) | phase-1a, phase-5 |
| U10 | accepted | A legacy file is editable only if decoding and encoding its actual bytes gives the same bytes; otherwise read-only with Convert to UTF-8 | phase-1b, spikes/s7 |
| U11 | accepted | `hmfile` answers CORS for the exact app origins and exposes `Content-Range` and `Accept-Ranges`; S1 tests pdf.js Range fetches from dev and production origins | phase-1b, spikes/deferred |
| U12 | accepted | The index covers notebooks only; loose files are found through recent files | phase-4a |
| S1 | partly | Every command resolves and checks immediately before it acts, in the same call; ids and slugs are validated before a path is built; Living Memory confines page paths to their notebook and refuses links. Handle-relative operations throughout are not adopted (trust model above) | README 4 and 5.3, LM design 2 |
| S2 | accepted | One guard after resolution on every path-bearing operation in every phase: the store, managed vault folders and reserved names; registration refuses ancestors of the store; a store change blocks overlapping notebooks at use | README 5.3, 5.4 |
| S3 | accepted | Grants are per root, checked against webview label and exact Origin, revoked with their notebook or recent entry, decoded before containment, checked against the guard | phase-1b |
| S4 | accepted | Private content needs `--include-private`, which the hook denies to agents and `HIVEMIND_SESSION` refuses; `domain create` is a governed write. `doc search --rebuild` stays allowed, like `search --rebuild` (it writes only a derived index) | LM design 6 |
| S5 | partly | The notebook path check runs before the unbound-session return, and the vault `Notebooks` folder is protected like `Domains`. Vault edits stay trusted user edits, the same rule as notes today; a shell write by an agent into the vault is the existing limitation for notes too | LM design 6, 8.4 |
| S6 | accepted | Living Memory keeps a policy registry for folder notebooks (`notebook-folders.json`), which Hivemind writes on registration and on every reach change; the stricter of registry and sidecar wins; an unreadable sidecar means hidden | LM design 8.2, phase-2c |
| S7 | accepted | Policy is checked at retrieval time on every path (search, ask, injection, vectors, digests), and a policy change purges that notebook's rows | LM design 8.2 |
| S8 | accepted | `history`, `diff`, `inspect-plan` and `proposals` redact private notebooks' `doc_` operations unless `--include-private`; journals record the notebook id | LM design 6 |
| S9 | accepted | Private and hidden notebooks are never mirrored; the vault `Notebooks` folder is excluded from every source walk | LM design 8.4 |
| S10 | accepted | Rust checks the origin of every AI input at dispatch, expands embeds itself, and retrieves without private content; Save to memory checks the page | phase-8a, phase-8b |
| S11 | accepted | Notebook sessions use a fixed access mode on both engines (never bypass or full access) and the copy leaves out dot-folders and `.mcp.json` | phase-8c |
| S12 | accepted | Commit uses `git commit --only -- ":(literal)<path>"`, tested with another staged file and pathspec characters | phase-5 |
| S13 | accepted | A 2 GB expanded budget across nested archives, depth 2, link members and colliding names refused, undo only of files still matching the import receipt | phase-9b |

All findings are tracked as action items in Living Memory ("Notes Studio NS-0 design review findings (Codex, 2026-11-20)").
