import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, GitFork, Hash, Kanban, ListChecks, NotebookPen, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { lmContainer } from "../../documents/adapters/lmdoc";
import { useConnection, useDocsEnabled, useFolderProposalsEnabled, useWikiEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { allProposalsQuery, lmNotebooksQuery, type DocNotebook } from "../../lib/lm";
import { addNotebook, notebooksQuery, type Notebook } from "../../lib/notebooks";
import { openInbox, useApp } from "../../store";
import { toast } from "../../ui/toast";
import { ContextRail } from "../../workspace/RightSidebar";
import { useNarrow } from "../../lib/narrow";
import { hasTabs, railShown, useWorkspace } from "../../workspace/store";
import { statusQuery } from "../../lib/noteindex";
import { GraphView } from "../graph/GraphView";
import { RewriteDialog } from "../links/RewriteDialog";
import { useCurrentProject } from "../projects/useProject";
import { progressLine, useIndexState } from "../search/indexState";
import { TaxonomyView } from "../taxonomy/TaxonomyView";
import { WikiPane } from "../wiki/WikiPane";
import { Workspace } from "../../workspace/Workspace";
import { newPageHere, openPage } from "./actions";
import { NewNotebook } from "./NewNotebook";
import { NewFromTemplate } from "./DailyViews";
import { LmNotebookSettings, NotebookSettings } from "./NotebookSettings";
import { MemoryTree, useMemoryTree } from "./MemoryTree";
import { NotebookTree } from "./NotebookTree";
import { ProposalInbox } from "./ProposalInbox";
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

/** A Living Memory notebook as the tree and the tabs name it (NS-2C). */
export const asNotebook = (d: DocNotebook): Notebook => ({ id: lmContainer(d.domain, d.notebook), path: `${d.domain} · ${d.notebook}`, title: d.title, added: d.updated });

/** Living Memory notebooks by domain, domains in name order. */
export function byDomain(list: DocNotebook[]): [string, DocNotebook[]][] {
  const groups = new Map<string, DocNotebook[]>();
  for (const nb of list) groups.set(nb.domain, [...(groups.get(nb.domain) ?? []), nb]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, nbs]) => [d, nbs.sort((x, y) => x.title.localeCompare(y.title))]);
}

/** Says so while the search index is being filled, so a search that misses pages is understood. */
function IndexLine() {
  // The last event, or what the index reports now when the page opens in the middle of a scan.
  const status = useQuery(statusQuery());
  const line = progressLine(useIndexState((s) => s.progress) ?? status.data ?? null);
  return line ? <p className="muted small pad index-line" role="status">{line}</p> : null;
}

function Empty({ onAdd, onNew }: { onAdd: () => void; onNew?: () => void }) {
  return (
    <div className="center">
      <div className="card notes-intro">
        <h1><NotebookPen size="1.1em" aria-hidden /> Notebooks</h1>
        <p>A notebook is a folder of Markdown pages on your computer: a folder you already keep notes in, an Obsidian vault, or a new one.
          Hivemind shows its sections and pages, edits them in place and never moves them anywhere else.</p>
        <p className="muted">Pages stay ordinary files: other editors, git and backups keep working. Hivemind keeps its own settings for a notebook in a small <code>.hivemind</code> folder inside it.</p>
        {onNew && <p className="muted">A Living Memory notebook keeps its pages in your memory store instead, where every save is journaled and backed up.</p>}
        <div className="actions">
          <button className="primary" onClick={onAdd}><Plus size="1.1em" aria-hidden />Add a folder</button>
          {onNew && <button onClick={onNew}><Plus size="1.1em" aria-hidden />New Living Memory notebook</button>}
        </div>
      </div>
    </div>
  );
}

/** Notes: folder notebooks and Living Memory notebooks on the left, and the shared workspace (pages and notes as tabs)
 *  beside them. */
