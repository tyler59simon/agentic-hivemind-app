// Skills: what Hivemind has learned as procedures, where each is published, how sessions that used it went, its versions
// and history; and the post-session reviewer's recent runs and spending.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpenCheck, History, Sparkles } from "lucide-react";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { learningQuery, skillAction, skillHistory, skillProposalsQuery, skillsQuery, skillsUpkeep, type Skill } from "../../lib/skills";
import { openInbox, openSession, useApp } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { Confirm } from "../../ui/Modal";
import { ArrowLink, PageHeader, Row, Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { noteQuery } from "../viewer/NoteView";
import { useWorkspace } from "../../workspace/store";
import { COPY_WORDS, copyPlace, ledgerText, reliabilityText, runText, skillState, spendText } from "./skills";

const when = (ms: number) => new Date(ms).toLocaleString();

function NoteLink({ refId }: { refId: string }) {
  const note = useQuery(noteQuery(refId));
  const title = note.data?.title ?? refId;
  return <button className="link-row" onClick={() => useWorkspace.getState().openNote(refId, { title })}>{title}</button>;
}

function SkillDetail({ skill }: { skill: Skill }) {
  const client = useQueryClient();
  const history = useQuery({ queryKey: ["skills", "history", skill.name], queryFn: () => skillHistory(skill.name) });
  const [asking, setAsking] = useState<null | "archive" | number>(null);
  const act = (action: "archive" | "restore" | "import" | "publish", version?: number) =>
    skillAction(skill.name, action, version).then(() => {
      toast(action === "archive" ? `Archived ${skill.name}` : action === "restore" ? `Restored version ${version} of ${skill.name}` : action === "import" ? "Imported the outside edit" : "Published again");
      client.invalidateQueries({ queryKey: ["skills"] });
    }, (e) => toast(classify(e).message, "error"));
  const edited = skill.copies.some((c) => c.state === "edited");
  const state = skillState(skill);
  return (
    <div className="review-pane">
      <h2>{skill.name} <span className={`status-chip ${state.tone}`}>{state.label}</span></h2>
      <p>{skill.description}</p>
      <p className="muted small">
        Version {skill.version} · {skill.uses} use{skill.uses === 1 ? "" : "s"}{skill.lastUsed ? `, last ${when(skill.lastUsed)}` : ""} · {reliabilityText(skill)}
      </p>
      <p className="muted small">Reliability counts how the sessions that used this skill were reviewed. It shows a correlation, not that the skill caused the result.</p>
      <div className="work-actions">
        {!skill.archived && <button onClick={() => setAsking("archive")}>Archive</button>}
        {!skill.archived && !edited && skill.copies.some((c) => c.state !== "current") && <button onClick={() => act("publish")}>Publish again</button>}
        {!skill.archived && !skill.copies.length && <button onClick={() => act("publish")}>Publish</button>}
        {edited && <button className="primary" onClick={() => act("import")}>Keep the outside edit as a new version</button>}
        {skill.archived && <button className="primary" onClick={() => act("restore", skill.version)}>Restore</button>}
      </div>
      <Section title="Published copies"
        empty={skill.copies.length ? undefined : skill.archived ? "Archived: not published." : "Not published. Claude Code and Codex folders are used only when that CLI is set up."}>
        {skill.copies.map((c) => (
          <Row key={c.dir} icon={<BookOpenCheck size="1.3em" aria-hidden />} meta={COPY_WORDS[c.state]} title={c.dir}>{copyPlace(c.dir)}</Row>
        ))}
        {edited && <p className="muted small">Someone changed a published copy. Hivemind will not overwrite it: keep the edit as a new version, or restore a version to replace it.</p>}
      </Section>
      <Section title="SKILL.md"><div className="markdown"><Markdown>{skill.body}</Markdown></div></Section>
      {(!!skill.notes.length || !!skill.sessions.length) && (
        <Section title="Where it came from">
          {skill.notes.map((n) => <NoteLink key={n} refId={n} />)}
          {skill.sessions.map((s) => <ArrowLink key={s} onClick={() => openSession(s)}>Session {s.slice(0, 8)}</ArrowLink>)}
        </Section>
      )}
      <Section title="Versions">
        {[...skill.versions].reverse().map((v) => (
          <Row key={v} meta={v === skill.version ? "current" : undefined}>
            Version {v}{v !== skill.version && <> · <button className="link-row inline" onClick={() => setAsking(v)}>Restore</button></>}
          </Row>
        ))}
      </Section>
      <Section title="History" loading={history.isLoading} error={history.error} empty={history.data?.length === 0 ? "No changes recorded." : undefined}>
        {history.data?.map((e, i) => <Row key={i} icon={<History size="1.3em" aria-hidden />} meta={when(e.at)} title={e.detail ?? undefined}>{ledgerText(e)}</Row>)}
      </Section>
      {asking === "archive" && (
        <Confirm title={`Archive ${skill.name}?`} action="Archive" danger message="Hivemind removes it from the Claude Code and Codex skill folders and keeps every version, so you can restore it."
          onAnswer={(yes) => { setAsking(null); if (yes) act("archive"); }} />
      )}
      {typeof asking === "number" && (
        <Confirm title={`Restore version ${asking}?`} action="Restore" message={`Version ${asking} becomes the current version (as a new version) and is published again.`}
          onAnswer={(yes) => { const v = asking; setAsking(null); if (yes) act("restore", v); }} />
      )}
    </div>
  );
}

export function SkillsPage() {
  const client = useQueryClient();
  const picked = useApp((s) => (s.route.page === "skills" ? s.route.skill : undefined));
  const go = useApp((s) => s.go);
  const skills = useQuery(skillsQuery());
  const proposals = useQuery(skillProposalsQuery());
  const learning = useQuery(learningQuery());
  const [showArchived, setShowArchived] = useState(false);
  const list = (skills.data ?? []).filter((s) => showArchived || !s.archived);
  const selected = list.find((s) => s.name === picked) ?? list[0];
  const waiting = proposals.data?.length ?? 0;
  const upkeep = () => skillsUpkeep().then((made) => {
    toast(made.length ? `${made.length} archive proposal${made.length === 1 ? "" : "s"} added to the Inbox` : "No skill is stale or flagged");
    client.invalidateQueries({ queryKey: ["skills"] });
  }, (e) => toast(classify(e).message, "error"));
  const status = learning.data;
  return (
    <div className="page fill-page">
      <PageHeader title="Skills" subtitle="Procedures learned from approved work, published to Claude Code and Codex."
        actions={<button onClick={upkeep} title="Propose archiving skills unused for 30 days, or whose sessions are mostly rejected">Check for stale skills</button>} />
      <p className="muted small">
        {status ? (status.enabled
          ? <>The reviewer reads finished sessions and proposes notes and skills; you approve them in the Inbox. Spending: {spendText(status.spentToday, status.dailyUsd)}, at most ${status.reviewUsd.toFixed(2)} per review.</>
          : <>The post-session reviewer is off (Settings).</>) : null}
        {waiting > 0 && <> <ArrowLink onClick={() => openInbox(undefined, undefined, "skills")}>{waiting} proposal{waiting === 1 ? "" : "s"} waiting in the Inbox</ArrowLink></>}
      </p>
      <div className="review">
        <nav className="review-list" aria-label="Skills">
          {skills.isLoading && <p className="muted pad">Loading…</p>}
          {skills.error && <p className="error pad">{classify(skills.error).message}</p>}
          {!skills.isLoading && !list.length && <p className="muted pad">No skills yet. Skills come from sessions whose edits you approved, or from a runbook note (Make a skill).</p>}
          {list.map((s) => {
            const state = skillState(s);
            return (
              <button key={s.name} className={`review-item ${selected?.name === s.name ? "on" : ""}`} aria-current={selected?.name === s.name}
                onClick={() => go({ page: "skills", skill: s.name }, { replace: true })}>
                <Sparkles size="1.3em" aria-hidden />
                <span className="grow">{s.name}<br /><span className={`small ${state.tone === "failed" ? "error" : "muted"}`}>{state.label}</span></span>
              </button>
            );
          })}
          {skills.data?.some((s) => s.archived) && (
            <label className="check pad"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
          )}
          <h2 className="review-group">Recent reviews</h2>
          {!status?.runs.length && <p className="muted small pad">No session has been reviewed yet.</p>}
          {status?.runs.slice(0, 12).map((r) => (
            <button key={`${r.session}-${r.at}`} className="review-item" title={`${when(r.at)}${r.costUsd != null ? ` · $${r.costUsd.toFixed(2)}` : ""}`} onClick={() => openSession(r.session)}>
              <span className="grow">{r.title}<br /><span className={`small ${r.state === "failed" ? "error" : "muted"}`}>{runText(r)}</span></span>
            </button>
          ))}
        </nav>
        {selected ? <SkillDetail key={selected.name} skill={selected} /> : <div className="review-pane" />}
      </div>
    </div>
  );
}
