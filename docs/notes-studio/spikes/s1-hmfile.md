# S1: the `hmfile` scheme (verdict: adopt, as built in NS-1B)

Measured on 2026-11-20 by Claude with the NS-1B code, in the dev app (`npm run tauri dev`, origin `http://localhost:1420`) and in the release build run from `src-tauri/target/release` (origin `http://tauri.localhost`), driven over CDP. The fixture was a scratch notebook registered in app data (removed afterwards) holding `Page.md`, `img/cat.png`, `img/logo.svg` (with a `<script>`), `doc.pdf` (4,331 bytes), `secret.exe`, and a picture one folder above the notebook.

## Results

| Request (from the main window) | Dev origin | Production origin |
| --- | --- | --- |
| `GET <base>img/cat.png` | 200, `image/png`, `Accept-Ranges: bytes` | same |
| `GET <base>doc.pdf`, `Range: bytes=0-99` | 206, `Content-Range: bytes 0-99/4331`, 100 bytes | same |
| `GET <base>doc.pdf`, `Range: bytes=-10` | 206, `Content-Range: bytes 4321-4330/4331` | same |
| `GET <base>img/logo.svg` | not run | 200, `image/svg+xml`; as an `<img>` it drew 30x30 and its `<script>` did not run |
| `%2e%2e/outside.png`, `img%5c..%5c..%5coutside.png` | refused (fetch fails) | same |
| `secret.exe`, a POST, an unknown grant | refused (fetch fails) | same |

- **CORS.** Both origins read the response headers of a cross-origin fetch, so pdf.js (NS-3D) can make Range requests. Refusals carry no CORS headers, so the page sees a failed fetch rather than a status; that is enough for `<img>` and pdf.js.
- **Capture window.** Not run in the app: the capture window opens only from the global shortcut or the tray, and a test would have to send keystrokes to the desktop. The cargo test in `assets.rs` checks that a request labelled `capture` gets 403.
- **SVG header.** The strict `Content-Security-Policy` on SVG responses is not visible to a cross-origin `fetch` (only the Range headers are exposed); the cargo test checks it.
- **Reading view.** `![cat](img/cat.png)` rendered 40x30 from the notebook, and `![pic](pic.png)` beside a loose file 20x20; `../outside.png` and a `file:` URL showed their alt text.
- **pdf.js.** Not run: pdf.js arrives in NS-3D. The Range and CORS results above are what it needs.

## Decision

Keep the scheme as built. The `data:` URL fallback in [deferred.md](deferred.md) is not needed.
