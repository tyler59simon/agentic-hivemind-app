import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { parentFolder } from "../../lib/platform";
import { useLayer } from "../../ui/layers";
import { zoomBy } from "../../lib/zoom";
import { format, useShortcutVersion } from "../../lib/shortcuts";
import { useShortcutsDialog } from "../shortcuts/ShortcutsDialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMaintenanceEnabled, useProjectsEnabled, useSystemsEnabled, useWikiEnabled } from "../../lib/connection";
import { copyDiagnostics, openLogsFolder } from "../../lib/diagnostics";
import { domains, list } from "../../lib/lm";
import { folderOf, notebooksQuery, pageTitle, treeQuery } from "../../lib/notebooks";
import { pagesQuery } from "../../lib/noteindex";
import { recentQuery, recentRef } from "../../lib/opens";
import { openFromDisk } from "../notes/opening";
import { currentNotebook, firstNotebook, newPageHere, openPage } from "../notes/actions";
import { openToday } from "../notes/dailyActions";
import { useTemplateIntent } from "../notes/DailyViews";
import { useAddNotebook } from "../notes/NotesPage";
import { refreshStore } from "../../lib/refresh";
import { fuzzy } from "../../lib/text";
import { classify } from "../../lib/errors";
import { useHidden } from "../../shell/hidden";
import { leaveFocusMode, toggleFocusMode, toggleFullscreen, toggleRail, toggleSidebar, useLayout } from "../../shell/layout";
import { useBudget } from "../../shell/useBudget";
import { toast } from "../../ui/toast";
import { openProject, openSettings, openSystem, useApp, type Page, type Route } from "../../store";
import { activeTab, railShown, useWorkspace } from "../../workspace/store";
import { useComparePicker } from "../power/ComparePicker";
import { openFindInFiles } from "../search/FindInFiles";
import { useNotesSearch } from "../search/store";
import { LINE_TOOLS } from "../power/lineTools";
import { playMacro, toggleRecording, useRecorder, type Target } from "../power/macros";
import { toolRunner } from "../power/PowerBar";
import { editorOf } from "../power/registry";
import { useProjectIntent } from "../projects/intent";
import { projectsQuery } from "../projects/useProject";
import { systemsQuery, useSystemIntent } from "../systems/useSystem";

