import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Save } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { convertToUtf8, discardKept, edit, inOwnStore, isArriving, isDeleting, keyOf, open, reload, resolveMerge, save, useDocuments } from "../../documents/store";
import { isUnsaved, mergeable, type DocState } from "../../documents/session";
import { classify } from "../../lib/errors";
import { assetLink, attachFile, openAttachment, parseLm } from "../../documents/adapters/lmdoc";
import { createDoc, lmAssets, treeQuery } from "../../documents/io";
import { lmNotebooksQuery } from "../../lib/lm";
import { fileName, folderOf, isMarkdown, notebooksQuery, pageTitle, revealFile, type Notebook } from "../../lib/notebooks";
import { assetBase, isLoose, recentQuery, recentRef } from "../../lib/opens";
import { Menu } from "../../ui/Menu";
import { Confirm, Modal } from "../../ui/Modal";
import { Tabs } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace, type Mode, type Tab } from "../../workspace/store";
import { CodeEditor } from "../editor/CodeEditor";
import { PageMergeDialog } from "../editor/MergeDialog";
import { resolvePage } from "../links/resolve";
import { movePath, openPage, renamed, saveCopy, trashPath } from "./actions";
import { DeleteConfirm } from "./DeleteConfirm";
import { forgetRecent } from "./opening";
import { PageView } from "./PageView";
import { useRichPage } from "./richPage";
import { RICH_LIMIT } from "../editor/rich/context";

const MODES: { id: Mode; label: string }[] = [{ id: "reading", label: "Reading" }, { id: "live", label: "Live" }, { id: "rich", label: "Rich" }, { id: "source", label: "Source" }];

/** Rich mode (NS-3B) loads its editor, Tiptap and the Markdown parser only when a page first opens in it. */
const RichEditor = lazy(() => import("../rich/RichEditor"));

/** The pages of the tab's notebook, for `[[link]]` completion and resolution. */
function usePages(notebook: string) {
  const tree = useQuery({ ...treeQuery(notebook), enabled: !isLoose({ notebook }) });
  return useMemo(() => (tree.data?.entries ?? []).filter((e) => e.kind !== "dir").map((e) => e.path), [tree.data]);
}

