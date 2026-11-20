# S4: rusqlite with bundled SQLite (verdict: adopt in NS-4A)

Measured on 2026-11-20 in a scratch crate outside the repository, on the development machine (Windows 11, rustc 1.99.1, MSVC).

- `rusqlite = { version = "0.43.0", features = ["bundled"] }` (MIT, with `libsqlite3-sys` 0.40.0) builds SQLite 3.54.1 from source.
- Clean release build of the crate: 22 s after `cargo fetch`. Most of that is the C compile of SQLite. Incremental release rebuilds after a source edit take under 1 s because the SQLite object is cached.
- Release exe size: 1,823,744 bytes against 130,560 for an empty crate, so about 1.7 MB is added.
- `PRAGMA compile_options` lists FTS5. An `fts5` table with `tokenize='porter unicode61'` (the tokenizer Living Memory uses) matched "search" against "searches".

Decision: NS-4A adds `rusqlite` with `bundled` as planned. The plan's estimate (1.2 to 1.9 MB, 20 to 60 s) holds.
