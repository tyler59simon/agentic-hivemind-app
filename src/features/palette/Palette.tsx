import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { domains, list } from "../../lib/lm";
import { fuzzy } from "../../lib/text";
import { useApp } from "../../store";
import { useWorkspace } from "../../workspace/store";

interface Entry { key: string; label: string; detail?: string; run: () => void }

/** Extra commands registered by features (new note, graph, activity, tags…). */
export const EXTRA_COMMANDS: { key: string; label: string; detail?: string; run: () => void }[] = [];

/** Ctrl+O: jump to a note by title. Ctrl+P: run a command. */
export function Palette({ onSettings, onReconnect }: { onSettings: () => void; onReconnect: () => void }) {
  const app = useApp();
  const ws = useWorkspace();
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const notes = useQuery({ queryKey: ["list", "*"], queryFn: () => list({ allDomains: true }), enabled: app.palette === "notes" });
  const known = useQuery({ queryKey: ["domains"], queryFn: domains, enabled: app.palette === "commands" });
  useEffect(() => { setQuery(""); setIndex(0); }, [app.palette]);

  const entries = useMemo<Entry[]>(() => {
    if (app.palette === "notes") {
      return (notes.data?.notes ?? []).map((n) => ({
        key: n.ref, label: n.title, detail: `${n.domain} · ${n.type}`,
        run: () => { app.setDomain(n.domain); app.setPalette(null); ws.openNote(n.ref, { title: n.title }); },
      }));
    }
    const close = () => app.setPalette(null);
    return [
      { key: "go", label: "Go to note…", detail: "Ctrl+O", run: () => app.setPalette("notes") },
      { key: "new", label: "New note", detail: "Ctrl+N", run: () => { close(); ws.openTab({ kind: "new-note" }); } },
      ...EXTRA_COMMANDS.map((c) => ({ ...c, run: () => { close(); c.run(); } })),
      { key: "split", label: "Split pane", detail: "Ctrl+\\", run: () => { ws.split(); close(); } },
      { key: "panel", label: ws.panel ? "Hide the right sidebar" : "Show the right sidebar", run: () => { ws.setPanel(ws.panel ? null : "outline"); close(); } },
      { key: "search", label: "Search notes", detail: "Ctrl+Shift+F", run: () => { app.setView("search"); close(); } },
      { key: "active", label: "Show active notes", run: () => { app.setView("notes"); app.setShelf("active"); close(); } },
      { key: "archive", label: "Show the archive", run: () => { app.setView("notes"); app.setShelf("archived"); close(); } },
      { key: "refresh", label: "Refresh", run: () => { client.invalidateQueries(); close(); } },
      { key: "reconnect", label: "Reconnect to Living Memory", run: () => { onReconnect(); close(); } },
      { key: "settings", label: "Settings", run: () => { onSettings(); close(); } },
      ...(known.data?.domains ?? []).map((d) => ({
        key: "domain:" + d.name, label: `Switch domain: ${d.name}`, detail: `${d.active} notes`,
        run: () => { app.setDomain(d.name); close(); },
      })),
    ];
  }, [app, ws, notes.data, known.data, client, onSettings, onReconnect]);

  const shown = useMemo(() => entries
    .map((e) => ({ e, score: fuzzy(query, e.label) }))
    .filter((x) => x.score !== null)
    .sort((a, b) => (b.score! - a.score!))
    .slice(0, 50)
    .map((x) => x.e), [entries, query]);

  if (!app.palette) return null;
  const choose = (entry?: Entry) => entry?.run();
  return (
    <div className="overlay" onMouseDown={() => app.setPalette(null)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Palette">
        <input autoFocus value={query} placeholder={app.palette === "notes" ? "Go to note…" : "Run a command…"}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") app.setPalette(null);
            else if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") choose(shown[index]);
          }} />
        <ul>
          {shown.map((entry, i) => (
            <li key={entry.key}>
              <button className={i === index ? "on" : ""} onMouseEnter={() => setIndex(i)} onClick={() => choose(entry)}>
                <span>{entry.label}</span>{entry.detail && <span className="muted">{entry.detail}</span>}
              </button>
            </li>
          ))}
          {app.palette === "notes" && notes.isLoading && <li className="muted pad">Loading…</li>}
        </ul>
      </div>
    </div>
  );
}
