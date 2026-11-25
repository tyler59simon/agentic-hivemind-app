import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import "./App.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { QuickCapture } from "./features/capture/QuickCapture";
import { initDefaultMode } from "./lib/appearance";
import { initDocSize } from "./lib/docSize";
import { guardReload } from "./lib/keys";
import { inTauri } from "./lib/native";
import { initPaperDefault } from "./lib/paper";
import { installGlobalLogging } from "./lib/log";
import { isMac } from "./lib/platform";
import { initSpellcheck } from "./lib/spellcheck";
import { initTheme } from "./lib/theme";
import { initTypography } from "./lib/typography";
import { initZoom } from "./lib/zoom";
import { Announcer } from "./ui/announce";
import { ErrorBoundary } from "./ui/ErrorBoundary";

installGlobalLogging();
initTheme();
initPaperDefault();
initDocSize();
initDefaultMode();
initSpellcheck();
initTypography();
guardReload();
initZoom();
if (isMac) document.documentElement.classList.add("mac");

/** After the whole window failed, the app's own close guard is gone: closing hides instead, so running terminals and agent
 *  sessions are not killed (tray Quit, clicked twice, still exits). */
let hideOnClose = false;
function keepRunningOnClose(): void {
  if (hideOnClose || !inTauri()) return;
  hideOnClose = true;
  const win = getCurrentWindow();
  void win.onCloseRequested(async (e) => { e.preventDefault(); await win.hide(); });
}

const client = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 } },
});

// One bundle, two windows: the quick-capture window is opened at #capture.
const isCapture = window.location.hash === "#capture";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label={isCapture ? "Quick capture" : "Hivemind"} onError={keepRunningOnClose}
      hint="Running terminals and agent sessions keep running. Reload the window to go on."
      retry={{ label: "Reload window", run: () => window.location.reload() }}>
      <QueryClientProvider client={client}>
        {isCapture ? <QuickCapture /> : <App />}
      </QueryClientProvider>
    </ErrorBoundary>
    {/* Outside the boundary, so screen readers still hear messages after a failure (DESK-7). */}
    <Announcer />
  </React.StrictMode>,
);
