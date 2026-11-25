import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Save } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { convertToUtf8, discardKept, edit, isArriving, isDeleting, keyOf, open, recreate as recreatePageAgain, reformat, reload, resolveMerge, save, useDocuments } from "../../documents/store";
import { isUnsaved, mergeable, type DocState } from "../../documents/session";
import { classify } from "../../lib/errors";
import { baseName, fileManager, joinPath, parentFolder } from "../../lib/platform";
import { treeQuery } from "../../documents/io";
import { fileName, folderOf, isCanvas, isDocx, isDrawio, isMarkdown, isMermaid, isPdf, isRichDoc, isSvg, notebooksQuery, pageTitle, revealFile, type Notebook } from "../../lib/notebooks";
import { assetBase, isLoose, recentQuery, recentRef } from "../../lib/opens";
import { useWhitePaper } from "../../lib/paper";
import { announce } from "../../ui/announce";
import { Menu } from "../../ui/Menu";
import { Tabs } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace, type Mode, type Tab } from "../../workspace/store";
import { BigFileView } from "../bigfile/BigFileView";
import { HexView } from "../bigfile/HexView";
import { DocxTab } from "../docx/DocxTab";
import { saveDocxSession, useDocxStore } from "../docx/store";
import { PdfTab } from "../pdf/PdfTab";
import { savePdfSession, usePdfStore } from "../pdf/store";
import { CodeEditor } from "../editor/CodeEditor";
import { DocumentHeader, HISTORY_MODE as HISTORY, MARKDOWN_MODES } from "../editor/DocumentHeader";
import { FileHistory } from "../history/FileHistory";
import { PageMergeDialog } from "../editor/MergeDialog";
import { useFollowLink } from "../links/follow";
import { convertToRich, movePath, openPage, renamed, saveBothVersions, saveCopy, trashPath } from "./actions";
import { DeleteConfirm } from "./DeleteConfirm";
import { forgetRecent } from "./opening";
import { PageView } from "./PageView";
import { PropertiesPanel } from "./PropertiesPanel";
import { useRichPage } from "./richPage";
import { RICH_LIMIT } from "../editor/rich/context";
import { isPicture } from "../editor/rich/parse";
import { oversizeReason } from "../hmdoc/envelope";
import { canvasProblem } from "../canvas/model";
import { DayNav } from "./DailyViews";
import { runExport } from "./richActions";
import { useComparePicker } from "../power/ComparePicker";
import { encodingLabel, StatusLine } from "../power/StatusLine";

const MODES = MARKDOWN_MODES;
/** A text file has its source and its history; a rich page has no modes of its own (NS-3C), only the page and its history. */
const TEXT_MODES: { id: Mode; label: string }[] = [{ id: "source", label: "Source" }, HISTORY];
const RICH_MODES: { id: Mode; label: string }[] = [{ id: "live", label: "Page" }, HISTORY];
/** A canvas (NS-7C) is a board, its JSON source and its history. */
const CANVAS_MODES: { id: Mode; label: string }[] = [{ id: "board", label: "Board" }, { id: "source", label: "Source" }, HISTORY];
/** An SVG file: isolated image preview, side-by-side XML split, source and history. */
const SVG_MODES: { id: Mode; label: string }[] = [{ id: "preview", label: "Preview" }, { id: "split", label: "Split" }, { id: "source", label: "Source" }, HISTORY];
/** A Mermaid file: live split editor, full preview, source and history. */
const MERMAID_MODES: { id: Mode; label: string }[] = [{ id: "split", label: "Split" }, { id: "preview", label: "Preview" }, { id: "source", label: "Source" }, HISTORY];
/** Files Windows has a real viewer for open in it from a file card, as they do from the tree. */
const SYSTEM_VIEWED = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
/** A file in the large file viewer (NS-6B): its lines, or its bytes. */
const VIEWER_MODES: { id: Mode; label: string }[] = [{ id: "bigfile", label: "Large file viewer" }, { id: "hex", label: "Hex view" }];

/** A `.hmdoc` page (NS-3C) loads its editor, the rich page schema and Tiptap only when one first opens. */
const HmdocEditor = lazy(() => import("../hmdoc/HmdocEditor"));
/** A canvas (NS-7C) loads its board editor only when one first opens in Board mode. */
const CanvasEditor = lazy(() => import("../canvas/CanvasEditor"));
/** An SVG viewer/split editor loads lazily on first SVG tab. */
const SvgEditor = lazy(() => import("../svg/SvgEditor"));
/** A standalone Mermaid diagram editor loads lazily on first `.mmd`/`.mermaid` tab. */
const MermaidEditor = lazy(() => import("../mermaid/MermaidEditor"));
/** A native offline Draw.io board editor loads lazily on first `.drawio`/`.dio` tab. */
const DrawioEditor = lazy(() => import("../drawio/DrawioEditor"));

