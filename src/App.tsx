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
import { SchedulesSection } from "./features/schedules/SchedulesSection";
import { MaintenanceSection } from "./features/maintenance/MaintenanceSection";
import { AboutDialog } from "./features/help/AboutDialog";
import { HelpRow } from "./features/help/HelpRow";
import { ShortcutsDialog, useShortcutsDialog } from "./features/shortcuts/ShortcutsDialog";
import { ShortcutsSection } from "./features/shortcuts/ShortcutsSection";
import { agentSessions } from "./lib/agent";
import { captureStatus, connect, domains, setBridgeGeneration } from "./lib/lm";
import { editableTarget, isMac } from "./lib/platform";
import { combo, defaultCombo, matches, normalize } from "./lib/shortcuts";
import { prefs } from "./lib/prefs";
import { appQuit, notifyTray, quitAck, termList } from "./lib/term";
import { useAttentionEvents } from "./features/terminal/attention";
import { QuitDialog } from "./features/terminal/QuitDialog";
import { runningSummary } from "./features/terminal/running";
import { listenOnce, useWikiBuild } from "./features/wiki/build";
import { wikiAgentRunning } from "./lib/wiki";
import { invalidateWiki } from "./features/wiki/useWiki";
import { needsLmUpdate, useConnection } from "./lib/connection";
import { refreshStore } from "./lib/refresh";
import { skillsSyncNow } from "./lib/skills";
import { toggleFocusMode, toggleFullscreen, toggleSidebar } from "./shell/layout";
import { cycleRegion } from "./shell/regions";
import { useWindowTitle } from "./shell/title";
import { Shell } from "./shell/Shell";
import { closeSettings, openInbox, openSession, openSettings, useApp } from "./store";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { toast, Toasts } from "./ui/toast";
import { ZoomBadge } from "./ui/ZoomBadge";
import { unsavedBinaryFiles, unsavedUntitled, useWorkspace } from "./workspace/store";
import { onDocsChanged, onFilesChanged, onPageAppended, startDocumentSync, type DocsChanged } from "./documents/sync";
import { onIndexProgress } from "./features/search/indexState";
import type { IndexProgress } from "./lib/noteindex";
import { draftsPending, flushAllDrafts, onDraftLost, setLmStore } from "./documents/store";
import { useOpenRequests } from "./features/notes/opening";
import { ComparePicker } from "./features/power/ComparePicker";
import { newPageHere } from "./features/notes/actions";
import type { FilesChanged } from "./lib/notebooks";
import { modalOpen } from "./ui/layers";

/** Whether the key goes to an editor that uses it: the sheet key is the editor's comment toggle only while it still is that
 *  key. A terminal never needs this: it stops every key at its own element, so the app's handlers do not see it. */
const editorKeepsKey = (target: EventTarget | null): boolean =>
  normalize(combo("shortcuts.show")) === normalize(defaultCombo("editor.comment")) && !!(target as Element | null)?.closest?.(".cm-editor");

/** Shortcuts that work on every page, by the keys the registry has (src/lib/shortcuts.ts). Ctrl+K and Ctrl+Shift+F belong to
 *  the top bar's search; tab ones to the open notes. */
export function useShortcuts() {
  const client = useQueryClient();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { setPalette, go, goBack } = useApp.getState();
      if (modalOpen()) return; // a dialog is open: nothing behind it changes (DESK-4)
      // On macOS Option+Left moves a word left in text, so it goes back only outside text fields.
      if (matches(e, "nav.back") && !(isMac && editableTarget(e.target))) { e.preventDefault(); goBack(); return; }
      if (matches(e, "palette.commands")) { e.preventDefault(); setPalette("commands"); }
      else if (matches(e, "palette.notes")) { e.preventDefault(); setPalette("notes"); }
      // Ctrl+/ is the editor's comment toggle: an editor keeps it. A remapped sheet key works there.
      else if (matches(e, "shortcuts.show") && !editorKeepsKey(e.target)) { e.preventDefault(); useShortcutsDialog.getState().show(); }
      else if (matches(e, "note.new")) {
        e.preventDefault();
        if (useApp.getState().route.page === "notes") void newPageHere(client);
        else useWorkspace.getState().openTab({ kind: "new-note" });
      }
      else if (matches(e, "graph.open")) { e.preventDefault(); go({ page: "notes", view: "graph" }); }
      else if (matches(e, "tab.close")) e.preventDefault(); // closes a note tab when notes are shown; never the window
      else if (matches(e, "sidebar.toggle")) { e.preventDefault(); toggleSidebar(); }
      else if (matches(e, "focus.toggle")) { e.preventDefault(); toggleFocusMode(); }
      else if (matches(e, "fullscreen.toggle")) { e.preventDefault(); void toggleFullscreen(); }
      // The window's regions in turn (DESK-A11Y A2). A page with no shell (the Settings card) has none, and the key is left alone.
      else if (matches(e, "region.next") || matches(e, "region.prev")) { if (cycleRegion(matches(e, "region.next") ? 1 : -1)) e.preventDefault(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);
}

/** What runs now: terminals, chat turns and a wiki build, one line each. The terminal and chat lines are left out when their lists cannot be read. */
async function running(): Promise<string[]> {
  const lists = await Promise.all([termList(), agentSessions()]).catch(() => null);
  // Rust's own view covers a rebuild the window has not heard of yet (Codex re-review of 55cfab2).
  const native = useWikiBuild.getState().running ? null : await wikiAgentRunning().catch(() => null);
  const wiki = useWikiBuild.getState().running ?? (native && { domain: native.domain, project: native.scope === "domain" ? "" : native.scope });
  return runningSummary(lists?.[0] ?? [], lists?.[1] ?? [], wiki);
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
    // The wiki build's listeners stay for the app's life: a scheduled rebuild then shows in the quit summary even when the wiki
    // was never opened (Codex review of 99ceaea, W2).
    listenOnce(client).catch(() => undefined);
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
      // Skill sync changed a skill or its note (a watcher, a connect, or a focus pass).
      listen("skills-changed", () => client.invalidateQueries({ queryKey: ["skills"] })),
      listen("architecture-drift", () => client.invalidateQueries({ queryKey: ["architecture", "drift"] })),
      listen("automations-changed", () => client.invalidateQueries({ queryKey: ["automations"] })),
      listen<string>("executive-changed", (e) => {
        client.invalidateQueries({ queryKey: ["executive", e.payload] });
        client.invalidateQueries({ queryKey: ["learning"] }); // a briefing spends the learning budget (Codex review of 99ceaea, B3)
      }),
      listen<{ ref: string }>("open-note", (e) => useWorkspace.getState().openNote(e.payload.ref)),
      listen<{ notebook: string; path: string }>("page-appended", (e) => onPageAppended(client, e.payload)),
      listen<FilesChanged>("files-changed", (e) => onFilesChanged(client, e.payload)),
      listen<DocsChanged>("docs-changed", (e) => onDocsChanged(client, e.payload)),
      listen<IndexProgress>("index-progress", (e) => onIndexProgress(client, e.payload)),
    ];
    // Linked skills sync when the window gets focus, at most once every 10 seconds. Errors only go to the console.
    let last = 0;
    const onFocus = () => {
      if (Date.now() - last < 10_000) return;
      last = Date.now();
      skillsSyncNow().catch((e) => console.warn("skills_sync failed", e));
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      stops.forEach((stop) => stop.then((unlisten) => unlisten()));
    };
  }, [enabled, client]);
}

