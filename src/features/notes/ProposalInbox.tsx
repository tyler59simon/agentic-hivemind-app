// Edits agents staged for a Living Memory notebook (`alm doc propose`, NS-2C). The user reads each as a diff against
// the page as it is now, then accepts, merges by hand or rejects it. Agents outside Notes Studio can only propose.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { lmContainer, pageBody, pageText } from "../../documents/adapters/lmdoc";
import { classify } from "../../lib/errors";
import {
  docAccept, docCreate, docHistory, docProposal, docRead, docReject, docVersion, docWrite, LmError, proposalsQuery,
  type DocNotebook, type DocPage, type DocProposal, type DocProposalRow,
} from "../../lib/lm";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { PageMergeDialog } from "../editor/MergeDialog";
import { CodeDiff } from "../review/CodeDiff";
import { openPage } from "./actions";

/** The reason a proposal merged by hand is settled with: `doc accept` writes only the staged text. */
export const MERGED = "Merged by hand in Hivemind";

const missingPage = (e: unknown) => e instanceof LmError && /^not_found: no page/.test(e.message);

/** A proposal with the page as it is now (null for a proposed new page). */
interface Loaded { proposal: DocProposal; page: DocPage | null }

async function loadOne(id: string): Promise<Loaded> {
  const proposal = await docProposal(id);
  const page = await docRead(proposal.domain, proposal.notebook, proposal.path).catch((e) => { if (missingPage(e)) return null; throw e; });
  return { proposal, page };
}

/** The page as the agent read it: the version the operation that left it at the proposal's base revision wrote. Null
 *  when retention has removed that operation, or the proposal is for a new page. */
export async function baseText(p: DocProposal): Promise<string | null> {
  if (!p.base_revision) return "";
  const rows = await docHistory(p.domain, p.notebook, p.path, 200).catch(() => []);
  const op = rows.find((r) => r.after_revision === p.base_revision)?.operation_id;
  if (!op) return null;
  return docVersion(p.domain, p.notebook, p.path, op).then((v) => v.text, () => null);
}

/** Whether the page moved on since the agent read it. */
export const isStale = ({ proposal, page }: Loaded) => (page?.revision ?? null) !== (proposal.base_revision ?? null);

const age = (iso: string) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

export function ProposalInbox({ nb, onClose }: { nb: DocNotebook; onClose: () => void }) {
  const client = useQueryClient();
  const list = useQuery(proposalsQuery(nb.domain, nb.notebook));
  const [selected, setSelected] = useState<string | null>(null);
  const one = useQuery({ queryKey: ["lm-proposal", selected], queryFn: () => loadOne(selected!), enabled: !!selected, gcTime: 0 });
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const pending = (list.data ?? []).filter((p) => p.status === "pending");
  const container = lmContainer(nb.domain, nb.notebook);

  const settled = (text: string) => {
    toast(text);
    setSelected(null);
    setRejecting(null);
    for (const key of [["lm-proposals", nb.domain, nb.notebook], ["lm-notebooks"], ["notebook-tree", container]]) client.invalidateQueries({ queryKey: key });
  };
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); } catch (e) { toast(classify(e).message, "error"); } finally { setBusy(false); }
  };

  const accept = (loaded: Loaded) => run(async () => {
    await docAccept(loaded.proposal.id);
    settled(`Accepted the edit to ${loaded.proposal.path}.`);
  });

  /** Merge the proposal into the page as it is now, then write the result and settle the proposal. */
  const merge = (loaded: Loaded) => run(async () => {
    const { proposal, page } = loaded;
    const now = pageText(page?.text ?? "");
    const base = (await baseText(proposal)) ?? page?.text ?? "";
    setDialog(
      <PageMergeDialog base={pageText(base).text} mine={now.text} theirs={pageText(proposal.body).text}
        onCancel={() => setDialog(null)}
        onResolve={(text) => {
          setDialog(null);
          void run(async () => {
            // Written with the page's own line endings and byte order mark, against the revision shown.
            const body = page ? pageBody(text, now.format) : text;
            if (page) await docWrite(proposal.domain, proposal.notebook, proposal.path, body, page.revision);
            else await docCreate(proposal.domain, proposal.notebook, proposal.path, body);
            await docReject(proposal.id, MERGED);
            settled(`Saved your merge of ${proposal.path}.`);
          });
        }} />,
    );
  });

  const reject = (row: DocProposalRow, reason: string) => run(async () => {
    await docReject(row.id, reason.trim() || undefined);
    settled(`Rejected the edit to ${row.path}.`);
  });

  return (
    <Modal title={`Agent proposals · ${nb.title}`} onClose={onClose} locked={busy} wide>
      {list.isLoading && <p className="muted">Loading proposals…</p>}
      {list.error && <p className="error">{classify(list.error).message}</p>}
      {list.data && !pending.length && <p className="muted">No edits are waiting. Agents propose with <code>alm doc propose</code>; you decide here.</p>}
      <div className="form">
        {pending.map((row) => {
          const open = selected === row.id;
          const loaded = open ? one.data : undefined;
          return (
            <div key={row.id} className="proposal">
              <div className="note-top">
                <button className="link" onClick={() => setSelected(open ? null : row.id)} aria-expanded={open}><b>{row.path}</b></button>
                <span className="muted small">{row.base_revision ? "edit" : "new page"} · {age(row.created)}</span>
              </div>
              {row.note && <p className="small">{row.note}</p>}
              {open && one.isLoading && <p className="muted small">Loading…</p>}
              {open && one.error && <p className="error small">{classify(one.error).message}</p>}
              {loaded && (
                <>
                  <p className="muted small">Proposed by session {loaded.proposal.session ?? "unknown"}.</p>
                  {isStale(loaded) && (
                    <p className="banner warn small">
                      {loaded.page ? "The page changed after the agent read it" : "The page the agent edited is gone"}, so the edit cannot be applied as it is. Merge it into the page as it is now.
                    </p>
                  )}
                  <div className="proposal-diff"><CodeDiff path={row.path} base={loaded.page?.text ?? ""} head={loaded.proposal.body} /></div>
                  {rejecting === row.id ? (
                    <div className="actions">
                      <input autoFocus placeholder="Reason (optional)" aria-label="Reason for rejecting" id={`reason-${row.id}`}
                        onKeyDown={(e) => { if (e.key === "Enter") void reject(row, e.currentTarget.value); else if (e.key === "Escape") setRejecting(null); }} />
                      <button onClick={() => setRejecting(null)} disabled={busy}>Cancel</button>
                      <button className="danger" disabled={busy}
                        onClick={() => void reject(row, (document.getElementById(`reason-${row.id}`) as HTMLInputElement | null)?.value ?? "")}>Reject</button>
                    </div>
                  ) : (
                    <div className="actions">
                      {loaded.page && <button className="ghost" onClick={() => openPage({ notebook: container, path: row.path })}>Open page</button>}
                      <span className="fill" />
                      <button className="danger-text ghost" onClick={() => setRejecting(row.id)} disabled={busy}>Reject…</button>
                      <button onClick={() => void merge(loaded)} disabled={busy}>{isStale(loaded) ? "Merge…" : "Edit, then accept…"}</button>
                      {!isStale(loaded) && <button className="primary" onClick={() => void accept(loaded)} disabled={busy}>Accept</button>}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
      {dialog}
    </Modal>
  );
}