/** Follow a `[[link]]` from a page: open it, offer to create it, or let the user pick between pages of the same name. */
function useFollow(tab: Tab, pages: string[], ask: (node: ReactNode) => void) {
  const client = useQueryClient();
  const from = tab.file!;
  // `at` is the page the link is in when that is not this tab's page: an embedded page resolves from its own folder
  // (Codex review of 398b956, P2).
  return useCallback((target: string, split: boolean, at?: string) => {
    const hit = resolvePage(target, at === undefined ? from : { ...from, path: at }, pages);
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
          createDoc(from.notebook, hit.missing, "").then(() => {
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
const copyAs = (text: string, name: string) => saveCopy(text, name).catch((e) => toast(classify(e).message, "error"));

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
          {doc.base.convertible && <button onClick={() => void convertToUtf8(docKey).catch((e) => toast(classify(e).message, "error"))}>Convert to UTF-8 and edit</button>}
          {/* Binary files open in their own program until NS-6B's viewer; text Hivemind may not write can be saved elsewhere. */}
          {doc.base.binary && ref && <button onClick={() => void openOutside(ref)}>Open with default app</button>}
          {!doc.base.binary && !doc.base.convertible && ref && <button onClick={() => void copyAs(doc.text, fileName(ref.path))}>Save a copy as…</button>}
        </div>
      </div>,
    );
  }
  if (doc.status === "readOnly" && doc.kept && ref) {
    const kept = doc.kept;
    const back = doc.base?.convertible ? " Convert to UTF-8 brings them back." : "";
    out.push(
      <div key="kept" className="banner note-banner">Unsaved edits from a draft (kept {new Date(kept.at).toLocaleString()}) cannot be saved to this file.{back}
        <div className="actions">
          {!doc.base?.convertible && <button onClick={() => void copyAs(kept.text, fileName(ref.path))}>Save the edits as a copy…</button>}
          {/* A draft from another Living Memory store blocks this page until it is discarded here (R2-U1). */}
          <button onClick={() => void discardKept(docKey).catch((e) => toast(classify(e).message, "error"))}>Discard the draft</button>
        </div>
      </div>,
    );
  }
  if (doc.convert && isUnsaved(doc)) {
    const lossy = doc.base?.convertible ? " Bytes that did not decode are saved as �." : "";
    out.push(<div key="convert" className="banner note-banner">Saving writes this file as UTF-8.{lossy}</div>);
  }
  if ((doc.status === "stale" || doc.banner?.kind === "changed") && !mergeable(doc.theirs, !!doc.convert)) {
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
            ? <button className="primary" onClick={() => void copyAs(doc.text, fileName(ref.path))}>Save as…</button>
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
          {unmappable && <button className="primary" onClick={() => void convertToUtf8(docKey).catch((e) => toast(classify(e).message, "error"))}>Convert to UTF-8</button>}
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
  const arriving = useDocuments((s) => isArriving(s.held, ref));
  const updateTab = useWorkspace((s) => s.updateTab);
  const reveal = useWorkspace((s) => (s.reveal?.tabId === tab.id ? s.reveal : null));
  const client = useQueryClient();
  const notebooks = useQuery(notebooksQuery());
  // A Living Memory page (NS-2C) is named `domain · notebook title` and has no file on disk to show or open.
  const lm = parseLm(ref.notebook);
  const lmList = useQuery({ ...lmNotebooksQuery(), enabled: !!lm });
  const lmTitle = lm && (lmList.data?.notebooks.find((n) => n.domain === lm.domain && n.notebook === lm.notebook)?.title ?? lm.notebook);
  const notebook: Notebook | undefined = lm ? { id: ref.notebook, path: "", title: `${lm.domain} · ${lmTitle}`, added: "" } : notebooks.data?.find((n) => n.id === ref.notebook);
  const pages = usePages(ref.notebook);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const follow = useFollow(tab, pages, setDialog);
  const markdown = isMarkdown(ref.path);
  const loose = isLoose(ref);
  const full = useLoosePath(ref);
  // Pictures load from the notebook's root (a page's folder inside it) or a loose file's folder.
  // Every mount asks again, and nothing is kept once the page closes: a grant withdrawn meanwhile gets a new id (Codex
  // review of 52051c8, A3, and its re-review: the app's 30-second staleTime would otherwise reuse the old one).
  // A parked page of another store shows no attachments: they would come from the store connected now (R3-P3).
  const own = inOwnStore(key);
  const pictures = useQuery({ queryKey: ["asset-base", ref.notebook, ref.path], queryFn: () => assetBase(ref.notebook, ref.path), refetchOnMount: "always", gcTime: 0, enabled: markdown && own });
  const mode: Mode = markdown ? (tab.mode === "history" ? "reading" : tab.mode ?? "live") : "source";
  const titles = useCallback(() => pages.filter(isMarkdown).map(pageTitle), [pages]);

  useEffect(() => { void open(ref); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTab(tab.id, { title: pageTitle(ref.path) }); }, [ref.path, tab.id, updateTab]);

  const doSave = useCallback(() => saveFileTab(key), [key]);
  const merge = () => {
    const d = useDocuments.getState().docs[key];
    if (!d?.base || !d.theirs || !mergeable(d.theirs, !!d.convert)) return;
    // The version shown is the one the result is saved against, whatever arrives while the dialog is open.
    const shown = d.theirs;
    setDialog(<PageMergeDialog base={d.base.text} mine={d.text} theirs={shown.text}
      onCancel={() => setDialog(null)} onResolve={(text) => { setDialog(null); void resolveMerge(key, text, shown); }} />);
  };
  const recreate = () => {
    const d = useDocuments.getState().docs[key];
    if (!d) return;
    if (!inOwnStore(key)) { toast("This page belongs to another Living Memory store, so it was not created here.", "warn"); return; }
    // A Living Memory page comes back with the line endings and byte order mark it had (Codex review of 32fee20, D5).
    createDoc(ref.notebook, ref.path, d.text, d.base?.format).then(() => reloadPage(key), (e) => toast(classify(e).message, "error"));
  };
  /** Copy a file the user picks into the notebook's attachments and link it at the end of the page (NS-2C). A page that
   *  cannot take the link is said before anything is copied (Codex review of 32fee20, U2). */
  const ownNow = useCallback(() => inOwnStore(key), [key]);
  const takesLink = useCallback(() => {
    const d = useDocuments.getState().docs[key];
    return !!d && d.status !== "readOnly" && d.status !== "loading" && d.status !== "error" && !arriving && inOwnStore(key);
  }, [key, arriving]);
  // Rich editing of a Markdown page (NS-3A); a page of another store shows and attaches nothing from this one.
  // A Living Memory notebook's attachments are not in its tree; `![[picture.png]]` looks among them too.
  const assets = useQuery({ queryKey: ["lm-assets", ref.notebook], queryFn: () => lmAssets(ref.notebook), enabled: markdown && own && !!lm });
  const files = useMemo(() => (assets.data?.length ? [...pages, ...assets.data] : pages), [pages, assets.data]);
  const rich = useRichPage({ ref, files, base: own ? pictures.data : undefined, lm: !!lm, loose, follow, takesLink, own: ownNow });
  // A change of store redraws embeds too, so a parked page shows none from the store connected now.
  const richStamp = useMemo(() => ({}), [pictures.data, files, own]); // eslint-disable-line react-hooks/exhaustive-deps
  const attach = () => {
    if (!takesLink()) { toast("This page cannot take a link now, so nothing was attached.", "warn"); return; }
    return attachFile(ref.notebook).then((asset) => { if (asset) linkAsset(asset); }, (e) => toast(classify(e).message, "error"));
  };
  const linkAsset = (asset: string) => {
    const d = useDocuments.getState().docs[key];
    const name = fileName(asset).replace(/^[0-9a-f]{8}-/, "");
    if (!d || !takesLink()) { toast(`Attached ${name}; this page cannot take a link to it now.`, "warn"); return; }
    const link = `${/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(asset) ? "!" : ""}[${name}](${assetLink(ref.path, asset)})`;
    edit(key, `${d.text}${d.text && !d.text.endsWith("\n") ? "\n" : ""}${link}\n`, true);
  };
  /** A relative link in a Living Memory page: an attachment opens in its own program, a page opens in a tab. */
  const openLinked = useCallback((path: string) => {
    if (!inOwnStore(key)) { toast("This page belongs to another Living Memory store, so its links do not open here.", "warn"); return; }
    if (/^assets\//.test(path)) openAttachment(ref.notebook, path).catch((e) => toast(classify(e).message, "error"));
    else if (isMarkdown(path)) openPage({ notebook: ref.notebook, path });
  }, [ref.notebook, key]);
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
          {doc.kept && <p>Unsaved edits of this page are kept as a draft (from {new Date(doc.kept.at).toLocaleString()}).</p>}
          <div className="actions">
            {doc.kept && <button onClick={() => void copyAs(doc.kept!.text, fileName(ref.path))}>Save the edits as a copy…</button>}
            {doc.kept && <button onClick={() => void discardKept(key).catch((e) => toast(classify(e).message, "error"))}>Discard the draft</button>}
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
              if (lm) return <>{item("Attach file…", () => void attach())}{item("Delete page…", remove, "danger-text")}</>;
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
      {markdown && mode === "live" && doc.text.length > RICH_LIMIT && (
        <div className="banner note-banner">This page is over 1 MB, so Live shows plain Markdown styling without tables, pictures or diagrams.</div>
      )}
      {markdown && mode === "rich" && doc.text.length > RICH_LIMIT && (
        <div className="banner note-banner">This page is over 1 MB, so it opens as Markdown source instead of in Rich mode.</div>
      )}
      {markdown && mode === "rich" && doc.text.length <= RICH_LIMIT
        ? (
          <div className="note file-editor">
            <Suspense fallback={<div className="center muted">Loading the Rich editor…</div>}>
              <RichEditor key={key} text={doc.text} readOnly={doc.status === "readOnly" || arriving} onChange={(text) => edit(key, text)}
                onSave={doSave} ctx={rich} ctxStamp={richStamp} reveal={reveal} placeholder="Start writing…" />
            </Suspense>
          </div>
        )
        : mode === "reading"
        ? <PageView text={doc.text} tabId={tab.id} onLink={follow} onFile={lm ? openLinked : undefined}
          pictures={{ base: own ? pictures.data : undefined, folder: loose ? "" : folderOf(ref.path), files }} embed={loose ? undefined : rich.readEmbed} />
        : (
          <div className="note file-editor">
            <CodeEditor key={key} doc={doc.text} docVersion={doc.version} follow language={markdown ? "markdown" : "text"} live={mode === "live"}
              readOnly={doc.status === "readOnly" || arriving} lineNumbers={!markdown} onChange={(text) => edit(key, text)} onSave={doSave}
              titles={titles} onOpenLink={follow} reveal={reveal} placeholder={markdown ? "Start writing…" : undefined}
              rich={markdown ? rich : undefined} richStamp={richStamp} />
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
