import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Confirm } from "./ui/Modal";
import { useCallback, useEffect, useState } from "react";
import "./App.css";
import logo from "./assets/logo.png";
import { Palette } from "./features/palette/Palette";
import { SettingsForm } from "./features/settings/SettingsForm";
import { agentSessions } from "./lib/agent";
import { captureStatus, connect, domains } from "./lib/lm";
import { prefs } from "./lib/prefs";
import { appQuit, notifyTray, quitAck, termList } from "./lib/term";
import { useAttentionEvents } from "./features/terminal/attention";
import { QuitDialog } from "./features/terminal/QuitDialog";
import { runningSummary } from "./features/terminal/running";
import { needsLmUpdate, useConnection } from "./lib/connection";
import { refreshStore } from "./lib/refresh";
import { Shell } from "./shell/Shell";
import { useApp } from "./store";
import { toast, Toasts } from "./ui/toast";
import { useWorkspace } from "./workspace/store";

/** Shortcuts that work on every page. Ctrl+K and Ctrl+Shift+F belong to the top bar's search; tab ones to the open notes. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { setPalette, go, goBack } = useApp.getState();
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBack(); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "p" && !e.shiftKey) { e.preventDefault(); setPalette("commands"); }
      else if (key === "o") { e.preventDefault(); setPalette("notes"); }
      else if (key === "n" && !e.shiftKey) { e.preventDefault(); useWorkspace.getState().openTab({ kind: "new-note" }); }
      else if (key === "g" && !e.shiftKey) { e.preventDefault(); go({ page: "memory", view: "graph" }); }
      else if (key === "a" && e.shiftKey) { e.preventDefault(); go({ page: "memory", view: "activity" }); }
      else if (key === "w") e.preventDefault(); // closes a note tab when notes are shown; never the window
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** What runs now: terminals and chat turns, one line each. Empty when nothing does or when the lists cannot be read. */
async function running(): Promise<string[]> {
  const lists = await Promise.all([termList(), agentSessions()]).catch(() => null);
  return lists ? runningSummary(lists[0], lists[1]) : [];
}

/** Closing the window hides it to the tray while anything runs, or when that is on (the quick-capture hotkey keeps working);
 *  otherwise, with unsaved edits, it asks first (the drafts survive either way). */
function useCloseGuard() {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    const stop = win.onCloseRequested(async (e) => {
      if ((await running()).length > 0) {
        e.preventDefault();
        await win.hide();
        // A Windows notification from Rust: a toast inside the window would be raised just as the window hides.
        if (!prefs.trayNoticeShown()) { prefs.setTrayNoticeShown(); notifyTray().catch(() => undefined); }
        return;
      }
      const status = await captureStatus().catch(() => null);
      if (status?.close_to_tray) { e.preventDefault(); await win.hide(); return; }
      if (Object.values(useWorkspace.getState().dirty).some(Boolean)) { e.preventDefault(); setAsking(true); }
    });
    return () => { stop.then((unlisten) => unlisten()); };
  }, []);
  return asking && (
    <Confirm title="Quit with unsaved changes?" danger action="Quit"
      message="Some tabs have edits that are not saved to Living Memory. They are kept as drafts and come back when you reopen those notes."
      onAnswer={(yes) => { setAsking(false); if (yes) getCurrentWindow().destroy(); }} />
  );
}

/** Tray Quit: the backend shows the window and asks; nothing running quits at once, otherwise the dialog names what stops. */
function useQuitRequest() {
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    const stop = listen("quit-requested", async () => {
      quitAck().catch(() => undefined);
      const now = await running();
      if (now.length === 0) appQuit().catch((e) => toast(String(e), "error"));
      else setLines(now);
    });
    return () => { stop.then((unlisten) => unlisten()); };
  }, []);
  return lines && <QuitDialog lines={lines} onKeep={() => setLines(null)} onQuit={() => appQuit().catch((e) => toast(String(e), "error"))} />;
}

/** Refresh lists and open notes when the store's note files change (agents write while you read).
 *  The quick-capture window asks the main window to open a note with an "open-note" event. */
function useLiveRefresh(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const stops = [
      listen("notes-changed", () => refreshStore(client)),
      listen("store-changed", () => {
        client.invalidateQueries({ queryKey: ["projects"] });
        client.invalidateQueries({ queryKey: ["systems"] });
        client.invalidateQueries({ queryKey: ["taxonomy"] });
        client.invalidateQueries({ queryKey: ["changes"] });
        client.invalidateQueries({ queryKey: ["views"] }); // views.json: dashboards added or removed from the CLI
        client.invalidateQueries({ queryKey: ["log"] });
        client.invalidateQueries({ queryKey: ["recap"] });
        client.invalidateQueries({ queryKey: ["maintenance"] });
        client.invalidateQueries({ queryKey: ["wiki"] }); // projects.json and bindings decide the wiki's projects and folders
      }),
      listen("agent-sessions-changed", () => client.invalidateQueries({ queryKey: ["agent", "sessions"] })),
      listen<{ ref: string }>("open-note", (e) => useWorkspace.getState().openNote(e.payload.ref)),
    ];
    return () => { stops.forEach((stop) => stop.then((unlisten) => unlisten())); };
  }, [enabled, client]);
}

export default function App() {
  const app = useApp();
  const client = useQueryClient();
  const [settings, setSettings] = useState(false);
  const link = useQuery({ queryKey: ["connect"], queryFn: connect, retry: false, staleTime: Infinity });
  const known = useQuery({ queryKey: ["domains"], queryFn: domains, enabled: link.isSuccess });
  useShortcuts();
  useLiveRefresh(link.isSuccess);
  useAttentionEvents();
  const closeGuard = useCloseGuard();
  const quitDialog = useQuitRequest();
  useEffect(() => { if (link.data) useConnection.getState().set(link.data.version); }, [link.data]);

  // Start on the largest bound domain once domains are known.
  useEffect(() => {
    if (app.domain || !known.data) return;
    const first = [...known.data.domains].filter((d) => d.bound).sort((a, b) => b.active - a.active)[0] ?? known.data.domains[0];
    if (first) app.setDomain(first.name);
  }, [known.data, app]);

  const reconnect = useCallback(() => { setSettings(false); client.resetQueries(); }, [client]);

  // The dialogs belong to every branch: tray Quit must show its dialog while Settings is open or the connection has failed.
  const dialogs = <>{closeGuard}{quitDialog}</>;
  if (link.isLoading) return <><main className="center muted">Connecting to Living Memory…</main>{dialogs}</>;
  const outdated = link.isSuccess && needsLmUpdate(link.data.version);
  if (link.error || outdated || settings) {
    return (
      <>
        <main className="center">
          <div className="card">
            <h1 className="brand"><img src={logo} alt="" />Hivemind</h1>
            {link.error && <p className="error">{String(link.error)}</p>}
            {outdated && <p className="error">This version of Living Memory is too old: Hivemind needs one with direct writes (<code>alm version</code> lists <code>direct_writes</code> under capabilities). Update Living Memory, then reconnect.</p>}
            <SettingsForm onSaved={reconnect} />
            {link.isSuccess && !outdated && <button className="link" onClick={() => setSettings(false)}>Back</button>}
          </div>
        </main>
        {dialogs}
      </>
    );
  }

  return (
    <>
      <Shell info={link.data!} onSettings={() => setSettings(true)} onReconnect={reconnect} />
      <Palette onSettings={() => setSettings(true)} onReconnect={reconnect} />
      <Toasts />
      {dialogs}
    </>
  );
}
