// Edits agents staged for a notebook page (`alm doc propose`, NS-2C; `doc propose --file` for a folder notebook, CON-9). The user
// reads each as a diff against the page as it is now, then accepts, merges by hand or rejects it. Agents can only propose.
// `ProposalDetail` is one proposal's diff and decisions: the notebook's modal below and the Inbox's Pages group both use it.
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { lmContainer, pageBody, pageText, readFolderPage, readPage } from "../../documents/adapters/lmdoc";
import { isMissing } from "../../documents/store";
import { onFilesChanged } from "../../documents/sync";
import { useAcceptEditedEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { historySnapshot } from "../../lib/history";
import {
  decodeBase, docAccept, docAcceptEdited, docHistory, docProposal, docReject, docVersion, LmError, proposalsQuery,
  type DocNotebook, type DocProposal, type DocProposalRow,
} from "../../lib/lm";
import { notebooksQuery, readFile, type Loaded as Page, type Notebook } from "../../lib/notebooks";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { PageMergeDialog } from "../editor/MergeDialog";
import { CodeDiff } from "../review/CodeDiff";
import { openPage } from "./actions";
import { notebookForFolder } from "./reach";

/** A proposal with the page as it is now (null when there is no such page), both read the way the editor reads a page:
 *  LF text, the format a save writes back, and why it could not be saved unchanged (Codex review of 32fee20, D2). `nb` is
 *  Hivemind's notebook for a folder proposal's folder, null for a store notebook's proposal or a folder Hivemind does not have. */
export interface Loaded { proposal: DocProposal; page: Page | null; proposed: ReturnType<typeof pageText>; nb: Notebook | null }

/** A page that is not there: `readPage` and `readFolderPage` say so as "no page ...: it does not exist", the file service as its own error. */
const gone = isMissing;

/** A folder proposal's page is read by Hivemind's own file service when it has the folder as a notebook, else through Living Memory. */
async function loadOne(id: string, client: QueryClient, orphaned = false): Promise<Loaded> {
  const proposal = await docProposal(id);
  const nb = proposal.folder ? notebookForFolder(await client.fetchQuery({ ...notebooksQuery(), staleTime: 30_000 }), proposal.folder) : null;
  const reading = !proposal.folder ? readPage(proposal, proposal.path)
    : orphaned ? Promise.resolve(null)
    : nb ? readFile(nb.id, proposal.path)
    : readFolderPage(`${proposal.folder.replace(/[\\/]+$/, "")}/${proposal.path}`);
  const page = await reading.catch((e) => { if (gone(e)) return null; throw e; });
  return { proposal, page, proposed: pageText(proposal.body), nb };
}

/** Where a page proposal lands, as the Inbox says it: a store notebook as `domain / notebook`, a folder notebook by the title of
 *  Hivemind's notebook for the folder or else the folder's own name (its `nb-` id means nothing to the user). */
export function proposalWhere(row: Pick<DocProposalRow, "domain" | "notebook" | "folder">, notebooks: Pick<Notebook, "path" | "title">[]): { short: string; long: string } {
  if (!row.folder) return { short: row.notebook, long: `${row.domain} / ${row.notebook}` };
  const name = notebookForFolder(notebooks, row.folder)?.title ?? (row.folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || row.folder);
  return { short: name, long: name };
}

/** The page as the agent read it: the version the operation that left it at the proposal's base revision wrote. Null
 *  when retention has removed that operation, or the proposal is for a new page. */
export async function baseText(p: DocProposal): Promise<string | null> {
  if (!p.base_revision) return "";
  if (p.folder) return p.base != null ? decodeBase(p.base) : null;   // the proposal kept the page as it read it; none kept (over 1 MiB): the merge uses the page as it is
  const rows = await docHistory(p.domain, p.notebook, p.path, 200).catch(() => []);
  const op = rows.find((r) => r.after_revision === p.base_revision)?.operation_id;
  if (!op) return null;
  return docVersion(p.domain, p.notebook, p.path, op).then((v) => v.text, () => null);
}

/** Whether the page moved on since the agent read it. */
export const isStale = ({ proposal, page }: Pick<Loaded, "proposal" | "page">) => (page?.sha256 ?? null) !== (proposal.base_revision ?? null);

/** Why a merge could not be written without changing bytes the merge dialog does not show, or null: a page holding bytes
 *  that are not UTF-8, or a page or proposal that mixes line endings. Accept still writes the agent's text as it is. */
export function unmergeable({ page, proposed }: Pick<Loaded, "page" | "proposed">): string | null {
  if (page?.readOnly) return page.readOnly;
  if (page && page.format.encoding !== "UTF-8") return `This page is encoded as ${page.format.encoding}, not UTF-8`;
  return proposed.readOnly ? "The proposed text mixes line-ending styles" : null;
}

/** The bytes a merge writes: the page's own line endings and byte order mark, or the proposal's for a new page (D5). */
export const mergedBody = (text: string, { page, proposed }: Pick<Loaded, "page" | "proposed">) => pageBody(text, (page ?? proposed).format);

export const age = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

const stale = (e: unknown) => e instanceof LmError && e.stale;

/** One proposal as the user decides it: the page it would change as a diff, and Accept, merge or Reject. `onSettled` runs
 *  once the proposal is accepted, merged or rejected; `onBusy` says when a decision is being written. */
export function ProposalDetail({ row, onSettled, onBusy }: { row: DocProposalRow; onSettled: () => void; onBusy?: (busy: boolean) => void }) {
  const client = useQueryClient();
  const one = useQuery({ queryKey: ["lm-proposal", row.id, !!row.orphaned], queryFn: () => loadOne(row.id, client, !!row.orphaned), gcTime: 0 });
  const canMerge = useAcceptEditedEnabled();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const loaded = one.data;
  // The notebook the page opens in: a store notebook's container, or Hivemind's notebook for the folder (none when it has none).
  const container = row.folder ? loaded?.nb?.id ?? null : lmContainer(row.domain, row.notebook);
  const orphaned = !!row.orphaned;
  const blocked = loaded && (unmergeable(loaded) ?? (canMerge ? null : "Merging needs a newer Living Memory (with proposals accept --edited)"));

  const settled = (text: string) => {
    toast(text);
    setRejecting(false);
    for (const key of [["lm-proposals"], ["lm-notebooks"], ["notebook-tree", container]]) client.invalidateQueries({ queryKey: key });
    onSettled();
  };
  /** Living Memory writes a folder notebook's page itself, outside Hivemind's save path, so its file history is kept here: the page as it
   *  is before the write (`disk`; when that cannot be kept nothing is written) and as it is after (`agent`), then open tabs read it again. */
  const written = async ({ proposal, page, nb }: Loaded, write: () => Promise<unknown>) => {
    const where = proposal.folder && nb ? { notebook: nb.id, path: proposal.path } : null;
    if (where) await historySnapshot(where.notebook, where.path, page?.sha256 ?? null, "disk");
    await write();
    if (where) {
      await historySnapshot(where.notebook, where.path, null, "agent").catch(() => null);
      client.invalidateQueries({ queryKey: ["file-history", where.notebook, where.path] });
      onFilesChanged(client, { notebook: where.notebook, paths: [where.path] });
    }
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    onBusy?.(true);
    try { await work(); } catch (e) { toast(classify(e).message, "error"); } finally { setBusy(false); onBusy?.(false); }
  };

  const accept = (loaded: Loaded) => run(async () => {
    try {
      await written(loaded, () => docAccept(loaded.proposal.id));
    } catch (e) {
      if (!stale(e)) throw e;
      // The page moved on since this view was read: show it as it is now, where the edit can be merged (U1).
      await one.refetch();
      toast("The page changed after the agent read it, so the edit was not applied. Merge it into the page as it is now.", "warn");
      return;
    }
    settled(`Accepted the edit to ${loaded.proposal.path}.`);
  });

  /** Merge the proposal into the page as it is now. Living Memory writes the result and settles the proposal in one
   *  operation, against the revision shown; when that fails the dialog stays open with the merge in it (D3). */
  const merge = (loaded: Loaded) => run(async () => {
    const { proposal, page, proposed } = loaded;
    const base = (await baseText(proposal)) ?? page?.text ?? "";
    setDialog(
      <PageMergeDialog noun="proposal" base={pageText(base).text} mine={page?.text ?? ""} theirs={proposed.text}
        onCancel={() => setDialog(null)}
        onResolve={(text) => void run(async () => {
          try {
            await written(loaded, () => docAcceptEdited(proposal.id, mergedBody(text, loaded), page?.sha256 ?? null));
          } catch (e) {
            if (!stale(e)) throw e;
            void one.refetch();
            toast("The page changed while you merged, so nothing was saved. Your merge is still here: copy what you need, cancel, and merge again.", "warn");
            return;
          }
          setDialog(null);
          settled(`Saved your merge of ${proposal.path}.`);
        })} />,
    );
  });

  const reject = (reason: string) => run(async () => {
    await docReject(row.id, reason.trim() || undefined);
    settled(`Rejected the edit to ${row.path}.`);
  });

  return (
    <>
      {one.isLoading && <p className="muted small">Loading…</p>}
      {one.error && <p className="error small">{classify(one.error).message}</p>}
      {loaded && (
        <>
          <p className="muted small">Proposed by session {loaded.proposal.session ?? "unknown"}.</p>
          {!orphaned && isStale(loaded) && (
            <p className="banner warn small">
              {loaded.page ? "The page changed after the agent read it" : "The page the agent edited is gone"}, so the edit cannot be applied as it is. Merge it into the page as it is now.
            </p>
          )}
          {orphaned && <p className="banner warn small">Living Memory no longer has this folder registered, so the edit cannot be applied. Reject it.</p>}
          {blocked && !orphaned && <p className="muted small">{blocked}, so Hivemind does not merge it here. Accept or reject it, or open the page.</p>}
          <div className="proposal-diff"><CodeDiff path={row.path} base={loaded.page?.text ?? ""} head={loaded.proposed.text} /></div>
          {rejecting ? (
            <div className="actions">
              <input autoFocus placeholder="Reason (optional)" aria-label="Reason for rejecting" id={`reason-${row.id}`}
                onKeyDown={(e) => { if (e.key === "Enter") void reject(e.currentTarget.value); else if (e.key === "Escape") setRejecting(false); }} />
              <button onClick={() => setRejecting(false)} disabled={busy}>Cancel</button>
              <button className="danger" disabled={busy}
                onClick={() => void reject((document.getElementById(`reason-${row.id}`) as HTMLInputElement | null)?.value ?? "")}>Reject</button>
            </div>
          ) : (
            <div className="actions">
              {loaded.page && container && <button className="ghost" onClick={() => openPage({ notebook: container, path: row.path })}>Open page</button>}
              <span className="fill" />
              <button className="danger-text ghost" onClick={() => setRejecting(true)} disabled={busy}>Reject…</button>
              {!blocked && !orphaned && <button onClick={() => void merge(loaded)} disabled={busy}>{isStale(loaded) ? "Merge…" : "Edit, then accept…"}</button>}
              {!isStale(loaded) && !orphaned && <button className="primary" onClick={() => void accept(loaded)} disabled={busy}>Accept</button>}
            </div>
          )}
        </>
      )}
      {dialog}
    </>
  );
}

export function ProposalInbox({ nb, onClose }: { nb: DocNotebook; onClose: () => void }) {
  const list = useQuery(proposalsQuery(nb.domain, nb.notebook));
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = (list.data ?? []).filter((p) => p.status === "pending");

  return (
    <Modal title={`Agent proposals · ${nb.title}`} onClose={onClose} locked={busy} wide>
      {list.isLoading && <p className="muted">Loading proposals…</p>}
      {list.error && <p className="error">{classify(list.error).message}</p>}
      {list.data && !pending.length && <p className="muted">No edits are waiting. Agents propose with <code>alm doc propose</code>; you decide here.</p>}
      <div className="form">
        {pending.map((row) => {
          const open = selected === row.id;
          return (
            <div key={row.id} className="proposal">
              <div className="note-top">
                <button className="link" onClick={() => setSelected(open ? null : row.id)} aria-expanded={open}><b>{row.path}</b></button>
                <span className="muted small">{row.base_revision ? "edit" : "new page"} · {age(row.created)}</span>
              </div>
              {row.note && <p className="small">{row.note}</p>}
              {open && <ProposalDetail row={row} onSettled={() => setSelected(null)} onBusy={setBusy} />}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