/** Settings while it is open. A link that opened it at a section (or at one automation) scrolls there once it has drawn. */
export function useSettingsScroll() {
  const settings = useApp((s) => s.settings);
  useEffect(() => {
    if (!settings?.section) return;
    const ids = [...(settings.automation ? [`automation-${settings.automation}`] : []), `settings-${settings.section}`];
    const frame = requestAnimationFrame(() => ids.map((id) => document.getElementById(id)).find(Boolean)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [settings]);
  return settings;
}

/** The Settings card has no top bar, which names the window for the pages; this names it for the card ("Settings - Hivemind"). */
function SettingsTitle() {
  useWindowTitle(["Settings"], false);
  return null;
}

export default function App() {
  const app = useApp();
  const client = useQueryClient();
  const settings = useSettingsScroll();
  const setSettings = (open: boolean) => (open ? openSettings() : closeSettings());
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
    // Note sessions belong to the store they were read from, and their requests to the bridge generation that serves it.
    setBridgeGeneration(link.data.generation);
    setLmStore(link.data.root);
  }, [link.data]);

  // Start on the largest bound domain once domains are known.
  useEffect(() => {
    if (app.domain || !known.data) return;
    const first = [...known.data.domains].filter((d) => d.bound).sort((a, b) => b.active - a.active)[0] ?? known.data.domains[0];
    if (first) app.setDomain(first.name);
  }, [known.data, app]);

  const reconnect = useCallback(() => { closeSettings(); client.resetQueries(); }, [client]);

  // The dialogs belong to every branch: tray Quit must show its dialog while Settings is open or the connection has failed.
  const dialogs = <>{closeGuard}{quitDialog}{folderOffer}<ShortcutsDialog /><AboutDialog /></>;
  if (link.isLoading) return <><main className="center muted">Connecting to Living Memory…</main>{dialogs}</>;
  const outdated = link.isSuccess && needsLmUpdate(link.data.version);
  if (link.error || outdated || settings) {
    return (
      <>
        <SettingsTitle />
        <main className="center">
          <div className="card">
            <h1 className="brand"><img src={logo} alt="" />Hivemind</h1>
            {link.error && <p className="error">{String(link.error)}</p>}
            {outdated && <p className="error">This version of Living Memory is too old: Hivemind needs one with direct writes and unified proposals (<code>alm version</code> lists <code>direct_writes</code> and <code>proposals</code> under capabilities). Update Living Memory, then reconnect.</p>}
            <SettingsForm onSaved={reconnect} />
            <ShortcutsSection />
            <HelpRow />
            {link.isSuccess && !outdated && <><SchedulesSection /><MaintenanceSection /></>}
            <BeforeUninstall
              onOpenReview={link.isSuccess && !outdated ? (id) => { setSettings(false); openInbox(id); } : undefined}
              onOpenSession={link.isSuccess && !outdated ? (id) => { setSettings(false); openSession(id); } : undefined} />
            {link.isSuccess && !outdated && <button className="link" onClick={() => setSettings(false)}>Back</button>}
          </div>
        </main>
        {/* Schedules and Maintenance report through toasts (Codex review of 857ec37, S1). */}
        <Toasts />
        {dialogs}
      </>
    );
  }

  return (
    <>
      {/* Inside App, so the close guard and tray Quit keep working when the shell fails (DESK-1). */}
      <ErrorBoundary label="Hivemind" onError={() => void flushAllDrafts()} hint="Your unsaved edits are kept as drafts, and running terminals and agent sessions keep running.">
        <Shell info={link.data!} onSettings={() => setSettings(true)} onReconnect={reconnect} />
        <Palette onSettings={() => setSettings(true)} onReconnect={reconnect} />
        <ComparePicker />
      </ErrorBoundary>
      <Toasts />
      <ZoomBadge />
      {dialogs}
    </>
  );
}
