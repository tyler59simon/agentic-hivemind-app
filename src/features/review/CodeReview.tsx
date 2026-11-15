// The right pane for one session: the selected file's diff, or what stands in for it.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Ellipsis, GitBranch, LoaderCircle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  agentSession, reviewApprove, reviewBase, reviewDiscard, reviewDismiss, reviewFile, reviewRequestChanges, reviewRequestTerminalChanges, reviewStopAndApprove, reviewToolOutput, type FileChange, type SessionInfo,
} from "../../lib/agent";
import { classify } from "../../lib/errors";
import { openSession } from "../../store";
import { Menu } from "../../ui/Menu";
import { Confirm, Modal } from "../../ui/Modal";
import { ArrowLink } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { isEnded, repoName } from "../agents/session";
import { tabLabel } from "../terminal/tabs";
import { CodeDiff } from "./CodeDiff";
import { baseName, directBase, DIRECT_NOTE, EARLIER_NOTE, filesWord, NOT_GIT_NOTE, reviewActions, reviewVersion, sessionHeading } from "./review";
import { validation, type Check } from "./validation";

/** The selected file of a session: its diff and what the agent ran to check its work. */
export function FilePane({ info, file }: { info: SessionInfo; file: FileChange }) {
  const contents = useQuery({
    queryKey: ["agent", "review-file", info.id, file.path, reviewVersion(info)],
    // Not cached for good: a hand edit that keeps the line counts leaves reviewVersion unchanged, and the pane must show
    // what approving would commit. Equal contents keep their identity, so the diff is not rebuilt.
    queryFn: () => reviewFile(info.id, file.path), staleTime: 0, retry: false,
  });
  const tree = info.worktree;
  const direct = info.direct;
  const c = contents.data;
  return (
    <div className="review-pane">
      <h2 title={file.path}>{baseName(file.path)}</h2>
      <div className="review-meta">
        <GitBranch size="1.1em" aria-hidden />
        {tree && <span>{tree.branch} • Base {reviewBase(tree).slice(0, 7)}</span>}
        {direct && <span title={direct.path}>{repoName(direct.path)} • Your own files</span>}
        <span className="fill" />
        {file.binary ? <span className="muted">binary</span> : <><span className="num-add">+{file.added}</span><span className="num-del">−{file.removed}</span></>}
      </div>
      {direct && <p className="muted small">{DIRECT_NOTE}{directBase(info) === "head" && ` ${EARLIER_NOTE}`}</p>}
      {contents.isLoading ? <p className="muted">Loading diff…</p>
        : contents.error ? <p className="error">{classify(contents.error).message}</p>
        : c?.binary ? <p className="muted">This is a binary file. Hivemind does not show binary changes.</p>
        : c?.tooLarge ? <p className="muted">This file is larger than 2 MB. Open it in your editor to review it: <code>{`${tree?.path ?? direct?.path ?? ""}/${file.path}`}</code></p>
        : c && (
          <>
            {c.head === null && <p className="muted small">This file was deleted.</p>}
            <CodeDiff path={file.path} base={c.base ?? ""} head={c.head ?? ""} />
          </>
        )}
      <Validation info={info} />
    </div>
  );
}

/** The output of one check, read in full from the session's log. */
function OutputDialog({ info, check, onClose }: { info: SessionInfo; check: Check; onClose: () => void }) {
  const output = useQuery({
    queryKey: ["agent", "tool-output", info.id, check.id], queryFn: () => reviewToolOutput(info.id, check.id), staleTime: Infinity, retry: false,
  });
  return (
    <Modal title={check.kind === "test" ? "Test output" : "Build output"} wide onClose={onClose}>
      <code>{check.command}</code>
      {output.isLoading ? <p className="muted">Loading…</p>
        : output.error ? <p className="error">{classify(output.error).message}</p>
        : output.data && (
          <>
            {output.data.truncated && <p className="muted small">Only the end of the output is shown.</p>}
            <pre className="tool-output">{output.data.text}</pre>
          </>
        )}
    </Modal>
  );
}

