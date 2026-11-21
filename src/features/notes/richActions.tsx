// The rich page's actions that end in a dialog (NS-3C): Export to Markdown says what the Markdown could not keep.
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FileRef } from "../../documents/keys";
import { classify } from "../../lib/errors";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import type { ReportItem } from "../hmdoc/toMarkdown";
import { exportToMarkdown, openPage } from "./actions";

export function ExportReport({ path, report, onOpen, onClose }: { path: string; report: ReportItem[]; onOpen: () => void; onClose: () => void }) {
  return (
    <Modal title="Exported to Markdown" onClose={onClose}>
      <p>Saved as <code>{path}</code> beside the page.</p>
      {report.length
        ? (
          <>
            <p>The Markdown page cannot hold everything, so these were dropped or flattened:</p>
            <ul className="plain-list" aria-label="Dropped or flattened">
              {report.map((r) => <li key={r.key}>{r.label}: <b>{r.count}</b></li>)}
            </ul>
          </>
        )
        : <p>Nothing was dropped or flattened.</p>}
      <div className="actions">
        <button className="primary" onClick={onOpen}>Open the Markdown page</button>
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/** Export `ref` to Markdown and show the report in the dialog `ask` shows. `text` is the page's text when the caller has
 *  it (an open page, unsaved edits included). */
export function runExport(client: QueryClient, ref: FileRef, ask: (dialog: ReactNode) => void, text?: string) {
  exportToMarkdown(client, ref, text).then(
    ({ path, report }) => {
      const where = { notebook: ref.notebook, path };
      ask(<ExportReport path={path} report={report} onOpen={() => { ask(null); openPage(where); }} onClose={() => ask(null)} />);
    },
    (e) => toast(classify(e).message, "error"),
  );
}
