// The right pane for one session: the selected file's diff, or what stands in for it.
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { reviewBase, reviewFile, type FileChange, type SessionInfo } from "../../lib/agent";
import { classify } from "../../lib/errors";
import { openSession } from "../../store";
import { ArrowLink } from "../../ui/Page";
import { CodeDiff } from "./CodeDiff";
import { baseName, reviewVersion, sessionHeading } from "./review";

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
    </div>
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
