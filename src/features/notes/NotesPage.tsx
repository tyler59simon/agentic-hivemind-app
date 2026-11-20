import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NotebookPen, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { classify } from "../../lib/errors";
import { addNotebook, notebooksQuery, type Notebook } from "../../lib/notebooks";
import { useApp } from "../../store";
import { toast } from "../../ui/toast";
import { ContextRail } from "../../workspace/RightSidebar";
import { hasTabs, railShown, useWorkspace } from "../../workspace/store";
import { Workspace } from "../../workspace/Workspace";
import { newPageHere, openPage } from "./actions";
import { NotebookSettings } from "./NotebookSettings";
import { NotebookTree } from "./NotebookTree";

/** Add a notebook through the native folder dialog. */
export function useAddNotebook() {
  const client = useQueryClient();
  return async () => {
    try {
      const nb = await addNotebook();
      if (!nb) return;
      client.invalidateQueries({ queryKey: ["notebooks"] });
      toast(`Added ${nb.title}.`);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="center">
      <div className="card notes-intro">
        <h1><NotebookPen size="1.1em" aria-hidden /> Notebooks</h1>
        <p>A notebook is a folder of Markdown pages on your computer: a folder you already keep notes in, an Obsidian vault, or a new one.
          Hivemind shows its sections and pages, edits them in place and never moves them anywhere else.</p>
        <p className="muted">Pages stay ordinary files: other editors, git and backups keep working. Hivemind keeps its own settings for a notebook in a small <code>.hivemind</code> folder inside it.</p>
        <div className="actions"><button className="primary" onClick={onAdd}><Plus size="1.1em" aria-hidden />Add a notebook</button></div>
      </div>
    </div>
  );
}

/** Notes: registered notebooks on the left, and the shared workspace (pages and notes as tabs) beside them. */
export function NotesPage() {
  const client = useQueryClient();
  const notebooks = useQuery(notebooksQuery());
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const open = useWorkspace(hasTabs);
  const rail = useWorkspace(railShown);
  const add = useAddNotebook();
  const [settings, setSettings] = useState<Notebook | null>(null);

  // A route naming a page (from the palette or a link) opens it, then settles back on the plain Notes route.
  const target = route.page === "notes" && route.notebook && route.path ? { notebook: route.notebook, path: route.path } : null;
  useEffect(() => {
    if (!target) return;
    openPage(target);
    go({ page: "notes" });
  }, [target?.notebook, target?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (notebooks.isLoading) return <div className="center muted">Loading notebooks…</div>;
  if (notebooks.error) return <div className="center error">{classify(notebooks.error).message}</div>;
  const list = notebooks.data ?? [];
  // Open tabs (a Memory note opened with Ctrl+O, pages of a notebook just removed) stay visible without notebooks
  // (Codex review of 32fd236, M1).
  if (!list.length && !open) return <Empty onAdd={add} />;
  return (
    <div className="notes-page">
      <nav className="notebooks" aria-label="Notebooks">
        {list.map((nb) => <NotebookTree key={nb.id} notebook={nb} onSettings={() => setSettings(nb)} />)}
        <button className="ghost add-notebook" onClick={add}><Plus size="1.1em" aria-hidden />Add a notebook</button>
      </nav>
      {open
        ? <div className="notes-area"><Workspace />{rail && <ContextRail />}</div>
        : (
          <div className="center muted">
            <p>Pick a page on the left, or <button className="link" onClick={() => newPageHere(client)}>create a page</button> (<kbd>Ctrl</kbd>+<kbd>N</kbd>).</p>
          </div>
        )}
      {settings && <NotebookSettings notebook={settings} onClose={() => setSettings(null)} />}
    </div>
  );
}