/** The pages of the tab's notebook, for `[[link]]` completion and resolution. */
function usePages(notebook: string) {
  const tree = useQuery({ ...treeQuery(notebook), enabled: !isLoose({ notebook }) });
  return useMemo(() => (tree.data?.entries ?? []).filter((e) => e.kind !== "dir").map((e) => e.path), [tree.data]);
}

/** Save a page and say when it needs a merge first; Ctrl+S in any mode of a page tab comes here. */
export async function saveFileTab(key: string) {
  if (useDocxStore.getState().sessions[key]) {
    const ok = await saveDocxSession(key);
    if (ok) toast("Saved .docx");
    else if (useDocxStore.getState().sessions[key]?.status === "stale") toast("This .docx changed on disk. Choose Keep mine or Reload.", "warn");
    return;
  }
  if (usePdfStore.getState().sessions[key]) {
    const ok = await savePdfSession(key);
    if (ok) toast("Saved PDF");
    else if (usePdfStore.getState().sessions[key]?.status === "stale") toast("This PDF changed on disk. Choose Keep mine or Reload.", "warn");
    return;
  }
  const wasDirty = useDocuments.getState().docs[key]?.status === "dirty";
  const after = await save(key);
  if (after?.status === "stale") toast("This page changed on disk. Merge your edits to save them.", "warn");
  // The Save button only changes its label; a screen reader hears the outcome here (the other kinds above say it with a toast).
  else if (wasDirty && after?.status === "clean") announce("Saved.");
}

/** Drop unsaved edits and show the file; typing while it reads keeps the edits instead. */
function reloadPage(key: string) {
  void reload(key).then((done) => { if (!done && useDocuments.getState().docs[key]?.status !== "error") toast("Reload stopped: you typed while the file was read, so your edits stay.", "warn"); });
}

/** Open the file with the program Windows associates with it. */
const openOutside = (ref: { notebook: string; path: string }) => revealFile(ref.notebook, ref.path, true).catch((e) => toast(classify(e).message, "error"));

/** Save the text of a page that cannot be written in place as a new UTF-8 file, and open that file. */
const copyAs = (text: string, name: string) => saveCopy(text, name).catch((e) => toast(classify(e).message, "error"));

/** A rich page is never merged line by line: the user keeps one version, or both (NS-3C). */
interface Conflict { mine: () => void; both?: () => void }

