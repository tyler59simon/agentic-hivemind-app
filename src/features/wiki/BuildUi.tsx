// The agent-written wiki's build, as the Wiki page shows it: the confirm dialog (a dry run's calls and budget cap), the progress strip
// with Cancel, and the empty state of a domain with no edition yet.
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Square } from "lucide-react";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { Modal } from "../../ui/Modal";
import { cancelWikiBuild, useWikiBuild } from "./build";
import { agentPlanQuery } from "./useWiki";
import { callsNote, callsText, usd } from "./wiki";

/** Shows what a build would do, and starts it on Build or Refresh. Asking again with Restructure checked shows the dearer plan. */
export function BuildDialog({ domain, project, hasEdition, onStart, onClose }: {
  domain: string; project: string; hasEdition: boolean; onStart: (restructure: boolean) => void; onClose: () => void;
}) {
  const [restructure, setRestructure] = useState(false);
  const plan = useQuery(agentPlanQuery(domain, project, restructure));
  const p = plan.data;
  const verb = hasEdition ? "Refresh" : "Build";
  return (
    <Modal title={`${verb} the agent-written wiki`} onClose={onClose}>
      {plan.isLoading && <p className="muted">Checking what the build would do…</p>}
      {plan.error && <p className="error">{classify(plan.error).message}</p>}
      {p && (
        <>
          <p>
            Claude ({p.model}) reads {p.notes} {p.notes === 1 ? "note" : "notes"} of {project ? <>the <b>{project}</b> project</> : <>the <b>{domain}</b> domain</>} and
            writes the pages. This makes {callsText(p)}.{callsNote(p) && ` ${callsNote(p)}`} It stops when it has spent {usd(p.budget_usd)}, keeps the pages it finished, and the next build continues from there.
          </p>
          <p className="muted small">Each call is billed to your Claude account. Nothing is sent until you start.</p>
        </>
      )}
      {hasEdition && (
        <label className="check">
          <input type="checkbox" checked={restructure} onChange={(e) => setRestructure(e.target.checked)} />
          Restructure: plan the sections and pages again
        </label>
      )}
      {hasEdition && <p className="muted small">Without it, the outline stays and only pages whose sources changed are rewritten; new notes are placed in it.</p>}
      <div className="actions">
        <button onClick={onClose}>Cancel</button>
        <button className="primary" autoFocus disabled={!p} onClick={() => onStart(restructure)}>{verb}</button>
      </div>
    </Modal>
  );
}

/** The running build: calls done of the total, the cost so far, the page being written, and Cancel. */
export function BuildStrip() {
  const { running, progress, cancelling } = useWikiBuild();
  if (!running) return null;
  const known = progress?.total != null && progress.total > 0;
  const pct = known ? Math.min(100, Math.round((100 * progress!.done) / progress!.total!)) : 0;
  return (
    <div className="wiki-build" role="status">
      <span>
        Building the {running.project ? `${running.project} project of the ` : ""}{running.domain} wiki
        {progress ? `: ${progress.done}${progress.total != null ? ` of ${progress.total}` : ""} calls done, ${usd(progress.cost)} so far` : "…"}
      </span>
      {known && <span className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress!.total!} aria-valuenow={progress!.done}><span style={{ width: `${pct}%` }} /></span>}
      {progress?.title && <span className="wiki-build-title">{progress.title}</span>}
      <span className="fill" />
      <button onClick={cancelWikiBuild} disabled={cancelling}><Square size="1em" aria-hidden />{cancelling ? "Cancelling…" : "Cancel"}</button>
    </div>
  );
}

/** A domain (or project) with no agent-written edition yet. */
export function EmptyEdition({ domain, project, onBuild, busy, blocked }: { domain: string; project: string; onBuild: () => void; busy: boolean; blocked: string | null }) {
  return (
    <div className="wiki-empty">
      <BookOpen size="1.6em" aria-hidden />
      <h2>No agent-written wiki yet</h2>
      <p className="muted">
        An agent reads the notes of {project ? <>the <b>{project}</b> project</> : <>the <b>{domain}</b> domain</>}, chooses the sections that fit them,
        and writes one page per topic from several notes, citing each one. The structured wiki stays as it is.
      </p>
      <button className="primary" onClick={onBuild} disabled={busy || !!blocked} title={blocked ?? undefined}>Build the wiki…</button>
      {blocked && <p className="muted small">{blocked}</p>}
    </div>
  );
}
