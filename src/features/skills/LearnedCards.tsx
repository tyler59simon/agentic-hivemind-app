// The Inbox's draft items: a memory draft in Living Memory's proposal inbox, and a skill proposal.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { proposalAccept, proposalAcceptWith, proposalReject, proposalShow, taxonomy, type MemoryProposal } from "../../lib/lm";
import { skillDecide, skillVersion, type ReviewRun, type SkillProposal } from "../../lib/skills";
import { openSession, openSkills } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { ArrowLink } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { CodeDiff } from "../review/CodeDiff";
import { parse, proposalTitle } from "./skills";

/** Who staged a memory draft: a Hivemind review (with its session), or an agent during a session. */
function Source({ run }: { run?: ReviewRun }) {
  if (!run) return <p className="muted small">An agent staged this draft during a session.</p>;
  return (
    <p className="muted small">
      Hivemind's review of “{run.title}” proposed this.{" "}
      <ArrowLink onClick={() => openSession(run.session)}>Open session</ArrowLink>
    </p>
  );
}

export function MemoryProposalCard({ proposal, run, onDone }: { proposal: MemoryProposal; run?: ReviewRun; onDone: () => void }) {
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ["proposals", "show", proposal.id], queryFn: () => proposalShow(proposal.id), retry: false });
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  // Living Memory refuses a note without a concern tag it knows; then the user picks one.
  const [needsConcern, setNeedsConcern] = useState(false);
  const [concern, setConcern] = useState("");
  const tags = useQuery({ queryKey: ["taxonomy"], queryFn: taxonomy, enabled: needsConcern });
  const concerns = (tags.data?.tags ?? []).filter((t) => t.startsWith("concern/"));
  const settle = (work: Promise<unknown>, done: string) => {
    setBusy(true);
    work.then(() => {
      toast(done);
      client.invalidateQueries({ queryKey: ["proposals"] });
      onDone();
    }, (e) => {
      const message = classify(e).message;
      if (/concern\//.test(message)) setNeedsConcern(true);
      toast(message, "error");
    }).finally(() => setBusy(false));
  };
  const note = detail.data?.note;
  return (
    <>
      <h2>{proposal.title}</h2>
      <p className="muted small">{proposal.type} note for {proposal.domain}</p>
      <Source run={run} />
      {detail.isLoading && <p className="muted">Loading…</p>}
      {detail.error && <p className="error">{classify(detail.error).message}</p>}
      {note?.context && <p className="muted small">{note.context}</p>}
      {note && <div className="markdown"><Markdown>{note.body}</Markdown></div>}
      {!!detail.data?.warnings?.length && <ul className="muted small">{detail.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {needsConcern && note && (
        <div className="work-actions">
          <select aria-label="Concern" value={concern} onChange={(e) => setConcern(e.target.value)}>
            <option value="">Pick a concern tag…</option>
            {concerns.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className="primary" disabled={busy || !concern} onClick={() => settle(proposalAcceptWith(proposal.id, note, concern), "Saved to Living Memory")}>Save with this tag</button>
        </div>
      )}
      <div className="work-actions">
        <button className="primary" disabled={busy || needsConcern} onClick={() => settle(proposalAccept(proposal.id), "Saved to Living Memory")}>Save note</button>
        <input aria-label="Why reject" placeholder="Why not (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
        <button disabled={busy} onClick={() => settle(proposalReject(proposal.id, why.trim() || undefined), "Draft rejected")}>Reject</button>
      </div>
    </>
  );
}

export function SkillProposalCard({ proposal, onDone }: { proposal: SkillProposal; onDone: () => void }) {
  const client = useQueryClient();
  const [description, setDescription] = useState(proposal.description);
  const [body, setBody] = useState(proposal.body);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const base = useQuery({
    queryKey: ["skills", "version", proposal.name, proposal.baseVersion],
    queryFn: () => skillVersion(proposal.name, proposal.baseVersion!),
    enabled: proposal.kind === "patch" && proposal.baseVersion != null,
  });
  const edited = description !== proposal.description || body !== proposal.body;
  const decide = (approve: boolean) => {
    setBusy(true);
    skillDecide(proposal.id, approve, { ...(approve && edited ? { description, body } : {}), reason: approve ? undefined : why.trim() || undefined })
      .then((decided) => {
        if (decided.warning) toast(decided.warning, "error");
        else toast(approve ? (proposal.kind === "archive" ? `Archived ${proposal.name}` : `Published ${proposal.name}`) : "Proposal rejected");
        client.invalidateQueries({ queryKey: ["skills"] });
        onDone();
      }, (e) => toast(classify(e).message, "error"))
      .finally(() => setBusy(false));
  };
  const before = base.data ? parse(base.data).body : "";
  return (
    <>
      <h2>{proposalTitle(proposal)}</h2>
      <p className="muted small">
        {proposal.by === "reviewer" ? "Hivemind's reviewer" : proposal.by === "upkeep" ? "Skill upkeep" : "You"} proposed this.{" "}
        {proposal.session && <ArrowLink onClick={() => openSession(proposal.session!)}>Open the session it came from</ArrowLink>}{" "}
        <ArrowLink onClick={() => openSkills(proposal.name)}>Open Skills</ArrowLink>
      </p>
      {proposal.reason && <p>{proposal.reason}</p>}
      {proposal.kind === "archive" ? (
        <p className="muted">Archiving removes the skill from the Claude Code and Codex skill folders. Hivemind keeps every version, so you can restore it.</p>
      ) : (
        <>
          <label className="field">
            <span>Description: when should an agent use it?</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {proposal.kind === "patch" && base.data && <CodeDiff path="SKILL.md" base={before} head={body} />}
          <label className="field">
            <span>SKILL.md (needs When to use, When not to use and Steps)</span>
            <textarea rows={16} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <p className="muted small">Approving publishes it to your Claude Code and Codex skill folders, for Hivemind sessions and your own.</p>
        </>
      )}
      <div className="work-actions">
        <button className="primary" disabled={busy} onClick={() => decide(true)}>{proposal.kind === "archive" ? "Archive" : edited ? "Approve with edits" : "Approve and publish"}</button>
        <input aria-label="Why reject" placeholder="Why not (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
        <button disabled={busy} onClick={() => decide(false)}>Reject</button>
      </div>
    </>
  );
}
