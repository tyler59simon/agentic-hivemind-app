import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NotebookPen, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { lmContainer } from "../../documents/adapters/lmdoc";
import { useConnection, useDocsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { lmNotebooksQuery, type DocNotebook } from "../../lib/lm";
import { addNotebook, notebooksQuery, type Notebook } from "../../lib/notebooks";
import { useApp } from "../../store";
import { toast } from "../../ui/toast";
import { ContextRail } from "../../workspace/RightSidebar";
import { hasTabs, railShown, useWorkspace } from "../../workspace/store";
import { statusQuery } from "../../lib/noteindex";
import { RewriteDialog } from "../links/RewriteDialog";
import { progressLine, useIndexState } from "../search/indexState";
import { Workspace } from "../../workspace/Workspace";
import { newPageHere, openPage } from "./actions";
import { NewNotebook } from "./NewNotebook";
import { NewFromTemplate } from "./DailyViews";
import { LmNotebookSettings, NotebookSettings } from "./NotebookSettings";
import { NotebookTree } from "./NotebookTree";
import { ProposalInbox } from "./ProposalInbox";
import { announceAdded } from "./reach";
import { TagsPane } from "./TagsPane";

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
  const lm = useQuery({ ...lmNotebooksQuery(), enabled: docs });
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const open = useWorkspace(hasTabs);
  const rail = useWorkspace(railShown);
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
    go({ page: "notes" });
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

  if (notebooks.isLoading) return <div className="center muted">Loading notebooks…</div>;
  if (notebooks.error) return <div className="center error">{classify(notebooks.error).message}</div>;
  const list = notebooks.data ?? [];
  // Open tabs (a Memory note opened with Ctrl+O, pages of a notebook just removed) stay visible without notebooks
  // (Codex review of 32fd236, M1).
  if (!list.length && !groups.length && !damaged.length && !open && !lm.isLoading) return <><Empty onAdd={add} onNew={newNotebook} />{dialogs}</>;
  return (
    <div className="notes-page">
      <nav className="notebooks" aria-label="Notebooks">
        {list.map((nb) => <NotebookTree key={nb.id} notebook={nb} onSettings={() => setSettings(nb)} />)}
        <TagsPane />
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
      {open
        ? <div className="notes-area"><Workspace />{rail && <ContextRail />}</div>
        : (
          <div className="center muted">
            <p>Pick a page on the left, or <button className="link" onClick={() => newPageHere(client)}>create a page</button> (<kbd>Ctrl</kbd>+<kbd>N</kbd>).</p>
          </div>
        )}
      {dialogs}
    </div>
  );
}