export function NotesPage() {
  const client = useQueryClient();
  const notebooks = useQuery(notebooksQuery());
  const docs = useDocsEnabled();
  const connected = useConnection((s) => s.commands.length > 0);
  const wikiOn = useWikiEnabled();
  const memory = useMemoryTree();
  const lm = useQuery({ ...lmNotebooksQuery(), enabled: docs });
  // Page edits agents proposed to folder notebooks: each notebook says how many wait, and the Inbox's Pages group decides them (CON-9).
  const edits = useQuery({ ...allProposalsQuery(), enabled: useFolderProposalsEnabled(), retry: false });
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const { project } = useCurrentProject();
  const open = useWorkspace(hasTabs);
  const narrow = useNarrow();
  const rail = useWorkspace((s) => railShown(s, narrow));
  const add = useAddNotebook();
  const [settings, setSettings] = useState<Notebook | null>(null);
  const [lmSettings, setLmSettings] = useState<DocNotebook | null>(null);
  const [inbox, setInbox] = useState<DocNotebook | null>(null);
  const [creating, setCreating] = useState(false);
  const groups = useMemo(() => byDomain(lm.data?.notebooks ?? []), [lm.data]);
  const damaged = lm.data?.damaged ?? [];

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
      {lmSettings && <LmNotebookSettings nb={lmSettings} onClose={() => setLmSettings(null)} />}
      {inbox && <ProposalInbox nb={inbox} onClose={() => setInbox(null)} />}
      {creating && <NewNotebook onClose={() => setCreating(false)} onFolder={add} />}
      <RewriteDialog />
      <NewFromTemplate />
    </>
  );
  const newNotebook = docs ? () => setCreating(true) : undefined;

  const list = notebooks.data ?? [];
  const empty = !list.length && !groups.length && !damaged.length && !memory.groups.length
    && !notebooks.isLoading && !lm.isLoading && !memory.loading;
  return (
    <div className="notes-page">
      <nav className="notebooks" aria-label="Notes and notebooks">
        <div className="notes-views" aria-label="Lists of notes and pages">
          <button type="button" className={`link-row${route.page === "notes" && route.view === "tasks" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "tasks" })}><ListChecks size="1em" aria-hidden /> Tasks</button>
          <button type="button" className={`link-row${route.page === "notes" && route.view === "views" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "views" })}><Kanban size="1em" aria-hidden /> Views</button>
          <button type="button" className={`link-row${route.page === "notes" && route.view === "tags" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "tags" })}><Hash size="1em" aria-hidden /> Tags</button>
          <button type="button" className={`link-row${route.page === "notes" && route.view === "graph" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "graph" })}><GitFork size="1em" aria-hidden /> Graph</button>
          {wikiOn && <button type="button" className={`link-row${route.page === "notes" && route.view === "wiki" ? " on" : ""}`} onClick={() => go({ page: "notes", view: "wiki" })}><BookOpen size="1em" aria-hidden /> Wiki</button>}
        </div>
        <MemoryTree tree={memory} />
        {notebooks.isLoading && <p className="muted small pad" role="status">Loading notebooks…</p>}
        {notebooks.error && <p className="error small pad">{classify(notebooks.error).message}</p>}
        {list.map((nb) => <NotebookTree key={nb.id} notebook={nb} onSettings={() => setSettings(nb)} edits={agentEdits(edits.data ?? [], nb)} onEdits={() => openInbox(undefined, undefined, "pages")} />)}
        {(groups.length > 0 || damaged.length > 0) && (
          <div className="notebook-group" aria-label="Living Memory notebooks">
            <h2>Living Memory</h2>
            {groups.map(([domain, nbs]) => (
              <div key={domain} className="notebook-group">
                <h3>{domain}</h3>
                {nbs.map((d) => (
                  <NotebookTree key={d.notebook} notebook={asNotebook(d)} lm={d} onSettings={() => setLmSettings(d)} onProposals={() => setInbox(d)} />
                ))}
              </div>
            ))}
            {/* A notebook Living Memory cannot read is said beside the others (Codex review of 32fee20, C2). */}
            {damaged.map((d) => (
              <p key={`${d.domain}:${d.notebook}`} className="error small pad">{d.domain} · {d.notebook}: {d.error}</p>
            ))}
          </div>
        )}
        {lm.error && <p className="error pad">{classify(lm.error).message}</p>}
        {connected && !docs && <p className="muted small pad">Living Memory notebooks need a newer Living Memory (with notebook pages).</p>}
        <IndexLine />
        <button className="ghost add-notebook" onClick={newNotebook ?? add}><Plus size="1.1em" aria-hidden />{docs ? "New notebook" : "Add a notebook"}</button>
      </nav>
      {route.page === "notes" && route.view
        ? (
          <div className={`notes-lists${route.view === "graph" ? " notes-graph" : ""}`}>
            {route.view === "tasks" ? <TasksView />
              : route.view === "views" ? <ViewsPage />
              : route.view === "tags" ? <TaxonomyView />
              : route.view === "wiki" ? <WikiPane />
              : route.view === "graph" ? <GraphView key={project?.tag ?? ""} projectTag={project?.tag} projectName={project?.name} />
              : null}
          </div>
        )
        : open
        ? <div className={`notes-area${narrow ? " narrow" : ""}`}><Workspace />{rail && <ContextRail />}</div>
        : empty ? <Empty onAdd={add} onNew={newNotebook} />
        : (
          <div className="center muted">
            {list.length > 0 || groups.length > 0
              ? <p>Pick a note or page on the left, or <button className="link" onClick={() => newPageHere(client)}>create a page</button> (<kbd>Ctrl</kbd>+<kbd>N</kbd>).</p>
              : <p>Pick a memory note on the left, <button className="link" onClick={() => useWorkspace.getState().openTab({ kind: "new-note" })}>capture a new note</button>, or <button className="link" onClick={newNotebook ?? add}>add a notebook</button>.</p>}
          </div>
        )}
      {dialogs}
    </div>
  );
}