/** What the agent ran to check its work, and what is missing. */
function Validation({ info }: { info: SessionInfo }) {
  const [open, setOpen] = useState<Check | null>(null);
  const events = useQuery({
    queryKey: ["agent", "review-events", info.id, reviewVersion(info)], queryFn: () => agentSession(info.id, 0), staleTime: Infinity, retry: false,
  });
  const result = events.data ? validation(events.data.events, (info.filesChanged?.files ?? 0) > 0) : null;
  const latest = result && (result.checks.filter((c) => c.kind === "test").pop() ?? result.checks[result.checks.length - 1]);
  return (
    <section className="validation">
      <div className="section-head">
        <h2>Validation</h2>
        <span className="fill" />
        {latest && <ArrowLink onClick={() => setOpen(latest)}>View test output</ArrowLink>}
      </div>
      {events.isLoading ? <p className="muted">Loading…</p>
        : events.error ? <p className="error small">{classify(events.error).message}</p>
        : result && (
          <>
            {result.checks.map((c) => {
              const outcome = { passed: "Passed", failed: "Failed", running: "Running" }[c.outcome];
              const props = { size: "1.3em", "aria-label": outcome };
              return (
                <button key={c.id} className={`validation-row ${c.outcome}`} onClick={() => setOpen(c)}>
                  {c.outcome === "passed" ? <CircleCheck {...props} /> : c.outcome === "failed" ? <CircleX {...props} /> : <LoaderCircle className="spin" {...props} />}
                  <span>Agent ran <code>{c.command}</code>: {c.outcome === "running" ? "still running" : c.outcome}</span>
                </button>
              );
            })}
            {result.warning && <div className="validation-row warn"><TriangleAlert size="1.3em" aria-hidden /><span>{result.warning}</span></div>}
            {!result.checks.length && !result.warning && <p className="muted">Nothing to validate.</p>}
          </>
        )}
      {open && <OutputDialog info={info} check={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** What stands in for the diff when a session has no file selected: its state, or that nothing is left to review. */
export function SessionPane({ info }: { info: SessionInfo }) {
  return (
    <div className="review-pane">
      <h2>{sessionHeading(info)}</h2>
      <p>
        {info.review?.state === "approved"
          ? `Approved. The edits are commit ${(info.review.commit ?? "").slice(0, 7)} on ${info.worktree?.branch ?? "its branch"}.`
          : directBase(info) === "none" ? NOT_GIT_NOTE
          : "This session has no proposed edits."}
      </p>
      <div><ArrowLink onClick={() => openSession(info.id)}>Open session</ArrowLink></div>
    </div>
  );
}

const BUSY = "The session is still working. Wait for the turn to finish, or stop it first.";

/** "3 files proposed · Waiting for your review", the standing warning, and the decisions. */
export function ReviewBar({ info, files, title, onDecided }: { info: SessionInfo; files: number; title: string; onDecided: () => void }) {
  const client = useQueryClient();
  const [dialog, setDialog] = useState<"approve" | "request" | "discard" | null>(null);
  const [message, setMessage] = useState("");
  const [text, setText] = useState("");
  const branch = info.worktree?.branch ?? "its branch";
  const actions = reviewActions(info);
  const sessionsChanged = () => client.invalidateQueries({ queryKey: ["agent", "sessions"] });
  const terminal = info.interface === "terminal";
  const approve = useMutation({
    mutationFn: () => (actions.stopAndApprove ? reviewStopAndApprove(info.id, message) : reviewApprove(info.id, message)),
    onSuccess: (sha) => { setDialog(null); sessionsChanged(); toast(`Committed ${sha.slice(0, 7)} on ${branch}`); onDecided(); },
  });
  const request = useMutation({
    mutationFn: () => (terminal ? reviewRequestTerminalChanges(info.id, text) : reviewRequestChanges(info.id, text)),
    onSuccess: () => {
      setDialog(null); setText(""); sessionsChanged();
      if (terminal) toast("Sent your feedback; the terminal is working on it", "info", { label: "Open terminal", run: () => openSession(info.id) });
      else toast("Sent to the session");
    },
  });
  const dismiss = useMutation({
    mutationFn: () => reviewDismiss(info.id),
    onSuccess: () => { sessionsChanged(); toast(info.direct ? "Dismissed. The edits stay in your files." : "Dismissed. The edits stay in the session's worktree."); onDecided(); },
    onError: (e) => toast(classify(e).message, "error"),
  });
  const discard = useMutation({
    mutationFn: () => reviewDiscard(info.id),
    onSuccess: () => { sessionsChanged(); toast("Edits discarded"); onDecided(); },
    onError: (e) => toast(classify(e).message, "error"),
  });

  const working = info.status === "running" || info.status === "waiting";
  const state = info.review?.state;
  // A running terminal session can be stopped, so it does not block Stop and approve or Request changes.
  const stoppable = actions.stopAndApprove;
  const pending = approve.isPending || request.isPending || dismiss.isPending || discard.isPending;
  const off = working || approve.isPending || request.isPending || dismiss.isPending || discard.isPending;
  const ended = isEnded(info);
  const decide = files > 0;
  const first = working || decide
    ? <><strong>{filesWord(files)} proposed</strong> · {working ? "The agent is working" : state === "changes_requested" ? "Changes requested" : state === "dismissed" ? "Dismissed" : "Waiting for your review"}</>
    : state === "approved" ? <><strong>Approved</strong> · commit {(info.review?.commit ?? "").slice(0, 7)} on {branch}</>
    : <strong>No proposed edits</strong>;
  const why = working ? BUSY : undefined;

  return (
    <footer className="review-bar">
      <div className="review-bar-text">
        <span>{first}</span>
        <span className="review-warning">
          <TriangleAlert size="1.2em" aria-hidden />
          {info.direct ? (directBase(info) === "none" ? NOT_GIT_NOTE : DIRECT_NOTE) : "Reviewing code does not mark the change complete."}
        </span>
      </div>
      {decide && (
        <>
          {actions.approve && <button className="primary big" disabled={off} title={why} onClick={() => { approve.reset(); setMessage(title); setDialog("approve"); }}>Approve proposed edits</button>}
          {actions.stopAndApprove && <button className="primary big" disabled={pending} onClick={() => { approve.reset(); setMessage(title); setDialog("approve"); }}>Stop and approve</button>}
          {actions.requestChanges && <button className="outline" disabled={(off && !stoppable) || pending || (ended && !terminal)} title={(stoppable ? undefined : why) ?? (ended && !terminal ? "This session has ended. Start a new session to continue." : undefined)}
            onClick={() => { request.reset(); setDialog("request"); }}>Request changes</button>}
          {actions.dismiss && state !== "dismissed" && <button className="text" disabled={off} title={why} onClick={() => dismiss.mutate()}>{dismiss.isPending ? "Dismissing…" : "Dismiss"}</button>}
          {actions.discard && (
            <Menu label="More review actions" up align="right" className="icon-menu" button={<Ellipsis size="1.3em" aria-hidden />}>
              {(close) => <li role="none"><button role="menuitem" className="danger-text" disabled={off} title={why} onClick={() => { close(); setDialog("discard"); }}>Discard edits…</button></li>}
            </Menu>
          )}
        </>
      )}
      {dialog === "approve" && (
        <Modal title={stoppable ? "Stop and approve" : "Approve proposed edits"} locked={approve.isPending} onClose={() => setDialog(null)}>
          {stoppable && <p>Stop {tabLabel(info)} and approve its changes?</p>}
          <p>This commits {filesWord(files)} on <code>{branch}</code>. It does not merge or push, and it does not mark the change complete.</p>
          <label className="field">Commit message
            <textarea className="review-message" autoFocus value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          {approve.error && <p className="error">{classify(approve.error).message}</p>}
          <div className="actions">
            <button onClick={() => setDialog(null)} disabled={approve.isPending}>Cancel</button>
            <button className="primary" disabled={!message.trim() || approve.isPending} onClick={() => approve.mutate()}>{approve.isPending ? (stoppable ? "Stopping…" : "Committing…") : stoppable ? "Stop and commit edits" : "Commit edits"}</button>
          </div>
        </Modal>
      )}
      {dialog === "request" && (
        <Modal title="Request changes" locked={request.isPending} onClose={() => setDialog(null)}>
          <p>{terminal
            ? "Your comments are saved to a file. The program is stopped if it runs, then continues its conversation and reads the file."
            : "Your message is sent to the session as its next prompt."}</p>
          <textarea className="review-message" autoFocus placeholder="What should change?" aria-label="What should change?" value={text} onChange={(e) => setText(e.target.value)} />
          {request.error && <p className="error">{classify(request.error).message}</p>}
          <div className="actions">
            <button onClick={() => setDialog(null)} disabled={request.isPending}>Cancel</button>
            <button className="primary" disabled={!text.trim() || request.isPending} onClick={() => request.mutate()}>{request.isPending ? "Sending…" : terminal ? "Send to terminal" : "Send to session"}</button>
          </div>
        </Modal>
      )}
      {dialog === "discard" && info.worktree && (
        <Confirm title="Discard this session's edits?" action="Discard edits" danger
          message={`This resets the session's worktree to commit ${reviewBase(info.worktree).slice(0, 7)} and deletes the files the agent created. It cannot be undone.`}
          onAnswer={(yes) => { setDialog(null); if (yes) discard.mutate(); }} />
      )}
    </footer>
  );
}
