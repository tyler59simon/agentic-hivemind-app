// History of a notebook page or opened file (NS-5): the History mode of its tab, and a short list in the page rail. The
// timeline merges the versions Hivemind kept at every save with the commits of the file's git repository; a Living
// Memory page shows Living Memory's own history instead. A version can be read, compared with the page as it is, and
// restored as a new version; a Hivemind version can be pinned past retention; a file in a git repository can be committed.
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitCommitHorizontal, Pin, PinOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePick } from "./pick";
import { pageText, parseLm } from "../../documents/adapters/lmdoc";
import type { FileRef } from "../../documents/keys";
import { keyOf, reload, restore, useDocuments } from "../../documents/store";
import { classify } from "../../lib/errors";
import { gitFileCommit, gitFileLog, historyList, historyPin, historyRead, type Version } from "../../lib/history";
import { docHistory, docVersion } from "../../lib/lm";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { rowDetail, rowLabel, timeline, type Row } from "./timeline";

/** The most versions the page rail lists. */
const RAIL_ROWS = 5;

const when = (time: number) => (time ? new Date(time).toLocaleString() : "unknown time");

/** The timeline of a page, and what the History mode and the rail need besides it. The queries are keyed by the page's
 *  saved version, so a save brings the new version in. */
export function useFileHistory(file: FileRef) {
  const stamp = useDocuments((s) => s.docs[keyOf(file)]?.base?.stamp.sha256);
  const lm = parseLm(file.notebook);
  const key = [file.notebook, file.path, stamp];
  const kept = useQuery({ queryKey: ["file-history", ...key], queryFn: () => historyList(file.notebook, file.path), enabled: !lm });
  const git = useQuery({ queryKey: ["file-git", ...key], queryFn: () => gitFileLog(file.notebook, file.path), enabled: !lm });
  const operations = useQuery({ queryKey: ["lm-file-history", ...key], queryFn: () => docHistory(lm!.domain, lm!.notebook, file.path, 100), enabled: !!lm });
  const rows = useMemo(() => timeline(kept.data?.entries ?? [], git.data?.commits ?? [], operations.data ?? []), [kept.data, git.data, operations.data]);
  return {
    rows,
    loading: kept.isLoading || operations.isLoading,
    // Git failing (a timeout, a broken repository) does not hide the versions Hivemind kept.
    error: kept.error ?? operations.error,
    gitError: git.error,
    tooLarge: !!kept.data?.tooLarge,
    repo: git.data?.repo ?? null,
    changed: !!git.data?.changed,
    lm: !!lm,
  };
}

/** The newest versions beside a page (the rail section adds the link to all of them). `onPick` is called with the row
 *  clicked, to open the History mode on it. */
