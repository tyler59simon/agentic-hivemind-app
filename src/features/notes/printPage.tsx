// Export to PDF (DOCOS-1A). The page is drawn once more in its Reading view inside `.print-root`, a container that is
// hidden on screen and is the only thing the print rules in App.css show. When everything in it has drawn, Rust asks
// where to save and has the webview print itself (`page_export_pdf`). One export runs at a time, drawn by `PrintHost`
// beside the shell, so a second export cannot add its page to the first one's PDF and switching tabs does not take the
// copy away (Codex review of f38e4c3, P1 and P2).
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { treeQuery } from "../../documents/io";
import { classify } from "../../lib/errors";
import { exportPagePdf, isLoose } from "../../lib/opens";
import { fileName } from "../../lib/notebooks";
import { toast } from "../../ui/toast";
import type { EmbedPage } from "../editor/rich/context";
import { PageView, type Follow, type Pictures } from "./PageView";

/** The tab the palette asked to export; the tab itself starts the export, since only it has the page's pictures and
 *  embeds. */
export const usePrintIntent = create<{ tabId: string | null; request: (tabId: string) => void; clear: () => void }>((set) => ({
  tabId: null,
  request: (tabId) => set({ tabId }),
  clear: () => set({ tabId: null }),
}));

/** One page to export, as the tab had it when the export started. */
export interface PrintJob {
  text: string; tabId: string; path: string; onLink: Follow;
  pictures?: Pictures; embed?: (target: string) => Promise<EmbedPage | null>;
}

let jobs = 0;
export const usePrintJob = create<{ job: (PrintJob & { id: number }) | null }>(() => ({ job: null }));

/** Start exporting `job`; false while another export is still running. */
export function startPrint(job: PrintJob): boolean {
  if (usePrintJob.getState().job) return false;
  usePrintJob.setState({ job: { ...job, id: ++jobs } });
  return true;
}

/** How long the page may take to draw before the export gives up. */
const DRAW_LIMIT = 20_000;
const POLL = 100;

/** What inside `root` has not finished drawing yet, or null when everything has. */
export function stillDrawing(root: ParentNode): string | null {
  const muted = [...root.querySelectorAll("p.muted")].map((p) => p.textContent);
  if (muted.includes("Loading…")) return "an embedded page";
  if (muted.includes("Running the query…")) return "a query";
  // A diagram shows its source until it has drawn; one that cannot be drawn shows a note after the source.
  for (const code of root.querySelectorAll("pre > code.language-mermaid")) {
    if (!code.parentElement!.nextElementSibling?.classList.contains("muted")) return "a diagram";
  }
  // KaTeX draws TeX it cannot read as `.katex-error`, which Reading view shows too (Codex review of f38e4c3, P2).
  for (const math of root.querySelectorAll(".math-inline, .math-display")) {
    if (!math.querySelector(".katex, .katex-error")) return "math";
  }
  for (const img of root.querySelectorAll("img")) {
    if (!img.complete) return "a picture";
  }
  return null;
}

/** Resolve when everything in `root` has drawn and the fonts are loaded; reject after `limit` milliseconds. */
export function whenRendered(root: ParentNode, limit = DRAW_LIMIT): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const waiting = stillDrawing(root);
      if (!waiting) {
        (document.fonts?.ready ?? Promise.resolve()).then(() => resolve(), () => resolve());
      } else if (Date.now() - started >= limit) {
        reject(new Error(`The page did not finish drawing (${waiting}), so it was not exported`));
      } else {
        setTimeout(check, POLL);
      }
    };
    check();
  });
}

/** The file name the save dialog suggests: the page's name with `.pdf`. */
export const pdfName = (path: string) => `${(path.split(/[\\/]/).pop() ?? "Page").replace(/\.(md|markdown)$/i, "")}.pdf`;

/** Draw the page for print, export it once it has drawn, then call `onDone`. */
function PrintPage({ text, tabId, path, onLink, pictures, embed, onDone }: PrintJob & { onDone: () => void }) {
  const client = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  // Once per mount, though StrictMode runs effects twice.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !root.current) return;
    started.current = true;
    whenRendered(root.current)
      .then(() => exportPagePdf(pdfName(path)))
      .then((saved) => {
        if (!saved) return;
        // Hivemind's own writes do not reach the watcher, so a PDF saved into a notebook is shown in its tree here
        // (Codex review of f38e4c3, P3).
        if (!isLoose(saved)) void client.invalidateQueries({ queryKey: treeQuery(saved.notebook).queryKey });
        toast(`Saved ${fileName(saved.path)}`);
      })
      .catch((e) => toast(classify(e).message, "error"))
      .finally(onDone);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // White paper, so diagrams and code draw in their light colours whatever the theme.
  return createPortal(
    <div className="print-root" data-paper ref={root}>
      <PageView text={text} tabId={`print-${tabId}`} onLink={onLink} pictures={pictures} embed={embed} eager />
    </div>,
    document.body,
  );
}

/** Draws the export in progress, if any. Mounted once, beside the shell. */
export function PrintHost() {
  const job = usePrintJob((s) => s.job);
  if (!job) return null;
  const { id, ...rest } = job;
  return <PrintPage key={id} {...rest} onDone={() => usePrintJob.setState({ job: null })} />;
}
