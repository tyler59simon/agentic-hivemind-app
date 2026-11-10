import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useProjectsEnabled, useSystemsEnabled } from "../../lib/connection";
import { domains, list } from "../../lib/lm";
import { refreshStore } from "../../lib/refresh";
import { fuzzy } from "../../lib/text";
import { openProject, openSystem, useApp, type Route } from "../../store";
import { useWorkspace } from "../../workspace/store";
import { useProjectIntent } from "../projects/intent";
import { projectsQuery } from "../projects/useProject";
import { systemsQuery, useSystemIntent } from "../systems/useSystem";

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
  const projectsOn = useProjectsEnabled();
  const registry = useQuery({ ...projectsQuery(), enabled: projectsOn && app.palette === "commands" });
  const systemsOn = useSystemsEnabled();
  const systems = useQuery({ ...systemsQuery(), enabled: systemsOn && app.palette === "commands" });
  useEffect(() => { setQuery(""); setIndex(0); }, [app.palette]);

  const entries = useMemo<Entry[]>(() => {
    if (app.palette === "notes") {
      return (notes.data?.notes ?? []).map((n) => ({
        key: n.ref, label: n.title, detail: `${n.domain} · ${n.type}`,
        run: () => { app.setDomain(n.domain); app.setPalette(null); ws.openNote(n.ref, { title: n.title }); },
      }));
    }
    const close = () => app.setPalette(null);
    const page = (route: Route) => () => { close(); app.go(route); };
    return [
      { key: "go", label: "Go to note…", detail: "Ctrl+O", run: () => app.setPalette("notes") },
      { key: "new", label: "New note", detail: "Ctrl+N", run: () => { close(); ws.openTab({ kind: "new-note" }); } },
      { key: "overview", label: "Overview", run: page({ page: "overview" }) },
      { key: "memory", label: "Memory library", run: page({ page: "memory" }) },
      { key: "graph", label: "Open the graph", detail: "Ctrl+G", run: page({ page: "memory", view: "graph" }) },
      { key: "activity", label: "Recent activity (who changed what)", detail: "Ctrl+Shift+A", run: page({ page: "memory", view: "activity" }) },
      { key: "tags", label: "Manage tags", run: page({ page: "memory", view: "tags" }) },
      { key: "work", label: "Open work", run: page({ page: "overview", view: "work" }) },
      { key: "review", label: "Review", run: page({ page: "review" }) },
      { key: "changes", label: "Changes", run: page({ page: "changes" }) },
      ...(projectsOn ? [
        { key: "new-project", label: "New project…", run: () => { close(); useProjectIntent.getState().openWizard(); } },
        { key: "project:*", label: "Switch project: All memory", run: () => { close(); openProject(null); } },
        ...(registry.data?.projects ?? []).filter((p) => p.status === "active").map((p) => ({
          key: "project:" + p.slug, label: `Switch project: ${p.name}`, detail: p.tag,
          run: () => { close(); openProject(p.slug); },
        })),
      ] : []),
      ...(systemsOn ? [
        { key: "architecture", label: "Architecture", run: page({ page: "architecture" }) },
        { key: "new-system", label: "New system…", run: () => { close(); app.go({ page: "architecture" }); useSystemIntent.getState().openWizard(); } },
        { key: "sessions", label: "Agent Workspace (sessions)", run: page({ page: "agents" }) },
        ...(systems.data?.systems ?? []).filter((s) => s.status !== "retired").map((s) => ({
          key: "system:" + s.slug, label: `Open system: ${s.name}`, detail: s.tag,
          run: () => { close(); openSystem(s.slug); },
        })),
      ] : []),
      ...EXTRA_COMMANDS.map((c) => ({ ...c, run: () => { close(); c.run(); } })),
      { key: "split", label: "Open the note side by side", detail: "Ctrl+\\", run: () => { ws.split(); close(); } },
      { key: "rail", label: ws.rail ? "Hide the note's context rail" : "Show the note's context rail", run: () => { ws.setRail(!ws.rail); close(); } },
      { key: "search", label: "Search notes", detail: "Ctrl+K", run: page({ page: "memory" }) },
      { key: "active", label: "Show active notes", run: () => { app.setShelf("active"); close(); app.go({ page: "memory" }); } },
      { key: "archive", label: "Show the archive", run: () => { app.setShelf("archived"); close(); app.go({ page: "memory" }); } },
      { key: "back", label: "Back", detail: "Alt+Left", run: () => { close(); app.goBack(); } },
      { key: "refresh", label: "Refresh", run: () => { refreshStore(client); close(); } },
      { key: "reconnect", label: "Reconnect to Living Memory", run: () => { onReconnect(); close(); } },
      { key: "settings", label: "Settings", run: () => { onSettings(); close(); } },
      ...(known.data?.domains ?? []).map((d) => ({
        key: "domain:" + d.name, label: `Switch domain: ${d.name}`, detail: `${d.active} notes`,
        run: () => { app.setDomain(d.name); close(); },
      })),
    ];
  }, [app, ws, notes.data, known.data, registry.data, projectsOn, systems.data, systemsOn, client, onSettings, onReconnect]);

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
