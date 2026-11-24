import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Confirm } from "./ui/Modal";
import { useCallback, useEffect, useState } from "react";
import "./App.css";
import logo from "./assets/logo.png";
import { Palette } from "./features/palette/Palette";
import { BeforeUninstall } from "./features/settings/BeforeUninstall";
import { SettingsForm } from "./features/settings/SettingsForm";
import { agentSessions } from "./lib/agent";
import { captureStatus, connect, domains, setBridgeGeneration } from "./lib/lm";
import { prefs } from "./lib/prefs";
import { appQuit, notifyTray, quitAck, termList } from "./lib/term";
import { useAttentionEvents } from "./features/terminal/attention";
import { QuitDialog } from "./features/terminal/QuitDialog";
import { runningSummary } from "./features/terminal/running";
import { useWikiBuild } from "./features/wiki/build";
import { invalidateWiki } from "./features/wiki/useWiki";
import { needsLmUpdate, useConnection } from "./lib/connection";
import { refreshStore } from "./lib/refresh";
import { Shell } from "./shell/Shell";
import { openInbox, openSession, useApp } from "./store";
import { toast, Toasts } from "./ui/toast";
import { unsavedBinaryFiles, unsavedUntitled, useWorkspace } from "./workspace/store";
import { onDocsChanged, onFilesChanged, onPageAppended, startDocumentSync, type DocsChanged } from "./documents/sync";
import { onIndexProgress } from "./features/search/indexState";
import type { IndexProgress } from "./lib/noteindex";
import { draftsPending, flushAllDrafts, onDraftLost, setLmStore } from "./documents/store";
import { useOpenRequests } from "./features/notes/opening";
import { ComparePicker } from "./features/power/ComparePicker";
import { newPageHere } from "./features/notes/actions";
import type { FilesChanged } from "./lib/notebooks";

/** Shortcuts that work on every page. Ctrl+K and Ctrl+Shift+F belong to the top bar's search; tab ones to the open notes. */
function useShortcuts() {
  const client = useQueryClient();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { setPalette, go, goBack } = useApp.getState();
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBack(); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "p" && !e.shiftKey) { e.preventDefault(); setPalette("commands"); }
      else if (key === "o") { e.preventDefault(); setPalette("notes"); }
      else if (key === "n" && !e.shiftKey) {
        e.preventDefault();
        if (useApp.getState().route.page === "notes") void newPageHere(client);
        else useWorkspace.getState().openTab({ kind: "new-note" });
      }
      else if (key === "g" && !e.shiftKey) { e.preventDefault(); go({ page: "notes", view: "graph" }); }
      else if (key === "w") e.preventDefault(); // closes a note tab when notes are shown; never the window
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);
}

/** What runs now: terminals, chat turns and a wiki build, one line each. The terminal and chat lines are left out when their lists cannot be read. */
async function running(): Promise<string[]> {
  const lists = await Promise.all([termList(), agentSessions()]).catch(() => null);
  return runningSummary(lists?.[0] ?? [], lists?.[1] ?? [], useWikiBuild.getState().running);
}

/** Before any quit: write every pending notebook page draft and wait for it. Edits that cannot be kept are named, and
 *  the user decides (Codex review of 32fd236, D5). */
function useKeepDrafts() {
  const [lost, setLost] = useState<{ lines: string[]; quit: () => void } | null>(null);
  const run = useCallback(async (quit: () => void) => {
    const failed = await flushAllDrafts();
    if (failed.length) setLost({ lines: failed, quit });
    else quit();
  }, []);
  const dialog = lost && (
    <Confirm title="Some unsaved edits cannot be kept" danger action="Quit anyway"
      message={<><p>These pages have edits that are not saved and could not be kept as drafts:</p><ul>{lost.lines.map((l) => <li key={l}>{l}</li>)}</ul><p>Save them first to keep them.</p></>}
      onAnswer={(yes) => { setLost(null); if (yes) lost.quit(); }} />
  );
  return [run, dialog] as const;
}

