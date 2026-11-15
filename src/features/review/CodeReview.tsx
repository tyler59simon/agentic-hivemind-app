// The right pane for one session: the selected file's diff, or what stands in for it.
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX, GitBranch, LoaderCircle, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { agentSession, reviewBase, reviewFile, reviewToolOutput, type FileChange, type SessionInfo } from "../../lib/agent";
import { classify } from "../../lib/errors";
import { openSession } from "../../store";
import { Modal } from "../../ui/Modal";
import { ArrowLink } from "../../ui/Page";
import { CodeDiff } from "./CodeDiff";
import { baseName, reviewVersion, sessionHeading } from "./review";
import { validation, type Check } from "./validation";

/** The selected file of a session: its diff and what the agent ran to check its work. */
export function FilePane({ info, file }: { info: SessionInfo; file: FileChange }) {
  const contents = useQuery({
    queryKey: ["agent", "review-file", info.id, file.path, reviewVersion(info)],
    queryFn: () => reviewFile(info.id, file.path), staleTime: Infinity, retry: false,
  });
  const tree = info.worktree;
  const c = contents.data;
  return (
    <div className="review-pane">
      <h2 title={file.path}>{baseName(file.path)}</h2>
      <div className="review-meta">
        <GitBranch size="1.1em" aria-hidden />
        {tree && <span>{tree.branch} • Base {reviewBase(tree).slice(0, 7)}</span>}
        <span className="fill" />
        {file.binary ? <span className="muted">binary</span> : <><span className="num-add">+{file.added}</span><span className="num-del">−{file.removed}</span></>}
      </div>
      {contents.isLoading ? <p className="muted">Loading diff…</p>
        : contents.error ? <p className="error">{classify(contents.error).message}</p>
        : c?.binary ? <p className="muted">This is a binary file. Hivemind does not show binary changes.</p>
        : c?.tooLarge ? <p className="muted">This file is larger than 2 MB. Open it in your editor to review it: <code>{`${tree?.path ?? ""}/${file.path}`}</code></p>
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
          : "This session has no proposed edits."}
      </p>
      <div><ArrowLink onClick={() => openSession(info.id)}>Open session</ArrowLink></div>
    </div>
  );
}
