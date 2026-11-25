// Full `.docx` document tab: faithful Layout Preview, Tiptap rich Edit mode with surgical OOXML save, and Binary History.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Save } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { classify } from "../../lib/errors";
import { fileManager } from "../../lib/platform";
import { fileName, folderOf, notebooksQuery, pageTitle, revealFile } from "../../lib/notebooks";
import { isLoose } from "../../lib/opens";
import { Menu } from "../../ui/Menu";
import { toast } from "../../ui/toast";
import { useWorkspace, type Mode, type Tab } from "../../workspace/store";
import { HexView } from "../bigfile/HexView";
import { DocumentHeader, HISTORY_MODE } from "../editor/DocumentHeader";
import { BinaryHistory } from "../history/BinaryHistory";
import { rawDocx } from "../../lib/docx";
import { saveBinaryCopy, trashPath } from "../notes/actions";
import { DeleteConfirm } from "../notes/DeleteConfirm";
import { addDocxMedia, docxKey, editDocx, openDocx, restoreDocxSnapshot, saveDocxSession, useDocxStore } from "./store";

const DocxPreview = lazy(() => import("./DocxPreview"));
const DocxEditor = lazy(() => import("./DocxEditor"));

const DOCX_MODES: { id: Mode; label: string }[] = [
  { id: "preview", label: "Preview" },
  { id: "edit", label: "Edit" },
  HISTORY_MODE,
];