/** Closing the window hides it to the tray while anything runs, or when that is on (the quick-capture hotkey keeps working);
 *  otherwise, with unsaved edits, it asks first (the drafts survive either way). */
function useCloseGuard() {
  // Whether any unsaved tab has no persisted draft (never-saved text file, or Word/PDF edits).
  const [asking, setAsking] = useState<{ untitled: boolean; binary: boolean } | null>(null);
  const [keepDrafts, draftDialog] = useKeepDrafts();
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
      const ws = useWorkspace.getState();
      if (Object.values(ws.dirty).some(Boolean)) {
        e.preventDefault();
        setAsking({ untitled: unsavedUntitled(ws), binary: unsavedBinaryFiles(ws) });
        return;
      }
      // No unsaved tab, but a closed page's draft may still be on its way, or have failed: write or report it first
      // (Codex re-review of b82e9ab, N3).
      if (draftsPending()) { e.preventDefault(); void keepDrafts(() => { void getCurrentWindow().destroy(); }); }
    });
    return () => { stop.then((unlisten) => unlisten()); };
  }, []);
  const lostParts: string[] = [];
  if (asking?.binary) lostParts.push("Unsaved Word (.docx) and PDF edits are not kept as drafts and will be lost.");
  if (asking?.untitled) lostParts.push("A new text file that was never saved is lost.");
  return (
    <>
      {asking && (
        <Confirm title="Quit with unsaved changes?" danger action="Quit"
          message={`Some tabs have edits that are not saved. Text notes and pages are kept as drafts and come back when you reopen them.${lostParts.length ? ` ${lostParts.join(" ")}` : ""}`}
          onAnswer={(yes) => { setAsking(null); if (yes) void keepDrafts(() => { void getCurrentWindow().destroy(); }); }} />
      )}
      {draftDialog}
    </>
  );
}