/** `section`: the sidebar section this entry goes to; hiding the section drops the entry. */
interface Entry { key: string; label: string; detail?: string; section?: Page; run: () => void }

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
  const wikiOn = useWikiEnabled();
  const maintenanceOn = useMaintenanceEnabled();
  const hidden = useHidden((s) => s.hidden);
  const systems = useQuery({ ...systemsQuery(), enabled: systemsOn && app.palette === "commands" });
  const notebooks = useQuery({ ...notebooksQuery(), enabled: app.palette === "notes" });
  // Every indexed page of every notebook (NS-4A). The notebook trees stand in only when the index cannot answer.
  const indexed = useQuery({ ...pagesQuery(), enabled: app.palette === "notes" });
  const trees = useQueries({ queries: (notebooks.data ?? []).map((nb) => ({ ...treeQuery(nb.id), enabled: app.palette === "notes" && indexed.isError })) });
  const recent = useQuery({ ...recentQuery(), enabled: app.palette === "notes" });
  const addNotebook = useAddNotebook();
  const collapsed = useLayout((s) => s.sidebarCollapsed);
  const focusMode = useLayout((s) => s.focusMode);
  const overlay = useBudget().overlay;
  const keys = useShortcutVersion(); // the entries show the keys as they are now
  useEffect(() => { setQuery(""); setIndex(0); }, [app.palette]);
  // What had the focus before the palette opened, for the sheet it may open: the palette's own controls are gone by then.
  const before = useRef<Element | null>(null);
  useEffect(() => useApp.subscribe((s, prev) => { if (s.palette && !prev.palette) before.current = document.activeElement; }), []);
  /** Run `act` for the notebook of the focused page, else the first notebook; says so when there is none. */
  const onNotebook = async (act: (notebook: string, folder: string) => unknown) => {
    const { notebook, folder } = currentNotebook(await firstNotebook(client));
    if (!notebook) { toast("Add a notebook first: the Notes page lists them.", "warn"); return; }
    try { await act(notebook, folder); } catch (e) { toast(classify(e).message, "error"); }
  };

  const entries = useMemo<Entry[]>(() => {
    if (app.palette === "notes") {
      const found: Entry[] = (notes.data?.notes ?? []).map((n) => ({
        key: n.ref, label: n.title, detail: `${n.domain} · ${n.type}`,
        run: () => { app.setDomain(n.domain); app.setPalette(null); ws.openNote(n.ref, { title: n.title }); },
      }));
      // Every page of every notebook too, with its notebook and folder as the detail.
      const names = new Map((notebooks.data ?? []).map((nb) => [nb.id, nb.title]));
      const entry = (notebook: string, path: string) => ({
        key: `${notebook}:${path}`, label: pageTitle(path), detail: [names.get(notebook), folderOf(path)].filter(Boolean).join(" · "),
        run: () => { app.setPalette(null); openPage({ notebook, path }); },
      });
      const pages = indexed.data
        ? indexed.data.filter((p) => names.has(p.notebook)).map((p) => entry(p.notebook, p.path))
        : (notebooks.data ?? []).flatMap((nb, i) => (trees[i]?.data?.entries ?? []).filter((e) => e.kind === "page").map((e) => entry(nb.id, e.path)));
      // Files opened from outside a notebook, newest first (NS-1B).
      const files = (recent.data ?? []).filter((r) => r.exists).map((r) => ({
        key: `recent:${r.id}`, label: r.name, detail: `${parentFolder(r.path)} · recent file`,
        run: () => { app.setPalette(null); openPage(recentRef(r)); },
      }));
      // The newest few lead, so an empty query shows them; ties keep this order.
      return [...files.slice(0, 8), ...found, ...pages, ...files.slice(8)];
    }
    const close = () => app.setPalette(null);
    const page = (route: Route) => () => { close(); app.go(route); };
    // Line tools and macros act on the editor of the focused file tab, when it shows source (NS-6A).
    const tab = activeTab(ws);
    const editor = tab?.kind === "file" ? editorOf(tab.id) : undefined;
    const runTool = toolRunner(() => editor ?? null);
    const macro = useRecorder.getState();
    const power: Entry[] = editor ? [
      ...LINE_TOOLS.map((t) => ({ key: `line:${t.id}`, label: `Lines: ${t.label}`, run: () => { close(); runTool(t); } })),
      { key: "macro-record", label: macro.recording ? "Macro: stop recording" : "Macro: record", detail: format("editor.macro-record"), run: () => { close(); toggleRecording(); editor.focus(); } },
      { key: "macro-play", label: "Macro: play the last one", detail: format("editor.macro-play"), run: () => { close(); void playMacro(editor as unknown as Target, macro.steps, 1); editor.focus(); } },
      { key: "macro-end", label: "Macro: play to the end of the file", run: () => { close(); void playMacro(editor as unknown as Target, macro.steps, "end"); editor.focus(); } },
    ] : [];
    const all: Entry[] = [
      { key: "go", label: "Go to note…", detail: format("palette.notes"), run: () => app.setPalette("notes") },
      { key: "new", label: "New note", detail: format("note.new"), run: () => { close(); ws.openTab({ kind: "new-note" }); } },
      { key: "open-file", label: "Open file…", run: () => { close(); void openFromDisk(); } },
      { key: "new-file", label: "New text file", run: () => { close(); ws.openTab({ kind: "new-file" }); } },
      { key: "compare", label: "Compare files…", run: () => { close(); useComparePicker.getState().show(tab?.kind === "file" ? tab.file : undefined); } },
      { key: "find-in-files", label: "Find in files…", detail: "search and replace across a notebook", run: () => { close(); openFindInFiles(); } },
      { key: "zoom-in", label: "Zoom in", detail: format("zoom.in"), run: () => { close(); void zoomBy("in"); } },
      { key: "zoom-out", label: "Zoom out", detail: format("zoom.out"), run: () => { close(); void zoomBy("out"); } },
      { key: "zoom-reset", label: "Reset zoom", detail: format("zoom.reset"), run: () => { close(); void zoomBy("reset"); } },
      { key: "sidebar", label: collapsed ? "Expand the sidebar" : "Collapse the sidebar", detail: format("sidebar.toggle"), run: () => { close(); toggleSidebar(); } },
      { key: "focus", label: focusMode ? "Exit focus mode" : "Focus mode", detail: format("focus.toggle"), run: () => { close(); toggleFocusMode(); } },
      { key: "fullscreen", label: "Full screen", detail: format("fullscreen.toggle"), run: () => { close(); void toggleFullscreen(); } },
      ...power,
      { key: "home", label: "Home", run: page({ page: "home" }) },
      { key: "notes", label: "Notes", section: "notes" as Page, run: page({ page: "notes" }) },
      { key: "new-page", label: "New page", detail: `${format("note.new")} on Notes`, section: "notes" as Page, run: () => { close(); void newPageHere(client); } },
      { key: "tasks", label: "Tasks", detail: "every task in your notebooks", section: "notes" as Page, run: page({ page: "notes", view: "tasks" }) },
      { key: "views", label: "Views", detail: "saved queries over page properties", section: "notes" as Page, run: page({ page: "notes", view: "views" }) },
      { key: "tags", label: "Tags", detail: "tags across notes and pages, and taxonomy", section: "notes" as Page, run: page({ page: "notes", view: "tags" }) },
      { key: "graph", label: "Open the graph", detail: format("graph.open"), section: "notes" as Page, run: page({ page: "notes", view: "graph" }) },
      { key: "today", label: "Today", detail: "open today's daily page", section: "notes" as Page, run: () => { close(); void onNotebook((notebook) => openToday(client, notebook)); } },
      { key: "new-from-template", label: "New page from template…", section: "notes" as Page, run: () => { close(); void onNotebook((notebook, folder) => { useTemplateIntent.getState().open(notebook, folder); app.go({ page: "notes" }); }); } },
      { key: "add-notebook", label: "Add a notebook…", section: "notes" as Page, run: () => { close(); void addNotebook(); } },
      { key: "people", label: "People", detail: "stakeholders and the tasks they own", section: "notes" as Page, run: page({ page: "notes", view: "people" }) },
      { key: "skills", label: "Skills", detail: "procedures learned from approved work", section: "notes" as Page, run: page({ page: "notes", view: "skills" }) },
      { key: "inbox", label: "Inbox", section: "inbox" as Page, run: page({ page: "inbox" }) },
      ...(wikiOn ? [{ key: "wiki", label: "Wiki", detail: "the picked project's memory as a wiki", section: "notes" as Page, run: page({ page: "notes", view: "wiki" }) }] : []),
      ...(projectsOn ? [
        { key: "new-project", label: "New project…", run: () => { close(); useProjectIntent.getState().openWizard(); } },
        { key: "new-session", label: "Start an agent session", run: page({ page: "agents", view: "new" }) },
        { key: "project:*", label: "Switch project: All memory", run: () => { close(); openProject(null); } },
        ...(registry.data?.projects ?? []).filter((p) => p.status === "active").map((p) => ({
          key: "project:" + p.slug, label: `Switch project: ${p.name}`, detail: p.tag,
          run: () => { close(); openProject(p.slug); },
        })),
      ] : []),
      ...(systemsOn ? [
        { key: "architecture", label: "Architecture", run: page({ page: "home", tab: "architecture" }) },
        { key: "new-system", label: "New system…", run: () => { close(); app.go({ page: "home", tab: "architecture" }); useSystemIntent.getState().openWizard(); } },
        { key: "sessions", label: "Agents (sessions)", section: "agents" as Page, run: page({ page: "agents" }) },
        ...(systems.data?.systems ?? []).filter((s) => s.status !== "retired").map((s) => ({
          key: "system:" + s.slug, label: `Open system: ${s.name}`, detail: s.tag,
          run: () => { close(); openSystem(s.slug); },
        })),
      ] : []),
      ...EXTRA_COMMANDS.map((c) => ({ ...c, run: () => { close(); c.run(); } })),
      { key: "split", label: "Open the note side by side", detail: format("view.split"), run: () => { ws.split(); close(); } },
      { key: "rail", label: railShown(ws, overlay) && !focusMode ? "Hide the note's context rail" : "Show the note's context rail", run: () => { toggleRail(overlay); close(); } },
      { key: "search", label: "Search notes and pages", detail: format("search.focus"), run: () => { close(); leaveFocusMode(); useNotesSearch.getState().focus(); } },
      { key: "active", label: "Search active notes", run: () => { close(); leaveFocusMode(); useNotesSearch.getState().byStatus("active"); } },
      { key: "archive", label: "Search the archive", run: () => { close(); leaveFocusMode(); useNotesSearch.getState().byStatus("archived"); } },
      { key: "back", label: "Back", detail: format("nav.back"), run: () => { close(); app.goBack(); } },
      { key: "refresh", label: "Refresh", run: () => { refreshStore(client); close(); } },
      { key: "reconnect", label: "Reconnect to Living Memory", run: () => { onReconnect(); close(); } },
      { key: "settings", label: "Settings", run: () => { onSettings(); close(); } },
      { key: "shortcuts", label: "Keyboard shortcuts", detail: format("shortcuts.show"), run: () => { close(); useShortcutsDialog.getState().show(before.current); } },
      { key: "schedules", label: "Schedules", detail: "Settings: briefings, maintenance, rebuilds and automations", run: () => { close(); openSettings("schedules"); } },
      { key: "spend", label: "Spend", detail: "Settings: budgets and today's spending", run: () => { close(); openSettings("spend"); } },
      { key: "copy-diagnostics", label: "Copy diagnostics", detail: "version, settings summary and the end of the log; no note text", run: () => { close(); void copyDiagnostics(); } },
      { key: "open-logs", label: "Open logs folder", run: () => { close(); void openLogsFolder(); } },
      ...(maintenanceOn ? [{ key: "maintenance", label: "Maintenance", detail: "Settings: automatic note review", run: () => { close(); openSettings("maintenance"); } }] : []),
      ...(known.data?.domains ?? []).map((d) => ({
        key: "domain:" + d.name, label: `Switch domain: ${d.name}`, detail: `${d.active} notes`,
        run: () => { app.setDomain(d.name); close(); },
      })),
    ];
    return all.filter((e) => !e.section || !hidden.includes(e.section));
  }, [app, ws, notes.data, known.data, registry.data, projectsOn, systems.data, systemsOn, wikiOn, maintenanceOn, hidden, client, onSettings, onReconnect, notebooks.data, trees, indexed.data, addNotebook, recent.data, keys, collapsed, focusMode, overlay]);

  const shown = useMemo(() => {
    const best = entries
      .map((e) => ({ e, score: fuzzy(query, e.label) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => (b.score! - a.score!))
      .slice(0, 50)
      .map((x) => x.e);
    // Ctrl+O always ends with the way to any file on disk (NS-1B).
    if (app.palette !== "notes") return best;
    return [...best, { key: "open-from-disk", label: "Open file from disk…", detail: "any file", run: () => { app.setPalette(null); void openFromDisk(); } }];
  }, [entries, query, app]);

  // Escape closes the palette, and only the palette when it is open over a dialog (DESK-4).
  useLayer(!!app.palette, () => app.setPalette(null));
  if (!app.palette) return null;
  const choose = (entry?: Entry) => entry?.run();
  return (
    <div className="overlay" onMouseDown={() => app.setPalette(null)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Palette">
        <input autoFocus value={query} placeholder={app.palette === "notes" ? "Go to note or page…" : "Run a command…"}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, shown.length - 1)); }
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
