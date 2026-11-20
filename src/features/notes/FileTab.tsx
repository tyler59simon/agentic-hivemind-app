import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { convertToUtf8, edit, isDeleting, keyOf, open, reload, resolveMerge, save, useDocuments } from "../../documents/store";
import { isUnsaved, mergeable, type DocState } from "../../documents/session";
import { classify } from "../../lib/errors";
import { createFile, fileName, folderOf, isMarkdown, notebooksQuery, pageTitle, revealFile, treeQuery, type Notebook } from "../../lib/notebooks";
import { assetBase, isLoose, recentQuery, recentRef, saveAs } from "../../lib/opens";
import { Menu } from "../../ui/Menu";
import { Confirm, Modal } from "../../ui/Modal";
import { Tabs } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace, type Mode, type Tab } from "../../workspace/store";
import { CodeEditor } from "../editor/CodeEditor";
import { PageMergeDialog } from "../editor/MergeDialog";
import { resolvePage } from "../links/resolve";
import { movePath, openPage, renamed, trashPath } from "./actions";
import { DeleteConfirm } from "./DeleteConfirm";
import { forgetRecent } from "./opening";
import { PageView } from "./PageView";

const MODES: { id: Mode; label: string }[] = [{ id: "reading", label: "Reading" }, { id: "live", label: "Live" }, { id: "source", label: "Source" }];

/** The pages of the tab's notebook, for `[[link]]` completion and resolution. */
function usePages(notebook: string) {
  const tree = useQuery({ ...treeQuery(notebook), enabled: !isLoose({ notebook }) });
  return useMemo(() => (tree.data?.entries ?? []).filter((e) => e.kind !== "dir").map((e) => e.path), [tree.data]);
}

/** Follow a `[[link]]` from a page: open it, offer to create it, or let the user pick between pages of the same name. */
function useFollow(tab: Tab, pages: string[], ask: (node: ReactNode) => void) {
  const client = useQueryClient();
  const from = tab.file!;
  return useCallback((target: string, split: boolean) => {
    const hit = resolvePage(target, from, pages);
    if ("ref" in hit) return openPage(hit.ref, { split });
    if ("ambiguous" in hit) {
      return ask(
        <Modal title="Several pages have this name" onClose={() => ask(null)}>
          <ul className="plain-list">
            {hit.ambiguous.map((r) => <li key={r.path}><button className="link" onClick={() => { ask(null); openPage(r, { split }); }}>{r.path}</button></li>)}
          </ul>
        </Modal>,
      );
    }
    ask(
      <Confirm title="Create this page?" action="Create page" message={<p>No page called <b>{target}</b> exists yet. Create <code>{hit.missing}</code>?</p>}
        onAnswer={(yes) => {
          ask(null);
          if (!yes) return;
          createFile(from.notebook, hit.missing, "").then(() => {
            client.invalidateQueries({ queryKey: ["notebook-tree", from.notebook] });
            openPage({ notebook: from.notebook, path: hit.missing }, { split });
          }, (e) => toast(classify(e).message, "error"));
        }} />,
    );
  }, [from, pages, ask, client]);
}

/** Save a page and say when it needs a merge first; Ctrl+S in any mode of a page tab comes here. */
export async function saveFileTab(key: string) {
  const after = await save(key);
  if (after?.status === "stale") toast("This page changed on disk. Merge your edits to save them.", "warn");
}

/** Drop unsaved edits and show the file; typing while it reads keeps the edits instead. */
function reloadPage(key: string) {
  void reload(key).then((done) => { if (!done && useDocuments.getState().docs[key]?.status !== "error") toast("Reload stopped: you typed while the file was read, so your edits stay.", "warn"); });
}

/** Open the file with the program Windows associates with it. */
const openOutside = (ref: { notebook: string; path: string }) => revealFile(ref.notebook, ref.path, true).catch((e) => toast(classify(e).message, "error"));

/** Save the text of a page that cannot be written in place as a new UTF-8 file, and open that file. */
async function saveCopy(text: string, name: string) {
  try {
    const ref = await saveAs(text, name);
    if (ref) openPage(ref);
  } catch (e) {
    toast(classify(e).message, "error");
  }
}