/** Tray Quit: the backend shows the window and asks; nothing running quits at once, otherwise the dialog names what stops. */
export function useQuitRequest() {
  const [lines, setLines] = useState<string[] | null>(null);
  const [keepDrafts, draftDialog] = useKeepDrafts();
  const [unpersisted, setUnpersisted] = useState<{ untitled: boolean; binary: boolean } | null>(null);
  const quit = useCallback(() => keepDrafts(() => { appQuit().catch((e) => toast(String(e), "error")); }), [keepDrafts]);
  // Tray Quit asks too when a never-saved text file or unsaved Word/PDF file holds edits without a persisted draft.
  const finish = useCallback(() => {
    const ws = useWorkspace.getState();
    const untitled = unsavedUntitled(ws);
    const binary = unsavedBinaryFiles(ws);
    if (untitled || binary) setUnpersisted({ untitled, binary });
    else void quit();
  }, [quit]);
  useEffect(() => {
    const stop = listen("quit-requested", async () => {
      quitAck().catch(() => undefined);
      const now = await running();
      if (now.length === 0) finish();
      else setLines(now);
    });
    return () => { stop.then((unlisten) => unlisten()); };
  }, [finish]);
  const quitTitle = unpersisted?.binary
    ? "Quit with unsaved changes that will be lost?"
    : "Quit with an unsaved new text file?";
  const quitMsg = [
    unpersisted?.binary ? "Unsaved Word (.docx) or PDF edits are not kept as drafts and will be lost when Hivemind quits." : "",
    unpersisted?.untitled ? "A new text file that was never saved is lost when Hivemind quits." : "",
  ].filter(Boolean).join(" ");
  return (
    <>
      {lines && <QuitDialog lines={lines} onKeep={() => setLines(null)} onQuit={() => { setLines(null); finish(); }} />}
      {unpersisted && (
        <Confirm title={quitTitle} danger action="Quit"
          message={quitMsg}
          onAnswer={(yes) => { setUnpersisted(null); if (yes) void quit(); }} />
      )}
      {draftDialog}
    </>
  );
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
        client.invalidateQueries({ queryKey: ["types"] });
        client.invalidateQueries({ queryKey: ["views"] }); // views.json: dashboards added or removed from the CLI
        client.invalidateQueries({ queryKey: ["recap"] });
        client.invalidateQueries({ queryKey: ["maintenance"] });
        invalidateWiki(client); // projects.json and bindings decide the wiki's projects and folders (both editions)
      }),
      listen("agent-sessions-changed", () => client.invalidateQueries({ queryKey: ["agent", "sessions"] })),
      // A post-session review finished: its drafts are in the proposal inbox and the skill proposals.
      listen("learning-changed", () => {
        client.invalidateQueries({ queryKey: ["learning"] });
        client.invalidateQueries({ queryKey: ["skills"] });
        client.invalidateQueries({ queryKey: ["proposals"] });
      }),
      listen("architecture-drift", () => client.invalidateQueries({ queryKey: ["architecture", "drift"] })),
      listen("workflows-changed", () => client.invalidateQueries({ queryKey: ["workflows"] })),
      listen("automations-changed", () => client.invalidateQueries({ queryKey: ["automations"] })),
      listen<string>("executive-changed", (e) => client.invalidateQueries({ queryKey: ["executive", e.payload] })),
      listen<{ ref: string }>("open-note", (e) => useWorkspace.getState().openNote(e.payload.ref)),
      listen<{ notebook: string; path: string }>("page-appended", (e) => onPageAppended(client, e.payload)),
      listen<FilesChanged>("files-changed", (e) => onFilesChanged(client, e.payload)),
      listen<DocsChanged>("docs-changed", (e) => onDocsChanged(client, e.payload)),
      listen<IndexProgress>("index-progress", (e) => onIndexProgress(client, e.payload)),
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
  const folderOffer = useOpenRequests();
  useEffect(() => startDocumentSync(), []);
  useEffect(() => onDraftLost((line) => toast(`Unsaved edits could not be kept as a draft: ${line}`, "error")), []);
  useEffect(() => {
    if (!link.data) return;
    useConnection.getState().set(link.data.version);
    // Living Memory pages belong to the store they were read from (Codex review of 32fee20, D1), and their requests to the
    // bridge generation that serves it (re-review of 75ce884, R2-D1).
    setBridgeGeneration(link.data.generation);
    setLmStore(link.data.root);
  }, [link.data]);

  // Start on the largest bound domain once domains are known.
  useEffect(() => {
    if (app.domain || !known.data) return;
    const first = [...known.data.domains].filter((d) => d.bound).sort((a, b) => b.active - a.active)[0] ?? known.data.domains[0];
    if (first) app.setDomain(first.name);
  }, [known.data, app]);

  const reconnect = useCallback(() => { setSettings(false); client.resetQueries(); }, [client]);

  // The dialogs belong to every branch: tray Quit must show its dialog while Settings is open or the connection has failed.
  const dialogs = <>{closeGuard}{quitDialog}{folderOffer}</>;
  if (link.isLoading) return <><main className="center muted">Connecting to Living Memory…</main>{dialogs}</>;
  const outdated = link.isSuccess && needsLmUpdate(link.data.version);
  if (link.error || outdated || settings) {
    return (
      <>
        <main className="center">
          <div className="card">
            <h1 className="brand"><img src={logo} alt="" />Hivemind</h1>
            {link.error && <p className="error">{String(link.error)}</p>}
            {outdated && <p className="error">This version of Living Memory is too old: Hivemind needs one with direct writes and unified proposals (<code>alm version</code> lists <code>direct_writes</code> and <code>proposals</code> under capabilities). Update Living Memory, then reconnect.</p>}
            <SettingsForm onSaved={reconnect} />
            <BeforeUninstall
              onOpenReview={link.isSuccess && !outdated ? (id) => { setSettings(false); openInbox(id); } : undefined}
              onOpenSession={link.isSuccess && !outdated ? (id) => { setSettings(false); openSession(id); } : undefined} />
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
      <ComparePicker />
      <Toasts />
      {dialogs}
    </>
  );
}