export function HistoryRail({ file, onPick }: { file: FileRef; onPick: (id: string) => void }) {
  const { rows, loading, error, tooLarge } = useFileHistory(file);
  if (loading) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{classify(error).message}</p>;
  return (
    <>
      {tooLarge && <p className="muted small">This file is over 16 MB, so its saves are not kept.</p>}
      {!rows.length && !tooLarge && <p className="muted">No versions yet. One is kept each time you save.</p>}
      <ol className="timeline">
        {rows.slice(0, RAIL_ROWS).map((row) => (
          <li key={`${row.kind}:${row.id}`}>
            <button className="timeline-row" onClick={() => onPick(row.id)} title="Open this version in the History view">
              <strong>{when(row.time)}</strong><span>{rowLabel(row)}</span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

/** Two versions side by side, read-only: the earlier one on the left, the page as it is on the right. */
function Compare({ was, now }: { was: string; now: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frozen = [EditorView.lineWrapping, EditorState.readOnly.of(true), EditorView.editable.of(false)];
    const view = new MergeView({ parent: host.current!, a: { doc: was, extensions: frozen }, b: { doc: now, extensions: frozen }, highlightChanges: true, gutter: true });
    return () => view.destroy();
  }, [was, now]);
  return (
    <>
      <div className="merge-head"><span>This version</span><span>The page now</span></div>
      <div className="merge-host history-compare" ref={host} />
    </>
  );
}

/** The text of a version: a snapshot or commit through Rust, a Living Memory operation through Living Memory. */
async function readVersion(file: FileRef, row: Row): Promise<Version> {
  const lm = parseLm(file.notebook);
  if (!lm) return historyRead(file.notebook, file.path, row.id);
  const page = await docVersion(lm.domain, lm.notebook, file.path, row.id);
  const { text, readOnly } = pageText(page.text);
  return { text, binary: false, readOnly, size: page.size };
}

/** The commit message dialog. The file is committed alone and nothing is pushed. */
export function CommitDialog({ file, onClose, onDone }: { file: FileRef; onClose: () => void; onDone: () => void }) {
  const [message, setMessage] = useState("");
  const commit = useMutation({
    mutationFn: () => gitFileCommit(file.notebook, file.path, message),
    onSuccess: (sha) => { toast(`Committed ${sha.slice(0, 7)}. Nothing was pushed.`); onDone(); },
  });
  return (
    <Modal title="Commit this file" onClose={onClose} locked={commit.isPending}>
      <p className="muted small">Commits {file.path.split("/").pop()} only, as it is saved on disk. Other changes in the repository are left alone, and nothing is pushed.</p>
      <textarea autoFocus rows={4} placeholder="Commit message" aria-label="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} />
      {commit.error && <p className="error">{classify(commit.error).message}</p>}
      <div className="actions">
        <button onClick={onClose} disabled={commit.isPending}>Cancel</button>
        <button className="primary" disabled={!message.trim() || commit.isPending} onClick={() => commit.mutate()}>{commit.isPending ? "Committing…" : "Commit"}</button>
      </div>
    </Modal>
  );
}

/** One version, selected from the timeline: its text, and what can be done with it. */
function VersionPane({ file, row, current, state, tooLarge, onChanged }: { file: FileRef; row: Row; current: string; state: string | undefined; tooLarge: boolean; onChanged: () => void }) {
  const client = useQueryClient();
  const docKey = keyOf(file);
  const version = useQuery({ queryKey: ["file-version", file.notebook, file.path, row.id], queryFn: () => readVersion(file, row) });
  const [comparing, setComparing] = useState(false);
  const [asking, setAsking] = useState(false);
  useEffect(() => { setComparing(false); setAsking(false); }, [row.id]);
  const pin = useMutation({
    mutationFn: (pinned: boolean) => historyPin(file.notebook, file.path, (row as { number: number }).number, pinned),
    onSuccess: () => client.invalidateQueries({ queryKey: ["file-history", file.notebook, file.path] }),
    onError: (e) => toast(classify(e).message, "error"),
  });
  const run = useMutation({
    mutationFn: (text: string) => restore(docKey, text),
    onSuccess: (after) => {
      setAsking(false);
      if (after?.status === "stale") toast("This page changed on disk, so the version was not restored. Merge your changes first.", "warn");
      else if (after?.status === "clean") { toast(`Restored the version from ${when(row.time)}. The text it replaced stays in the history.`); onChanged(); }
      else if (after?.error) {
        // The restore was refused (for one, the page's current text is too large for the history to keep): the page goes
        // back to what is on disk instead of staying open with the old text as unsaved edits.
        toast(after.error, "error");
        void reload(docKey);
      }
    },
    onError: (e) => toast(classify(e).message, "error"),
  });
  if (version.isLoading) return <p className="muted">Loading this version…</p>;
  if (version.error || !version.data) return <p className="error">{classify(version.error ?? "This version could not be read").message}</p>;
  const v = version.data;
  // Unsaved edits are not in the history, so a restore over them would lose them; a read-only page takes none.
  const blocked = state !== "clean" ? (state === "readOnly" ? "This page is read-only" : "Save or discard your edits first")
    : tooLarge ? "This page is over 16 MB, so its current text cannot be kept in the history"
    : v.binary ? "This version is not a text file" : v.readOnly;
  const same = !v.binary && v.text === current;
  return (
    <div className="history-pane">
      <div className="actions">
        <button onClick={() => setComparing(!comparing)} aria-pressed={comparing} disabled={v.binary}>{comparing ? "Show the version" : "Compare with current"}</button>
        {asking
          ? (
            <>
              <span className="muted small">Replace the page with this version? The text it replaces stays in the history.</span>
              <button className="primary" disabled={run.isPending} onClick={() => run.mutate(v.text)}>Restore</button>
              <button onClick={() => setAsking(false)}>Cancel</button>
            </>
          )
          : <button className="primary" disabled={!!blocked || same} title={blocked ?? (same ? "This is the page as it is now" : undefined)} onClick={() => setAsking(true)}>Restore</button>}
        {row.kind === "snapshot" && (
          <button onClick={() => pin.mutate(!row.pinned)} disabled={pin.isPending} title={row.pinned ? "Let retention remove this version" : "Keep this version past retention"}>
            {row.pinned ? <PinOff size="1.1em" aria-hidden /> : <Pin size="1.1em" aria-hidden />}{row.pinned ? "Unpin" : "Pin"}
          </button>
        )}
      </div>
      {same && <p className="muted small">This version is the same as the page now.</p>}
      {v.readOnly && !v.binary && <p className="muted small">{v.readOnly}.</p>}
      {v.binary ? <p className="muted">This version is not a text file, so it cannot be shown.</p>
        : comparing ? <Compare was={v.text} now={current} />
        : <pre className="history-text">{v.text.length > 200_000 ? `${v.text.slice(0, 200_000)}\n… (the first 200,000 characters)` : v.text}</pre>}
    </div>
  );
}

/** The History mode of a page tab. */
export function FileHistory({ file, tabId }: { file: FileRef; tabId: string }) {
  const client = useQueryClient();
  const doc = useDocuments((s) => s.docs[keyOf(file)]);
  const { rows, loading, error, gitError, tooLarge, repo, changed, lm } = useFileHistory(file);
  const [selected, setSelected] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  // A row clicked in the rail comes here as the version to show (UI-2), once the timeline has it.
  const wanted = usePick((s) => s.picks[tabId]);
  useEffect(() => {
    if (wanted && rows.some((r) => r.id === wanted)) { setSelected(wanted); usePick.getState().clear(tabId); }
  }, [wanted, rows, tabId]);
  useEffect(() => { list.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [selected]);
  const row = rows.find((r) => r.id === selected);
  const unsaved = doc?.status === "dirty" || doc?.status === "saving" || doc?.status === "stale";
  return (
    <div className="history-wrap">
      <div className="history-view">
        <div className="history-side">
          {repo && (
            <div className="history-commit">
              <button disabled={!changed || unsaved} onClick={() => setCommitting(true)}
                title={unsaved ? "Save the page first: a commit takes the file as it is on disk" : changed ? `Commit this file in ${repo}` : "This file matches the last commit"}>
                <GitCommitHorizontal size="1.1em" aria-hidden />Commit…
              </button>
              <span className="muted small">{changed ? "Changed since the last commit" : "Matches the last commit"}</span>
            </div>
          )}
          {tooLarge && <p className="banner">This file is over 16 MB, so its saves are not kept.</p>}
          {gitError != null && <p className="muted small">Git history is not available: {classify(gitError).message}</p>}
          {loading && <p className="muted">Loading…</p>}
          {error != null && <p className="error">{classify(error).message}</p>}
          {!loading && !error && !rows.length && <p className="muted">{lm ? "Living Memory has no recorded changes to this page." : "No versions yet. One is kept each time you save."}</p>}
          <ol className="history-list" aria-label="Versions" ref={list}>
            {rows.map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <button className={r.id === selected ? "on" : ""} aria-pressed={r.id === selected} onClick={() => setSelected(r.id === selected ? null : r.id)}>
                  <strong>{rowLabel(r)}</strong>
                  <span className="muted small">{when(r.time)}</span>
                  <span className="muted small">{rowDetail(r)}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        {row
          ? <VersionPane file={file} row={row} current={doc?.text ?? ""} state={doc?.status} tooLarge={tooLarge} onChanged={() => setSelected(null)} />
          : <p className="muted history-hint">{rows.length ? "Choose a version to read it, compare it with the page or restore it." : ""}</p>}
        {committing && (
          <CommitDialog file={file} onClose={() => setCommitting(false)}
            onDone={() => { setCommitting(false); void client.invalidateQueries({ queryKey: ["file-git", file.notebook, file.path] }); }} />
        )}
      </div>
    </div>
  );
}