function Banners({ doc, docKey, onMerge, onRecreate }: { doc: DocState; docKey: string; onMerge: () => void; onRecreate: () => void }) {
  const ref = useDocuments((s) => s.refs[docKey]);
  const dismiss = () => useDocuments.getState().dispatch(docKey, { type: "dismiss" });
  useEffect(() => {
    if (doc.banner?.kind !== "followed") return;
    const t = setTimeout(dismiss, 4000);
    return () => clearTimeout(t);
  }, [doc.banner]); // eslint-disable-line react-hooks/exhaustive-deps
  const out: ReactNode[] = [];
  if (doc.status === "readOnly" && doc.base) {
    out.push(
      <div key="ro" className="banner note-banner">{doc.base.binary ? "This is not a text file, so it opens read-only." : `Read-only: ${doc.base.readOnly}.`}
        <div className="actions">
          {doc.base.convertible && <button onClick={() => convertToUtf8(docKey)}>Convert to UTF-8 and edit</button>}
          {/* Binary files open in their own program until NS-6B's viewer; text Hivemind may not write can be saved elsewhere. */}
          {doc.base.binary && ref && <button onClick={() => void openOutside(ref)}>Open with default app</button>}
          {!doc.base.binary && !doc.base.convertible && ref && <button onClick={() => void saveCopy(doc.text, fileName(ref.path))}>Save a copy as…</button>}
        </div>
      </div>,
    );
  }
  if (doc.convert && isUnsaved(doc)) {
    const lossy = doc.base?.convertible ? " Bytes that did not decode are saved as �." : "";
    out.push(<div key="convert" className="banner note-banner">Saving writes this file as UTF-8.{lossy}</div>);
  }
  if ((doc.status === "stale" || doc.banner?.kind === "changed") && !mergeable(doc.theirs)) {
    // Nothing to merge into: the file is no longer text Hivemind can edit (Codex review of 32fd236, D3).
    const why = doc.theirs?.binary ? "is no longer a text file" : `can no longer be edited here (${doc.theirs?.readOnly ?? "unknown reason"})`;
    out.push(
      <div key="changed" className="banner warn note-banner">
        This page changed on disk and {why}, so your edits cannot be merged into it. They are kept here and as a draft; copy them out, or reload to see the file.
        <div className="actions"><button onClick={() => reloadPage(docKey)}>Reload (drop my edits)</button></div>
      </div>,
    );
  } else if (doc.status === "stale" || doc.banner?.kind === "changed") {
    out.push(
      <div key="changed" className="banner warn note-banner">
        {doc.status === "stale" ? "Not saved: this page changed on disk after you opened it." : "This page changed on disk while you were editing."}
        <div className="actions"><button className="primary" onClick={onMerge}>Merge</button><button onClick={() => reloadPage(docKey)}>Reload (drop my edits)</button></div>
      </div>,
    );
  }
  if (doc.draftError && isUnsaved(doc)) {
    out.push(<div key="draft" className="banner error note-banner">Your unsaved edits are not backed up as a draft ({doc.draftError}). Save the page to keep them.</div>);
  }
  if (doc.banner?.kind === "restored") {
    out.push(
      <div key="restored" className="banner note-banner">Restored unsaved edits from a draft (kept {new Date(doc.banner.at).toLocaleString()}).
        <div className="actions"><button onClick={dismiss}>Keep</button><button onClick={() => reloadPage(docKey)}>Discard them</button></div>
      </div>,
    );
  }
  if (doc.banner?.kind === "followed") out.push(<div key="followed" className="banner note-banner fade">Saved by another program; your copy was updated.</div>);
  if (doc.banner?.kind === "gone") {
    out.push(
      <div key="gone" className="banner warn note-banner">This page was deleted or moved by another program. Your text is still here.
        <div className="actions">
          {ref && isLoose(ref)
            ? <button className="primary" onClick={() => void saveCopy(doc.text, fileName(ref.path))}>Save as…</button>
            : <button className="primary" onClick={onRecreate}>Save it again here</button>}
        </div>
      </div>,
    );
  }
  if (doc.error && doc.status !== "error") {
    // Characters the file's encoding cannot hold: saving as UTF-8 keeps them (phase 1B, section 4).
    const unmappable = /cannot be written in/.test(doc.error) && doc.status === "dirty";
    out.push(
      <div key="error" className="banner error note-banner">{doc.error}
        <div className="actions">
          {unmappable && <button className="primary" onClick={() => convertToUtf8(docKey)}>Convert to UTF-8</button>}
          <button onClick={dismiss}>OK</button>
        </div>
      </div>,
    );
  }
  return <>{out}</>;
}