function Banners({ doc, docKey, onMerge, onRecreate, conflict }: { doc: DocState; docKey: string; onMerge: () => void; onRecreate: () => void; conflict?: Conflict }) {
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
          {/* A file that mixes line endings becomes editable once one is chosen (NS-6A). */}
          {doc.base.chooseEol && <button onClick={() => reformat(docKey, { eol: "lf" })}>Use LF and edit</button>}
          {doc.base.chooseEol && <button onClick={() => reformat(docKey, { eol: "crlf" })}>Use CRLF and edit</button>}
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
  if (doc.reformat && !doc.convert && isUnsaved(doc) && doc.base) {
    const was = doc.reformat.from, now = doc.base.format;
    const parts = [
      was.encoding !== now.encoding || was.bom !== now.bom ? `as ${encodingLabel(now)}` : "",
      was.eol !== now.eol ? `with ${now.eol === "crlf" ? "CRLF" : "LF"} line endings` : "",
    ].filter(Boolean);
    out.push(<div key="reformat" className="banner note-banner">Saving writes this file {parts.join(" ")}. Choose the old setting in the status line to keep it as it is.</div>);
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
        {conflict
          ? (
            <div className="actions">
              <button className="primary" onClick={conflict.mine} title="Save my version over the one on disk">Keep mine</button>
              <button onClick={() => reloadPage(docKey)} title="Drop my edits and show the version on disk">Keep theirs</button>
              {conflict.both && <button onClick={conflict.both} title="Save my version as a new page beside this one, then show the version on disk">Save both</button>}
            </div>
          )
          : <div className="actions"><button className="primary" onClick={onMerge}>Merge</button><button onClick={() => reloadPage(docKey)}>Reload (drop my edits)</button></div>}
      </div>,
    );
  }
  if (doc.draftError && isUnsaved(doc)) {
    out.push(
      <div key="draft" className="banner error note-banner">Your unsaved edits are not backed up as a draft ({doc.draftError}). Save the page to keep them, or save a copy.
        <div className="actions">
          {ref && !doc.base?.binary && <button onClick={() => void copyAs(doc.text, fileName(ref.path))}>Save a copy as…</button>}
          <button onClick={() => reloadPage(docKey)} title="Drop my edits and show the file as it is on disk">Discard my edits</button>
        </div>
      </div>,
    );
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
  const folder = full ? parentFolder(full) : "";
  const where = loose ? `Opened file${folder ? ` · ${baseName(folder)}` : ""}` : [notebook?.title, folderOf(path)].filter(Boolean).join(" · ");
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

/** A notebook page: routes binary document types (`.docx`, `.pdf`) to their dedicated tab, and text files to `TextFileTab`. */
export function FileTab({ tab }: { tab: Tab }) {
  if (tab.file && isDocx(tab.file.path)) return <DocxTab tab={tab} />;
  if (tab.file && isPdf(tab.file.path)) return <PdfTab tab={tab} />;
  return <TextFileTab tab={tab} />;
}

/** A text notebook page: name, modes, save and actions, banners, then the reading view or the editor. */
function TextFileTab({ tab }: { tab: Tab }) {
  const ref = tab.file!;
  const key = keyOf(ref);
  const doc = useDocuments((s) => s.docs[key]);
  const deleting = useDocuments((s) => isDeleting(s.held, ref));
  const arriving = useDocuments((s) => isArriving(s.held, ref));
  const updateTab = useWorkspace((s) => s.updateTab);
  const white = useWhitePaper(tab);
  const reveal = useWorkspace((s) => (s.reveal?.tabId === tab.id ? s.reveal : null));
  const client = useQueryClient();
  const notebooks = useQuery(notebooksQuery());
  const notebook: Notebook | undefined = notebooks.data?.find((n) => n.id === ref.notebook);
  const pages = usePages(ref.notebook);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const follow = useFollowLink(tab.file!, pages, setDialog);
  const markdown = isMarkdown(ref.path);
  // A rich page (NS-3C): JSON edited in its own editor, with no modes.
  const richDoc = isRichDoc(ref.path);
  // A canvas board (NS-7C): a JSON Canvas file with Board, Source and History modes; a file it cannot hold opens as Source.
  const canvas = isCanvas(ref.path);
  const drawio = isDrawio(ref.path);
  const svg = isSvg(ref.path);
  const mermaid = isMermaid(ref.path);
  const [drawioIssue, setDrawioIssue] = useState<string | null>(null);
  const loose = isLoose(ref);
  const full = useLoosePath(ref);
  // Pictures load from the notebook's root (a page's folder inside it) or a loose file's folder.
  // Every mount asks again, and nothing is kept once the page closes: a grant withdrawn meanwhile gets a new id (Codex
  // review of 52051c8, A3, and its re-review: the app's 30-second staleTime would otherwise reuse the old one).
  const pictures = useQuery({ queryKey: ["asset-base", ref.notebook, ref.path], queryFn: () => assetBase(ref.notebook, ref.path), refetchOnMount: "always", gcTime: 0, enabled: markdown || richDoc || canvas });
  const mode: Mode = tab.mode === "history" ? "history"
    : markdown ? (MARKDOWN_MODES.some((m) => m.id === tab.mode) ? tab.mode! : "live")
    : canvas || drawio ? (tab.mode === "source" ? "source" : "board")
    : svg ? (tab.mode === "split" || tab.mode === "source" ? tab.mode : "preview")
    : mermaid ? (tab.mode === "preview" || tab.mode === "source" ? tab.mode : "split")
    : "source";
  const titles = useCallback(() => pages.filter((p) => isMarkdown(p) || isRichDoc(p)).map(pageTitle), [pages]);
  // A canvas that cannot be held as a board opens as Source with the reason, and nothing is written (NS-7C). The tab stays
  // in Source until the user picks Board, so typing the fix does not flip the view under the cursor.
  const canvasText = canvas && mode !== "history" && doc && doc.status !== "loading" && doc.status !== "error" ? doc.text : null;
  const canvasIssue = useMemo(() => (canvasText === null ? null : canvasProblem(canvasText)), [canvasText]);
  useEffect(() => { if (canvas && mode === "board" && canvasIssue) updateTab(tab.id, { mode: "source" }); }, [canvas, mode, canvasIssue]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (drawio && mode === "board") setDrawioIssue(null); }, [drawio, mode, doc?.version]);
  const onDrawioInvalid = useCallback((reason: string) => {
    setDrawioIssue(reason);
    updateTab(tab.id, { mode: "source" });
  }, [tab.id, updateTab]);
  const boardPictures = useMemo(() => ({ base: pictures.data, folder: "", files: pages }), [pictures.data, pages]);
  const openFileCard = useCallback((path: string) => {
    if (SYSTEM_VIEWED.test(path)) revealFile(ref.notebook, path, true).catch((e) => toast(classify(e).message, "error"));
    else openPage({ notebook: ref.notebook, path });
  }, [ref.notebook]);

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
  /** Keep my version of a rich page over the one on disk: the result is my text, saved against the version shown. */
  const keepMine = () => {
    const d = useDocuments.getState().docs[key];
    if (!d?.base || !d.theirs || !mergeable(d.theirs, !!d.convert)) return;
    void resolveMerge(key, d.text, d.theirs);
  };
  const saveBoth = () => {
    const d = useDocuments.getState().docs[key];
    if (!d) return;
    const copied = d.text;
    saveBothVersions(client, ref, copied).then((path) => {
      // Typing went on while the copy was made: that text is not in the copy, so the page keeps it (R1-4).
      if (useDocuments.getState().docs[key]?.text !== copied) { toast(`Your version was saved as ${fileName(path)}, but you typed more meanwhile. Those edits stay here; the page was not reloaded.`, "warn"); return; }
      toast(`Your version was saved as ${fileName(path)}`);
      reloadPage(key);
    }, (e) => toast(classify(e).message, "error"));
  };
  const recreate = () => {
    const d = useDocuments.getState().docs[key];
    if (!d) return;
    // Text typed while the file is created stays as unsaved edits of the new file (Codex review of 7320d7f, DATA-3).
    recreatePageAgain(key).catch((e) => toast(classify(e).message, "error"));
  };
  const takesLink = useCallback(() => {
    const d = useDocuments.getState().docs[key];
    return !!d && d.status !== "readOnly" && d.status !== "loading" && d.status !== "error" && !arriving;
  }, [key, arriving]);
  // Live editing of a Markdown page (NS-3A).
  const files = pages;
  const rich = useRichPage({ ref, files, base: pictures.data, loose, follow, takesLink });
  const richStamp = useMemo(() => ({}), [pictures.data, files]); // eslint-disable-line react-hooks/exhaustive-deps
  const pictureFiles = useMemo(() => files.filter(isPicture), [files]);
  const remove = () => setDialog(
    <DeleteConfirm notebook={ref.notebook} path={ref.path} section={false}
      onAnswer={(yes) => {
        setDialog(null);
        if (yes) trashPath(client, ref.notebook, ref.path).catch((e) => toast(classify(e).message, "error"));
      }} />,
  );

  if (deleting) return <div className="center muted">Moving {fileName(ref.path)} to the trash…</div>;
  // A file over 64 MB and a binary file open in the large file viewer instead of the editor; the menu offers it and the hex
  // view for any file (NS-6B).
  const unsaved = doc?.status === "dirty" || doc?.status === "stale";
  const viewing: "bigfile" | "hex" | null = tab.mode === "bigfile" || tab.mode === "hex" ? tab.mode
    : doc?.status === "error" && /larger than 64 MB/.test(doc.error ?? "") ? "bigfile"
    : doc?.status === "readOnly" && doc.base?.binary ? "hex"
    : null;
  if (viewing) {
    const editable = !!doc && doc.status !== "error" && doc.status !== "loading" && !doc.base?.binary;
    return (
      <div className="note-page file-page viewer-page">
        <header className="note-header">
          <div className="note-top">
            <PageName tab={tab} notebook={notebook} />
            <span className="fill" />
            <Menu label="Page actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
              {(close) => {
                const item = (label: string, act: () => void) => <li><button role="menuitem" onClick={() => { close(); act(); }}>{label}</button></li>;
                return (
                  <>
                    {editable && item("Open in the editor", () => updateTab(tab.id, { mode: markdown ? "live" : "source" }))}
                    {item(`Show in ${fileManager()}`, () => revealFile(ref.notebook, ref.path).catch((e) => toast(classify(e).message, "error")))}
                    {item("Open with default app", () => revealFile(ref.notebook, ref.path, true).catch((e) => toast(classify(e).message, "error")))}
                    {item("Copy path", () => {
                      const copied = loose ? full ?? ref.path : notebook ? joinPath(notebook.path, ref.path) : ref.path;
                      navigator.clipboard.writeText(copied).then(() => toast("Path copied"), () => toast(copied));
                    })}
                  </>
                );
              }}
            </Menu>
          </div>
          <Tabs items={VIEWER_MODES} value={viewing} label="Viewer" onChange={(v) => updateTab(tab.id, { mode: v })} />
        </header>
        {unsaved && <div className="banner note-banner">This shows the file as it is on disk. Your unsaved edits stay in the editor.</div>}
        {viewing === "hex" ? <HexView key={key} file={ref} /> : <BigFileView key={key} file={ref} />}
        {dialog}
      </div>
    );
  }
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
            <button onClick={() => void open(ref)}>Try again</button>
            {loose && <button onClick={() => void forgetRecent(ref, client)}>Remove from recent files</button>}
          </div>
        </div>
      </div>
    );
  }
  const oversize = richDoc ? oversizeReason(doc.text) : null;
  /** A rich page the editor cannot hold shows as JSON that cannot be edited, with the reason above it. */
  const readOnlyJson = (reason: string) => (
    <>
      <div className="banner note-banner">{reason}</div>
      <CodeEditor key={key} doc={doc.text} docVersion={doc.version} follow language="text" live={false} readOnly lineNumbers
        onChange={() => {}} onSave={doSave} titles={titles} onOpenLink={follow} />
    </>
  );
  return (
    <div className="note-page file-page">
      <DocumentHeader modes={markdown ? MODES : richDoc ? RICH_MODES : canvas || drawio ? CANVAS_MODES : svg ? SVG_MODES : mermaid ? MERMAID_MODES : TEXT_MODES}
        mode={!markdown && !canvas && !drawio && !svg && !mermaid && mode !== "history" ? (richDoc ? "live" : "source") : mode === "board" && (canvasIssue || (drawio && drawioIssue)) ? "source" : mode}
        label="Page view" onMode={(v) => updateTab(tab.id, { mode: v })} top={<>
          <PageName tab={tab} notebook={notebook} />
          <span className="fill" />
          <DayNav file={ref} />
          {doc.status !== "readOnly" && (
            <button className="primary" disabled={!unsaved || doc.status === "stale"} onClick={doSave} title="Save (Ctrl+S)">
              <Save size="1.1em" aria-hidden />{doc.status === "saving" ? "Saving…" : "Save"}
            </button>
          )}
          <Menu label="Page actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
            {(close) => {
              const item = (label: string, act: () => void, cls = "") => <li><button role="menuitem" className={cls} onClick={() => { close(); act(); }}>{label}</button></li>;
              const paper = item(white ? "Theme background" : "White background", () => updateTab(tab.id, { paper: !white }));
              return (
                <>
                  {item(`Show in ${fileManager()}`, () => revealFile(ref.notebook, ref.path).catch((e) => toast(classify(e).message, "error")))}
                  {item("Open with default app", () => revealFile(ref.notebook, ref.path, true).catch((e) => toast(classify(e).message, "error")))}
                  {item("Copy path", () => {
                    const copied = loose ? full ?? ref.path : notebook ? joinPath(notebook.path, ref.path) : ref.path;
                    navigator.clipboard.writeText(copied).then(() => toast("Path copied"), () => toast(copied));
                  })}
                  {!richDoc && item("Compare with another file…", () => useComparePicker.getState().show(ref))}
                  {item("Open in large file viewer", () => updateTab(tab.id, { mode: "bigfile" }))}
                  {item("Hex view", () => updateTab(tab.id, { mode: "hex" }))}
                  {!loose && markdown && item("Convert to rich page", () => convertToRich(client, ref, doc.text).catch((e) => toast(classify(e).message, "error")))}
                  {!loose && richDoc && item("Export to Markdown…", () => runExport(client, ref, setDialog, doc.text))}
                  {paper}
                  {!loose && item("Delete page…", remove, "danger-text")}
                </>
              );
            }}
          </Menu>
        </>} />
      <Banners doc={doc} docKey={key} onMerge={merge} onRecreate={recreate} conflict={richDoc || canvas || drawio ? { mine: keepMine, both: loose ? undefined : saveBoth } : undefined} />
      {canvas && canvasIssue && mode !== "history" && <div className="banner warn note-banner">This canvas cannot be shown as a board: {canvasIssue}. It is open as source, and nothing was written.</div>}
      {drawio && drawioIssue && mode !== "history" && <div className="banner warn note-banner">This Draw.io file cannot be shown as a board: {drawioIssue}. It is open as source, and nothing was written.</div>}
      {markdown && mode !== "history" && <PropertiesPanel docKey={key} readOnly={doc.status === "readOnly" || arriving} onOpenLink={(target) => follow(target, false)} />}
      {markdown && mode === "live" && doc.text.length > RICH_LIMIT && (
        <div className="banner note-banner">This page is over 1 MB, so Live shows plain Markdown styling without tables, pictures or diagrams.</div>
      )}
      {mode === "history"
        ? <FileHistory file={ref} tabId={tab.id} />
        : canvas && mode === "board" && !canvasIssue
        ? (
          <div className="note file-editor">
            <Suspense fallback={<div className="center muted">Loading the canvas…</div>}>
              <CanvasEditor key={key} text={doc.text} readOnly={doc.status === "readOnly" || arriving} onChange={(text) => edit(key, text)}
                ctx={rich} pictures={boardPictures} notebook={ref.notebook} onOpenFile={openFileCard} />
            </Suspense>
          </div>
        )
        : drawio && mode === "board"
        ? (
          <div className="note file-editor">
            <Suspense fallback={<div className="center muted">Loading Draw.io board…</div>}>
              <DrawioEditor key={key} text={doc.text} readOnly={doc.status === "readOnly" || arriving} fileName={fileName(ref.path)}
                onChange={(text) => edit(key, text)} onInvalid={onDrawioInvalid} />
            </Suspense>
          </div>
        )
        : svg && (mode === "preview" || mode === "split")
        ? (
          <div className="note file-editor">
            <Suspense fallback={<div className="center muted">Loading SVG viewer…</div>}>
              <SvgEditor key={key} doc={doc.text} docVersion={doc.version} mode={mode} readOnly={doc.status === "readOnly" || arriving}
                fileName={fileName(ref.path)} tabId={tab.id} language={tab.language} onChange={(text) => edit(key, text)} onSave={doSave}
                titles={titles} onOpenLink={follow} reveal={reveal} />
            </Suspense>
          </div>
        )
        : mermaid && (mode === "split" || mode === "preview")
        ? (
          <div className="note file-editor">
            <Suspense fallback={<div className="center muted">Loading Mermaid editor…</div>}>
              <MermaidEditor key={key} doc={doc.text} docVersion={doc.version} mode={mode} readOnly={doc.status === "readOnly" || arriving}
                fileName={fileName(ref.path)} tabId={tab.id} language={tab.language} onChange={(text) => edit(key, text)} onSave={doSave}
                titles={titles} onOpenLink={follow} reveal={reveal} />
            </Suspense>
          </div>
        )
        : richDoc
        ? (
          <div className="note file-editor">
            {oversize
              ? readOnlyJson(oversize)
              : (
                <Suspense fallback={<div className="center muted">Loading the page editor…</div>}>
                  <HmdocEditor key={key} text={doc.text} version={doc.version} readOnly={doc.status === "readOnly" || arriving} onChange={(text) => edit(key, text)}
                    onSave={doSave} ctx={rich} ctxStamp={richStamp} reveal={reveal} pictures={pictureFiles} invalid={readOnlyJson} />
                </Suspense>
              )}
          </div>
        )
        : mode === "reading"
        ? <PageView text={doc.text} tabId={tab.id} onLink={follow}
          pictures={{ base: pictures.data, folder: loose ? "" : folderOf(ref.path), files }} embed={loose ? undefined : rich.readEmbed} />
        : (
          <div className={`note file-editor${markdown ? " doc-column" : ""}`}>
            <CodeEditor key={key} doc={doc.text} docVersion={doc.version} follow language={markdown ? "markdown" : "text"} live={mode === "live"}
              readOnly={doc.status === "readOnly" || arriving} lineNumbers={!markdown} onChange={(text) => edit(key, text)} onSave={doSave}
              titles={titles} onOpenLink={follow} reveal={reveal} placeholder={markdown ? "Start writing…" : undefined}
              rich={markdown ? rich : undefined} richStamp={richStamp}
              power={{ id: tab.id, fileName: fileName(ref.path), language: tab.language, on: mode === "source" }} />
          </div>
        )}
      <StatusLine doc={doc} docKey={key} tabId={tab.id} fileName={fileName(ref.path)} markdown={markdown} language={tab.language}
        onLanguage={(language) => updateTab(tab.id, { language })} />
      {dialog}
    </div>
  );
}
