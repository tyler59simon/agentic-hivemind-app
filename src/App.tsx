import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { Sidebar } from "./features/library/Sidebar";
import { Palette } from "./features/palette/Palette";
import { SearchPanel } from "./features/search/SearchPanel";
import { SettingsForm } from "./features/settings/SettingsForm";
import { NoteView } from "./features/viewer/NoteView";
import { connect, domains } from "./lib/lm";
import { useApp } from "./store";

function useShortcuts() {
  const { setPalette, setView } = useApp();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "p" && !e.shiftKey) { e.preventDefault(); setPalette("commands"); }
      else if (key === "o") { e.preventDefault(); setPalette("notes"); }
      else if (key === "f" && e.shiftKey) { e.preventDefault(); setView("search"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette, setView]);
}

/** Refresh lists and open notes when the store's note files change (agents write while you read). */
function useLiveRefresh(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const stop = listen("notes-changed", () => client.invalidateQueries());
    return () => { stop.then((unlisten) => unlisten()); };
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

  // Start on the largest bound domain once domains are known.
  useEffect(() => {
    if (app.domain || !known.data) return;
    const first = [...known.data.domains].filter((d) => d.bound).sort((a, b) => b.active - a.active)[0] ?? known.data.domains[0];
    if (first) app.setDomain(first.name);
  }, [known.data, app]);

  const reconnect = useCallback(() => { setSettings(false); client.resetQueries(); }, [client]);

  if (link.isLoading) return <main className="center muted">Connecting to Living Memory…</main>;
  if (link.error || settings) {
    return (
      <main className="center">
        <div className="card">
          <h1>Hivemind</h1>
          {link.error && <p className="error">{String(link.error)}</p>}
          <SettingsForm onSaved={reconnect} />
          {link.isSuccess && <button className="link" onClick={() => setSettings(false)}>Back</button>}
        </div>
      </main>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <strong>Hivemind</strong>
        <div className="tabs">
          <button className={app.view === "notes" ? "on" : ""} onClick={() => app.setView("notes")}>Notes</button>
          <button className={app.view === "search" ? "on" : ""} onClick={() => app.setView("search")}>Search</button>
        </div>
        <button className="ghost" onClick={() => app.setPalette("commands")} title="Command palette (Ctrl+P)">Commands</button>
        <span className="muted small" title={link.data!.script}>{link.data!.root}</span>
      </header>
      <div className="panes">
        {app.view === "notes" ? <Sidebar /> : <SearchPanel />}
        <main className="content">
          {app.selected ? <NoteView refId={app.selected} /> : (
            <div className="center muted">
              <p>Select a note, or press <kbd>Ctrl</kbd>+<kbd>O</kbd> to jump to one.</p>
            </div>
          )}
        </main>
      </div>
      <Palette onSettings={() => setSettings(true)} onReconnect={reconnect} />
    </div>
  );
}