/** The full path of a loose file, from the recent list. */
function useLoosePath(ref: { notebook: string }) {
  const recent = useQuery({ ...recentQuery(), enabled: isLoose(ref) });
  return recent.data?.find((r) => recentRef(r).notebook === ref.notebook)?.path;
}

/** The header name: double-click to rename a notebook page in place. A loose file shows its folder and is renamed in
 *  Explorer. */
function PageName({ tab, notebook }: { tab: Tab; notebook: Notebook | undefined }) {
  const client = useQueryClient();
  const path = tab.file!.path;
  const loose = isLoose(tab.file!);
  const full = useLoosePath(tab.file!);
  const [editing, setEditing] = useState<string | null>(null);
  const commit = () => {
    const name = editing?.trim();
    setEditing(null);
    if (!name || name === pageTitle(path)) return;
    movePath(client, tab.file!.notebook, path, renamed(path, name)).catch((e) => toast(classify(e).message, "error"));
  };
  const folder = full ? full.slice(0, full.lastIndexOf("\\")) : "";
  const where = loose ? `Opened file${folder ? ` · ${folder.slice(folder.lastIndexOf("\\") + 1)}` : ""}` : [notebook?.title, folderOf(path)].filter(Boolean).join(" · ");
  return (
    <>
      <span className="eyebrow" title={full ?? path}>{where || "notebook"}</span>
      {loose ? <h1>{fileName(path)}</h1> : editing === null
        ? <h1 onDoubleClick={() => setEditing(pageTitle(path))} title="Double-click to rename">{pageTitle(path)}</h1>
        : <input className="page-rename" autoFocus value={editing} aria-label="Page name" onChange={(e) => setEditing(e.target.value)} onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") setEditing(null); }} />}
    </>
  );
}

/** A notebook page: name, modes, save and actions, banners, then the reading view or the editor. */
export function FileTab({ tab }: { tab: Tab }) {
  const ref = tab.file!;
  const key = keyOf(ref);
  const doc = useDocuments((s) => s.docs[key]);
  const deleting = useDocuments((s) => isDeleting(s.held, ref));
  const updateTab = useWorkspace((s) => s.updateTab);
  const reveal = useWorkspace((s) => (s.reveal?.tabId === tab.id ? s.reveal : null));
  const client = useQueryClient();
  const notebooks = useQuery(notebooksQuery());
  const notebook = notebooks.data?.find((n) => n.id === ref.notebook);
  const pages = usePages(ref.notebook);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const follow = useFollow(tab, pages, setDialog);
  const markdown = isMarkdown(ref.path);
  const loose = isLoose(ref);
  const full = useLoosePath(ref);
  // Pictures load from the notebook's root (a page's folder inside it) or a loose file's folder.
  const pictures = useQuery({ queryKey: ["asset-base", ref.notebook, ref.path], queryFn: () => assetBase(ref.notebook, ref.path), staleTime: Infinity, enabled: markdown });
  const mode: Mode = markdown ? (tab.mode === "history" ? "reading" : tab.mode ?? "live") : "source";
  const titles = useCallback(() => pages.filter(isMarkdown).map(pageTitle), [pages]);

  useEffect(() => { void open(ref); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTab(tab.id, { title: pageTitle(ref.path) }); }, [ref.path, tab.id, updateTab]);

  const doSave = useCallback(() => saveFileTab(key), [key]);
  const merge = () => {
    const d = useDocuments.getState().docs[key];
    if (!d?.base || !d.theirs || !mergeable(d.theirs)) return;
    // The version shown is the one the result is saved against, whatever arrives while the dialog is open.
    const shown = d.theirs;
    setDialog(<PageMergeDialog base={d.base.text} mine={d.text} theirs={shown.text}
      onCancel={() => setDialog(null)} onResolve={(text) => { setDialog(null); void resolveMerge(key, text, shown); }} />);
  };
  const recreate = () => {
    const d = useDocuments.getState().docs[key];
    if (!d) return;
    createFile(ref.notebook, ref.path, d.text).then(() => reloadPage(key), (e) => toast(classify(e).message, "error"));
  };
  const remove = () => setDialog(
    <DeleteConfirm notebook={ref.notebook} path={ref.path} section={false}
      onAnswer={(yes) => {
        setDialog(null);
        if (yes) trashPath(client, ref.notebook, ref.path).catch((e) => toast(classify(e).message, "error"));
      }} />,
  );

  if (deleting) return <div className="center muted">Moving {fileName(ref.path)} to the trash…</div>;
  if (!doc || doc.status === "loading") return <div className="center muted">Opening {fileName(ref.path)}…</div>;
  if (doc.status === "error") {
    return (
      <div className="center">
        <div className="card">
          <p className="error">{doc.error}</p>
          <div className="actions">
            {/* A file too large to edit opens in its own program until NS-6B's viewer. */}
            {doc.error?.includes("larger than 64 MB") && <button onClick={() => void openOutside(ref)}>Open with default app</button>}
            <button onClick={() => void open(ref)}>Try again</button>
            {loose && <button onClick={() => void forgetRecent(ref, client)}>Remove from recent files</button>}
          </div>
        </div>
      </div>
    );
  }
  const unsaved = doc.status === "dirty" || doc.status === "stale";
  return (
    <div className="note-page file-page">
      <header className="note-header">
        <div className="note-top">
          <PageName tab={tab} notebook={notebook} />
          <span className="fill" />
          {doc.status !== "readOnly" && (
            <button className="primary" disabled={!unsaved || doc.status === "stale"} onClick={doSave} title="Save (Ctrl+S)">
              <Save size="1.1em" aria-hidden />{doc.status === "saving" ? "Saving…" : "Save"}
            </button>
          )}
          <Menu label="Page actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
            {(close) => {
              const item = (label: string, act: () => void, cls = "") => <li><button role="menuitem" className={cls} onClick={() => { close(); act(); }}>{label}</button></li>;
              return (
                <>
                  {item("Show in Explorer", () => revealFile(ref.notebook, ref.path).catch((e) => toast(classify(e).message, "error")))}
                  {item("Open with default app", () => revealFile(ref.notebook, ref.path, true).catch((e) => toast(classify(e).message, "error")))}
                  {item("Copy path", () => {
                    const copied = loose ? full ?? ref.path : notebook ? `${notebook.path}\\${ref.path.replace(/\//g, "\\")}` : ref.path;
                    navigator.clipboard.writeText(copied).then(() => toast("Path copied"), () => toast(copied));
                  })}
                  {!loose && item("Delete page…", remove, "danger-text")}
                </>
              );
            }}
          </Menu>
        </div>
        {markdown && <Tabs items={MODES} value={mode} label="Page view" onChange={(v) => updateTab(tab.id, { mode: v })} />}
      </header>
      <Banners doc={doc} docKey={key} onMerge={merge} onRecreate={recreate} />
      {mode === "reading"
        ? <PageView text={doc.text} tabId={tab.id} onLink={follow} pictures={{ base: pictures.data, folder: loose ? "" : folderOf(ref.path) }} />
        : (
          <div className="note file-editor">
            <CodeEditor key={key} doc={doc.text} docVersion={doc.version} follow language={markdown ? "markdown" : "text"} live={mode === "live"}
              readOnly={doc.status === "readOnly"} lineNumbers={!markdown} onChange={(text) => edit(key, text)} onSave={doSave}
              titles={titles} onOpenLink={follow} reveal={reveal} placeholder={markdown ? "Start writing…" : undefined} />
          </div>
        )}
      <StatusLine doc={doc} />
      {dialog}
    </div>
  );
}

const SIZE_UNITS = ["bytes", "KB", "MB"];
function size(n: number) {
  let i = 0;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(1)} ${SIZE_UNITS[i]}` : `${n} bytes`;
}
const EOL_NAMES = { lf: "LF", crlf: "CRLF", cr: "CR", mixed: "Mixed line endings", none: "" } as const;

/** Encoding, line endings and size, below the editor (NS-1B). */
function StatusLine({ doc }: { doc: DocState }) {
  if (!doc.base || doc.base.binary) return null;
  const f = doc.base.format;
  const encoding = `${f.encoding}${f.bom ? " with BOM" : ""}${f.confidence === "guess" ? " (guessed)" : ""}${doc.convert ? " (converted, not saved yet)" : ""}`;
  return <div className="file-status muted">{[encoding, EOL_NAMES[f.eol], size(doc.base.stamp.size)].filter(Boolean).join(" · ")}</div>;
}
