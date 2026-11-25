import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, GitFork, Hash, Kanban, ListChecks, NotebookPen, Plus, Sparkles, Users } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { useFolderProposalsEnabled, useWikiEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { allProposalsQuery } from "../../lib/lm";
import { addNotebook, notebooksQuery, type Notebook } from "../../lib/notebooks";
import { openInbox, useApp } from "../../store";
import { toast } from "../../ui/toast";
import { ContextRail } from "../../workspace/RightSidebar";
import { RailFocusGuard, RailSplitter, TreeSplitter } from "../../shell/RegionSplitters";
import { useBudget } from "../../shell/useBudget";
import { hasTabs, railShown, useWorkspace } from "../../workspace/store";
import { statusQuery } from "../../lib/noteindex";
import { GraphView } from "../graph/GraphView";
import { RewriteDialog } from "../links/RewriteDialog";
import { useCurrentProject } from "../projects/useProject";
import { progressLine, useIndexState } from "../search/indexState";
import { TaxonomyView } from "../taxonomy/TaxonomyView";
import { PeoplePane } from "../people/PeoplePane";
import { SkillsPane } from "../skills/SkillsPane";
import { WikiPane } from "../wiki/WikiPane";
import { Workspace } from "../../workspace/Workspace";
import { newPageHere, openPage } from "./actions";
import { NewFromTemplate } from "./DailyViews";
import { NotebookSettings } from "./NotebookSettings";
import { MemoryTree, useMemoryTree } from "./MemoryTree";
import { NotebookTree } from "./NotebookTree";
import { agentEdits, announceAdded } from "./reach";
import { TasksView } from "./TasksView";
import { ViewsPage } from "./ViewsPage";

/** Add a folder notebook through the native folder dialog; Living Memory registers it for agent search (NS-2C). */
export function useAddNotebook() {
  const client = useQueryClient();
  return async () => {
    try {
      const nb = await addNotebook();
      if (nb) await announceAdded(client, nb);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };
}

/** Says so while the search index is being filled, so a search that misses pages is understood. */
function IndexLine() {
  // The last event, or what the index reports now when the page opens in the middle of a scan.
  const status = useQuery(statusQuery());
  const line = progressLine(useIndexState((s) => s.progress) ?? status.data ?? null);
  return line ? <p className="muted small pad index-line" role="status">{line}</p> : null;
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="center">
      <div className="card notes-intro">
        <h1><NotebookPen size="1.1em" aria-hidden /> Notebooks</h1>
        <p>A notebook is a folder of Markdown pages on your computer: a folder you already keep notes in, an Obsidian vault, or a new one.
          Hivemind shows its sections and pages, edits them in place and never moves them anywhere else.</p>
        <p className="muted">Pages stay ordinary files: other editors, git and backups keep working. Hivemind keeps its own settings for a notebook in a small <code>.hivemind</code> folder inside it.</p>
        <div className="actions">
          <button className="primary" onClick={onAdd}><Plus size="1.1em" aria-hidden />Add a folder</button>
        </div>
      </div>
    </div>
  );
}

/** Notes: folder notebooks and memory notes on the left, and the shared workspace (pages and notes as tabs) beside them. */
export function NotesPage() {
  const client = useQueryClient();
  const notebooks = useQuery(notebooksQuery());
  const wikiOn = useWikiEnabled();
  const memory = useMemoryTree();
  // Page edits agents proposed to folder notebooks: each notebook says how many wait, and the Inbox's Pages group decides them (CON-9).
  const edits = useQuery({ ...allProposalsQuery(), enabled: useFolderProposalsEnabled(), retry: false });
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const { project } = useCurrentProject();
  const open = useWorkspace(hasTabs);
  // The rail lies over the note in a narrow window and when there is no room beside it; the widths are what fits (src/shell/budget.ts).
  const budget = useBudget();
  const narrow = budget.overlay;
  const rail = useWorkspace((s) => railShown(s, narrow));
  const add = useAddNotebook();
  const [settings, setSettings] = useState<Notebook | null>(null);

  // A route naming a page (from the palette or a link) opens it, then settles back on the plain Notes route.
  const target = route.page === "notes" && route.notebook && route.path ? { notebook: route.notebook, path: route.path } : null;
  useEffect(() => {
    if (!target) return;
    openPage(target);
    go({ page: "notes" }, { replace: true });
  }, [target?.notebook, target?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const dialogs = (
    <>
      {settings && <NotebookSettings notebook={settings} onClose={() => setSettings(null)} />}
      <RewriteDialog />
      <NewFromTemplate />
    </>
  );

  const list = notebooks.data ?? [];
  const empty = !list.length && !memory.groups.length && !notebooks.isLoading && !memory.loading;
  return (
    <div className="notes-page" style={{ "--tree-w": `${budget.tree}rem` } as CSSProperties}>
      <nav className="notebooks" id="notes-tree" aria-label="Notes and notebooks">
        <div className="notes-views" role="group" aria-label="Lists of notes and pages">
          <button type="button" className={`link-row${route.page === "notes" && route.view === "tasks" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "tasks" })}><ListChecks size="1em" aria-hidden /> Tasks</button>
          <button type="button" className={`link-row${route.page === "notes" && route.view === "views" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "views" })}><Kanban size="1em" aria-hidden /> Views</button>
          <button type="button" className={`link-row${route.page === "notes" && route.view === "tags" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "tags" })}><Hash size="1em" aria-hidden /> Tags</button>
          <button type="button" className={`link-row${route.page === "notes" && route.view === "graph" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "graph" })}><GitFork size="1em" aria-hidden /> Graph</button>
          {wikiOn && <button type="button" className={`link-row${route.page === "notes" && route.view === "wiki" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "wiki" })}><BookOpen size="1em" aria-hidden /> Wiki</button>}
          <button type="button" className={`link-row${route.page === "notes" && route.view === "skills" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "skills" })}><Sparkles size="1em" aria-hidden /> Skills</button>
          <button type="button" className={`link-row${route.page === "notes" && route.view === "people" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "people" })}><Users size="1em" aria-hidden /> People</button>
        </div>
        <MemoryTree tree={memory} />
        {notebooks.isLoading && <p className="muted small pad" role="status">Loading notebooks…</p>}
        {notebooks.error && <p className="error small pad">{classify(notebooks.error).message}</p>}
        {list.map((nb) => <NotebookTree key={nb.id} notebook={nb} onSettings={() => setSettings(nb)} edits={agentEdits(edits.data ?? [], nb)} onEdits={() => openInbox(undefined, undefined, "pages")} />)}
        <IndexLine />
        <button className="ghost add-notebook" onClick={add}><Plus size="1.1em" aria-hidden />Add a notebook</button>
      </nav>
      <TreeSplitter />
      {route.page === "notes" && route.view
        ? (
          <div className={`notes-lists${route.view === "graph" ? " notes-graph" : route.view === "skills" ? " notes-skills" : route.view === "people" ? " notes-people" : ""}`}>
            {route.view === "tasks" ? <TasksView />
              : route.view === "views" ? <ViewsPage />
              : route.view === "tags" ? <TaxonomyView />
              : route.view === "wiki" ? <WikiPane />
              : route.view === "skills" ? <SkillsPane />
              : route.view === "people" ? <PeoplePane onAdd={add} />
              : route.view === "graph" ? <GraphView key={project?.tag ?? ""} projectTag={project?.tag} projectName={project?.name} />
              : null}
          </div>
        )
        : open
        ? <div className={`notes-area${narrow ? " narrow" : ""}`} style={{ "--rail-w": `${budget.rail}rem` } as CSSProperties}>
          <Workspace />{rail && <><RailFocusGuard /><RailSplitter /><ContextRail /></>}
        </div>
        : empty ? <Empty onAdd={add} />
        : (
          <div className="center muted">
            {list.length > 0
              ? <p>Pick a note or page on the left, or <button className="link" onClick={() => newPageHere(client)}>create a page</button> (<kbd>Ctrl</kbd>+<kbd>N</kbd>).</p>
              : <p>Pick a memory note on the left, <button className="link" onClick={() => useWorkspace.getState().openTab({ kind: "new-note" })}>capture a new note</button>, or <button className="link" onClick={add}>add a notebook</button>.</p>}
          </div>
        )}
      {dialogs}
    </div>
  );
}
