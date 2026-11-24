// Standalone `.pdf` document tab: View (default) | Edit | History, backed by `pdfjs-dist` and `pdf-lib`.
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
import { trashPath } from "../notes/actions";
import { DeleteConfirm } from "../notes/DeleteConfirm";
import { openPdf, pdfKey, restorePdfSnapshot, savePdfSession, usePdfStore } from "./store";

const PdfViewer = lazy(() => import("./PdfViewer"));

const PDF_MODES: { id: Mode; label: string }[] = [
  { id: "preview", label: "View" },
  { id: "edit", label: "Edit" },
  HISTORY_MODE,
];

export function PdfTab({ tab }: { tab: Tab }) {
  const ref = tab.file!;
  const key = pdfKey(ref);
  const session = usePdfStore((s) => s.sessions[key]);
  const updateTab = useWorkspace((s) => s.updateTab);
  const notebooks = useQuery(notebooksQuery());
  const client = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loose = isLoose(ref);
  const notebook = notebooks.data?.find((n) => n.id === ref.notebook);
  const mode: Mode = tab.mode === "hex" ? "hex" : tab.mode === "edit" || tab.mode === "history" ? tab.mode : "preview";

  useEffect(() => { void openPdf(ref); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { updateTab(tab.id, { title: pageTitle(ref.path) }); }, [ref.path, tab.id, updateTab]);

  const doSave = async (opts: { forceOverwrite?: boolean; flattenForm?: boolean } = {}) => {
    const ok = await savePdfSession(key, opts);
    if (ok) toast(opts.flattenForm ? "Saved flattened PDF" : "Saved PDF");
    else if (usePdfStore.getState().sessions[key]?.status === "stale") {
      toast("This PDF changed on disk. Choose Keep mine or Reload.", "warn");
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
            <button type="button" onClick={() => updateTab(tab.id, { mode: "preview" })}>Back to View</button>
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
            <button type="button" onClick={() => void openPdf(ref, true)}>Try again</button>
            <button type="button" onClick={() => revealFile(ref.notebook, ref.path, true).catch((e) => toast(classify(e).message, "error"))}>Open with default app</button>
            <button type="button" onClick={() => updateTab(tab.id, { mode: "hex" })}>Hex view</button>
          </div>
        </div>
      </div>
    );
  }

  const dirty = session.status === "dirty" || session.status === "stale";
  const canEdit = session.status !== "readOnly";
  const where = loose ? "Opened file" : [notebook?.title, folderOf(ref.path)].filter(Boolean).join(" · ");

  return (
    <div className="note-page file-page">
      <DocumentHeader
        modes={PDF_MODES}
        mode={mode}
        label="PDF view"
        onMode={(v) => updateTab(tab.id, { mode: v })}
        top={
          <>
            <span className="eyebrow">{where || "notebook"}</span>
            <h1>{fileName(ref.path)}</h1>
            <span className="fill" />
            {canEdit && (
              <button
                type="button"
                className="primary"
                disabled={!dirty || session.status === "stale" || session.saving}
                onClick={() => void doSave()}
                title="Save PDF (Ctrl+S)"
              >
                <Save size="1.1em" aria-hidden />
                {session.saving ? "Saving…" : "Save"}
              </button>
            )}
            <Menu label="PDF actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
              {(close) => {
                const item = (label: string, act: () => void, cls = "") => (
                  <li><button role="menuitem" className={cls} onClick={() => { close(); act(); }}>{label}</button></li>
                );
                return (
                  <>
                    {canEdit && session.formFields.length > 0 && item("Save and flatten form fields", () => void doSave({ flattenForm: true }))}
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

      {session.readOnly && <div className="banner note-banner">Read-only: {session.readOnly}</div>}
      {session.status === "stale" && (
        <div className="banner warn note-banner">
          This PDF changed on disk while you were editing.
          <div className="actions">
            <button type="button" className="primary" onClick={() => void doSave({ forceOverwrite: true })}>Keep mine (overwrite)</button>
            <button type="button" onClick={() => void openPdf(ref, true)}>Reload from disk</button>
          </div>
        </div>
      )}
      {session.error && <div className="banner error note-banner">{session.error}</div>}

      {mode === "history" ? (
        <BinaryHistory
          file={ref}
          stampSha={session.stamp?.sha256}
          canRestore={session.status === "clean"}
          onRestore={(id) => restorePdfSnapshot(key, id)}
        />
      ) : (
        <div className="note file-editor">
          <Suspense fallback={<div className="center muted">Loading PDF viewer…</div>}>
            <PdfViewer file={ref} session={session} editing={mode === "edit" && canEdit} />
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
