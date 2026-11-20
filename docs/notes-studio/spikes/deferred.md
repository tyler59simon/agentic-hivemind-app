# Spikes deferred to their phases: S1, S2 and S8

These three spikes need a running or installed Hivemind build. Running `tauri dev` means closing the user's Hivemind (single-instance lock), so each runs at the start of the phase that needs it, and its verdict is added here.

| Spike | Runs at | What it measures |
| --- | --- | --- |
| S1 `hmfile` scheme | Start of NS-1B | An asynchronous URI scheme serves PNG, SVG and PDF to WebView2 as `http://hmfile.localhost/...` under the CSP change; Range requests reach the handler and pdf.js renders a page, fetching with CORS from both the dev and the production origin (review U11); a request from the capture window is refused by the webview label check |
| S2 associations and Open with | During NS-1B, on an installed NSIS build | `bundle.fileAssociations` for `.md`, `.markdown`, `.hmdoc` and `.canvas`; the installer hook for "Open with" on any file with `MultiSelectModel=Player`; a three-file Explorer selection reaches one process; a launch with paths while an older instance runs falls back to raising its window |
| S8 print to PDF | Start of NS-9A | A hidden window renders a page; `with_webview` reaches the WebView2 controller; `ICoreWebView2_7::PrintToPdf` through `webview2-com`, pinned to the version Tauri already resolves, writes a PDF with selectable text and the page's images |

Results so far:
- **S1** passed on 2026-11-20 in the dev app and the release build: [s1-hmfile.md](s1-hmfile.md).
- **S2** is half done. The installers build with the associations and the hook, and a second launch with paths reaches the running app (tested by starting the debug executable a second time). The Explorer checks need an installed build, which replaces the user's installed Hivemind, so they wait for the user (see the Shipped section of [../phase-1b-open-any-file.md](../phase-1b-open-any-file.md)).

If a spike fails, its phase changes before any code depends on it: S1 falls back to `data:` URLs for images under 2 MB and no PDF preview; S2 ships the Open dialog and drag and drop only; S8 ships HTML and DOCX export only.