export function DocxTab({ tab }: { tab: Tab }) {
  const ref = tab.file!;
  const key = docxKey(ref);
  const session = useDocxStore((s) => s.sessions[key]);
  const updateTab = useWorkspace((s) => s.updateTab);
  const notebooks = useQuery(notebooksQuery());
  const client = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loose = isLoose(ref);
  const notebook = notebooks.data?.find((n) => n.id === ref.notebook);
  const mode: Mode = tab.mode === "hex" ? "hex" : tab.mode === "edit" || tab.mode === "history" ? tab.mode : "preview";

  useEffect(() => { void openDocx(ref); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTab(tab.id, { title: pageTitle(ref.path) }); }, [ref.path, tab.id, updateTab]);

  const doSave = async (force = false) => {
    const ok = await saveDocxSession(key, force);
    if (ok) toast("Saved .docx");
    else if (useDocxStore.getState().sessions[key]?.status === "stale") {
      toast("This .docx changed on disk. Choose Keep mine or Reload.", "warn");
    }
  };

  if (mode === "hex") {
    return (
      <div className="note-page file-page viewer-page">
        <header className="note-header">
          <div className="note-top">
            <span className="eyebrow">{loose ? "Opened file" : [notebook?.title, folderOf(ref.path)].filter(Boolean).join(" · ") || "notebook"}</span>
            <h1>{fileName(ref.path)}</h1>
            <span className="fill" />
            <button type="button" onClick={() => updateTab(tab.id, { mode: "preview" })}>Back to Preview</button>
          </div>
        </header>
        <HexView key={key} file={ref} />
      </div>
    );
  }

  if (!session || session.status === "loading") {
    return <div className="center muted">Opening {fileName(ref.path)}…</div>;
  }

  if (session.status === "error") {
    return (
      <div className="center">
        <div className="card">
          <p className="error">{session.error}</p>
          <div className="actions">
            <button type="button" onClick={() => void openDocx(ref, true)}>Try again</button>
            <button type="button" onClick={() => revealFile(ref.notebook, ref.path, true).catch((e) => toast(classify(e).message, "error"))}>Open with default app</button>
            <button type="button" onClick={() => updateTab(tab.id, { mode: "hex" })}>Hex view</button>
          </div>
        </div>
      </div>
    );
  }

  const dirty = session.status === "dirty" || session.status === "stale";
  const where = loose ? "Opened file" : [notebook?.title, folderOf(ref.path)].filter(Boolean).join(" · ");

  return (
    <div className="note-page file-page">
      <DocumentHeader
        modes={DOCX_MODES}
        mode={mode}
        label="Word document view"
        onMode={(v) => updateTab(tab.id, { mode: v })}
        top={
          <>
            <span className="eyebrow">{where || "notebook"}</span>
            <h1>{fileName(ref.path)}</h1>
            <span className="fill" />
            {session.status !== "readOnly" && (
              <button
                type="button"
                className="primary"
                disabled={!dirty || session.status === "stale" || session.saving}
                onClick={() => void doSave(false)}
                title="Save (Ctrl+S)"
              >
                <Save size="1.1em" aria-hidden />
                {session.saving ? "Saving…" : "Save"}
              </button>
            )}
            <Menu label="Document actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
              {(close) => {
                const item = (label: string, act: () => void, cls = "") => (
                  <li><button role="menuitem" className={cls} onClick={() => { close(); act(); }}>{label}</button></li>
                );
                return (
                  <>
                    {item("Save a copy as…", () => {
                      void rawDocx(ref.notebook, ref.path)
                        .then((buf) => saveBinaryCopy(new Uint8Array(buf), fileName(ref.path), true))
                        .then((saved) => { if (saved) toast(`Saved copy as ${fileName(saved.path)}`); })
                        .catch((e) => toast(classify(e).message, "error"));
                    })}
                    {item(`Show in ${fileManager()}`, () => revealFile(ref.notebook, ref.path).catch((e) => toast(classify(e).message, "error")))}
                    {item("Open with default app", () => revealFile(ref.notebook, ref.path, true).catch((e) => toast(classify(e).message, "error")))}
                    {item("Hex view", () => updateTab(tab.id, { mode: "hex" }))}
                    {!loose && item("Delete…", () => setConfirmDelete(true), "danger-text")}
                  </>
                );
              }}
            </Menu>
          </>
        }
      />

      {session.readOnly && (
        <div className="banner note-banner">Read-only: {session.readOnly}.</div>
      )}
      {session.status === "stale" && (
        <div className="banner warn note-banner">
          This `.docx` file changed on disk while you were editing.
          <div className="actions">
            <button type="button" className="primary" onClick={() => void doSave(true)}>Keep mine (overwrite)</button>
            <button type="button" onClick={() => void openDocx(ref, true)}>Reload from disk</button>
          </div>
        </div>
      )}
      {session.error && <div className="banner error note-banner">{session.error}</div>}
      {mode === "edit" && (session.warnings.length > 0 || session.hasHeadersFooters) && (
        <div className="banner note-banner">
          {session.hasHeadersFooters && "Headers, footers, styles, and page setup are preserved untouched on save. "}
          {session.warnings.map((w) => w.message).join(" ")} The original file is snapshotted in History before saving.
        </div>
      )}

      {mode === "history" ? (
        <BinaryHistory
          file={ref}
          stampSha={session.stamp?.sha256}
          canRestore={session.status === "clean"}
          onRestore={(id) => restoreDocxSnapshot(key, id)}
        />
      ) : mode === "edit" && session.doc ? (
        <div className="note file-editor">
          <Suspense fallback={<div className="center muted">Loading Word editor…</div>}>
            <DocxEditor
              doc={session.doc}
              version={session.version}
              media={session.media}
              readOnly={session.status === "readOnly"}
              onChange={(next) => editDocx(key, next)}
              onAddMedia={(mime, b64) => addDocxMedia(key, mime, b64)}
              onSave={() => void doSave(false)}
            />
          </Suspense>
        </div>
      ) : (
        <div className="note file-editor">
          <Suspense fallback={<div className="center muted">Loading layout preview…</div>}>
            <DocxPreview file={ref} version={session.version} dirty={dirty} />
          </Suspense>
        </div>
      )}

      {confirmDelete && (
        <DeleteConfirm
          notebook={ref.notebook}
          path={ref.path}
          section={false}
          onAnswer={(yes) => {
            setConfirmDelete(false);
            if (yes) trashPath(client, ref.notebook, ref.path).catch((e) => toast(classify(e).message, "error"));
          }}
        />
      )}
    </div>
  );
}
