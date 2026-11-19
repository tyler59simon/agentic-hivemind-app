import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, FileText, Layers, Lightbulb, Network, Sparkles } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { reviewFiles, reviewRefresh, sessionsQuery, type FileChange, type SessionInfo } from "../../lib/agent";
import { useChangesEnabled, useProjectsEnabled, useSystemsEnabled } from "../../lib/connection";
import { systemStaleness, type Staleness } from "../../lib/architecture";
import { classify } from "../../lib/errors";
import { list as listNotes, meta, proposalsList, review, writeSystem, type MemoryProposal, type ReviewKind, type ReviewRow, type System, type SystemUpdate } from "../../lib/lm";
import { learningQuery, skillProposalsQuery, type ReviewRun, type SkillProposal } from "../../lib/skills";
import { MemoryProposalCard, SkillProposalCard } from "../skills/LearnedCards";
import { proposalTitle } from "../skills/skills";
import { openSession, openSystem, useApp } from "../../store";
import { sections } from "../../lib/note";
import { Markdown } from "../../ui/Markdown";
import { ArrowLink, PageHeader, Tabs } from "../../ui/Page";
import { changesQuery } from "../changes/useChanges";
import { DirectDialog } from "../plans/DirectDialog";
import { ProposedFields } from "../systems/ProposedFields";
import { systemsForProject } from "../projects/scope";
import { useCurrentProject, useProject } from "../projects/useProject";
import { systemsQuery, useSystemProposals } from "../systems/useSystem";
import { noteQuery } from "../viewer/NoteView";
import { ReviewQueue } from "../work/ReviewQueue";
import { FilePane, ReviewBar, SessionPane } from "./CodeReview";
import { afterDecision, baseName, changeOf, fileKey, reviewLabel, reviewSessions, reviewVersion, sessionHeading, step } from "./review";
import { candidates, CANDIDATES, unconfirmed } from "./memory";
import { countLine, kindCounts } from "./worklist";

type Kind = "all" | "code" | "memory" | "architecture" | "learned";

/** The most file rows one session lists; the rest are counted. */
const MAX_ROWS = 300;
const EMPTY: Record<Exclude<Kind, "all">, string> = {
  code: "No code changes are waiting.", memory: "No notes are waiting.", architecture: "No architecture updates are waiting.",
  learned: "Nothing learned is waiting. Drafts appear here after a session's review.",
};

type Item =
  | { key: string; type: "file"; info: SessionInfo; file: FileChange }
  | { key: string; type: "session"; info: SessionInfo }
  | { key: string; type: "memory"; row: ReviewRow; due: boolean }
  | { key: string; type: "proposal"; system: System; update: SystemUpdate; fields: string; proposer: SessionInfo }
  | { key: string; type: "behind"; system: System; stale: Staleness }
  | { key: string; type: "learned"; proposal: MemoryProposal; run?: ReviewRun }
  | { key: string; type: "skill"; proposal: SkillProposal };

/** A Memory item: the existing card, and the note's Executive Summary under it. */
function MemoryCard({ row, due }: { row: ReviewRow; due: boolean }) {
  const note = useQuery(noteQuery(row.ref));
  const summary = note.data ? sections(note.data.body).summary : undefined;
  return (
    <>
      {!due && <p className="muted">An agent captured this note. Nobody has confirmed it yet.</p>}
      <ReviewQueue rows={[row]} snooze={due} />
      {summary && <div className="markdown"><Markdown>{summary}</Markdown></div>}
    </>
  );
}

/** Review: what waits for you before it counts as accepted. Agent code edits, notes due for confirmation and registry changes an agent
 *  proposed each have their rows in the left list; the right pane shows the selected one. */
export function ReviewPage() {
  const client = useQueryClient();
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const routed = route.page === "review" ? route : { page: "review" as const };
  const projectsOn = useProjectsEnabled();
  const systemsOn = useSystemsEnabled();
  const changesOn = useChangesEnabled();
  const { project } = useCurrentProject();

  // Code: the sessions with edits to review, and each one's files.
  const sessions = useQuery(sessionsQuery());
  const groups = useMemo(() => reviewSessions(sessions.data ?? [], project?.slug, routed.session), [sessions.data, project?.slug, routed.session]);
  useEffect(() => { reviewRefresh().catch(() => undefined); }, []);
  const lists = useQueries({
    queries: groups.map((g) => ({
      queryKey: ["agent", "review-files", g.id, reviewVersion(g)], queryFn: () => reviewFiles(g.id), staleTime: 0, retry: false,
    })),
  });
  const changes = useQuery({ ...changesQuery(), enabled: changesOn && groups.some((g) => changeOf(g) !== undefined) });
  const displayOf = (info: SessionInfo) => changes.data?.changes.find((c) => c.id === changeOf(info))?.display;

  // Memory and Architecture.
  const mine = useProject(project?.slug).due;
  const everything = useQuery({ queryKey: ["review", "*"], queryFn: () => review({ allDomains: true, limit: 100 }), enabled: projectsOn && !project });
  const due = project ? mine : everything;
  const registry = useQuery({ ...systemsQuery(), enabled: systemsOn });
  const all = useMemo(() => registry.data?.systems ?? [], [registry.data]);
  const scoped = useMemo(() => (project ? systemsForProject(project, all) : all).filter((s) => s.status !== "retired"), [project, all]);
  const { items: proposed, dismiss } = useSystemProposals(scoped, all);
  const proposals = proposed.filter((i) => i.update && i.proposer);
  // Systems whose architecture output has fallen behind their repository ("newer candidate"). Only systems with both a repository and a folder.
  const tracked = useMemo(() => scoped.filter((s) => s.repos.length && s.architecture), [scoped]);
  const staleness = useQueries({
    queries: tracked.map((s) => ({ queryKey: ["architecture", s.slug, "staleness", "review"], queryFn: () => systemStaleness(s.slug), staleTime: 60_000, retry: false })),
  });
  const behind = useMemo(() => tracked.flatMap((system, i) => {
    const stale = staleness[i]?.data;
    return stale?.behind ? [{ system, stale }] : [];
  }), [tracked, staleness]);
  const [kind, setKind] = useState<Kind>("all");
  const [picked, setPicked] = useState<string | null>(null);
  const [kinds, setKinds] = useState<ReviewKind[]>([]);
  const [reviewing, setReviewing] = useState<{ system: System; update: SystemUpdate } | null>(null);
  // The unfiltered result gives the counts and the chips; picked kinds are asked of the store so its 100-row limit applies to them.
  const filtered = useQuery({
    queryKey: ["review", "kinds", project?.slug ?? "*", kinds],
    queryFn: () => review({ allDomains: true, ...(project ? { tags: [project.tag] } : {}), kind: kinds, limit: 100 }),
    enabled: projectsOn && !!kinds.length,
  });
  const active = kinds.length ? filtered : due;
  const notes = active.data?.notes ?? [];
  const counts = due.data?.counts;
  // Notes an agent captured and nobody has confirmed. `["meta", ref]` is the cache the history page uses too.
  const recent = useQuery({
    queryKey: ["list", "review-candidates", project?.slug ?? "*"],
    queryFn: () => listNotes({ allDomains: true, status: "active", tags: project ? [project.tag] : undefined, limit: CANDIDATES }),
    enabled: projectsOn,
  });
  const recentRows = useMemo(() => candidates(recent.data?.notes ?? []), [recent.data]);
  const metas = useQueries({ queries: recentRows.map((r) => ({ queryKey: ["meta", r.ref], queryFn: () => meta(r.ref), staleTime: Infinity })) });
  const dueRefs = useMemo(() => new Set((due.data?.notes ?? []).map((r) => r.ref)), [due.data]);
  const captures = useMemo(() => unconfirmed(recentRows, metas.map((m) => m.data), dueRefs), [recentRows, metas, dueRefs]);

  // Learned: drafts that agents and Hivemind's reviewer staged in Living Memory's inbox, and skill proposals.
  // Agents stage drafts without telling the app, so read the inbox again whenever the page opens.
  const memoryDrafts = useQuery({ queryKey: ["proposals", "list"], queryFn: proposalsList, enabled: projectsOn, retry: false, refetchOnMount: "always" });
  const skillDrafts = useQuery({ ...skillProposalsQuery(), refetchOnMount: "always" });
  const learning = useQuery(learningQuery());
  const drafts = useMemo(() => memoryDrafts.data?.proposals ?? [], [memoryDrafts.data]);
  const runOf = useMemo(() => {
    const byDraft = new Map<string, ReviewRun>();
    for (const run of learning.data?.runs ?? []) for (const m of run.memory) byDraft.set(m.id, run);
    return byDraft;
  }, [learning.data]);

  const codeCount = groups.reduce((sum, g) => sum + (g.filesChanged?.files ?? 0), 0);
  const memoryCount = (due.data?.notes.length ?? 0) + captures.length;
  const architectureCount = proposals.length + behind.length;
  const learnedCount = drafts.length + (skillDrafts.data?.length ?? 0);
  const total = codeCount + memoryCount + architectureCount + learnedCount;
  const showCode = kind === "all" || kind === "code";
  const showMemory = kind === "all" || kind === "memory";
  const showArchitecture = kind === "all" || kind === "architecture";
  const showLearned = kind === "all" || kind === "learned";

  // Everything the left list can hold, in order, and which of it is selected.
  const visible = useMemo(() => {
    const out: Item[] = [];
    if (showCode) {
      groups.forEach((info, i) => {
        const files = lists[i]?.data ?? [];
        if (lists[i]?.data && !files.length) out.push({ key: `session:${info.id}`, type: "session", info });
        for (const file of files.slice(0, MAX_ROWS)) out.push({ key: fileKey(info.id, file.path), type: "file", info, file });
      });
    }
    if (showMemory) for (const row of notes) out.push({ key: `memory:${row.ref}`, type: "memory", row, due: true });
    // A kind filter narrows the due notes only; captures have no kind.
    if (showMemory && !kinds.length) for (const row of captures) out.push({ key: `memory:${row.ref}`, type: "memory", row, due: false });
    if (showArchitecture) for (const p of proposals) out.push({ key: `proposal:${p.system.slug}`, type: "proposal", system: p.system, update: p.update!, fields: p.fields, proposer: p.proposer! });
    if (showArchitecture) for (const b of behind) out.push({ key: `behind:${b.system.slug}`, type: "behind", system: b.system, stale: b.stale });
    if (showLearned) for (const p of drafts) out.push({ key: `learned:${p.id}`, type: "learned", proposal: p, run: runOf.get(p.id) });
    if (showLearned) for (const p of skillDrafts.data ?? []) out.push({ key: `skill:${p.id}`, type: "skill", proposal: p });
    return out;
  }, [showCode, showMemory, showArchitecture, showLearned, groups, lists, notes, captures, kinds, proposals, behind, drafts, runOf, skillDrafts.data]);
  const routedKey = routed.session && routed.file ? fileKey(routed.session, routed.file) : null;
  const firstOfRouted = visible.find((i) => (i.type === "file" || i.type === "session") && i.info.id === routed.session);
  const selected = (picked && visible.find((i) => i.key === picked))
    || (routedKey && visible.find((i) => i.key === routedKey)) || firstOfRouted || visible[0] || null;

  const select = (item: Item) => {
    if (item.type === "file") go({ page: "review", session: item.info.id, file: item.file.path }, { replace: true });
    else if (item.type === "session") go({ page: "review", session: item.info.id }, { replace: true });
    setPicked(item.type === "file" || item.type === "session" ? null : item.key);
  };
  const list = useRef<HTMLElement>(null);
  const focusKey = (key: string) => [...(list.current?.querySelectorAll<HTMLButtonElement>("button.review-item") ?? [])].find((b) => b.dataset.key === key)?.focus();
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !selected) return;
    focused.current = true;
    focusKey(selected.key);
  }, [selected]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const key = step(visible.map((i) => i.key), selected?.key ?? null, e.key === "ArrowDown" ? 1 : -1);
    const item = visible.find((i) => i.key === key);
    if (!item) return;
    e.preventDefault();
    select(item);
    focusKey(item.key);
  };

  const row = (item: Item, icon: React.ReactNode, label: React.ReactNode, extra?: React.ReactNode) => {
    const on = selected?.key === item.key;
    return (
      <button key={item.key} data-key={item.key} className={`review-item ${on ? "on" : ""}`} aria-current={on} title={item.type === "file" ? item.file.path : undefined}
        onClick={() => select(item)}>
        {icon}<span className="grow">{label}</span>{extra}
      </button>
    );
  };

  const loading = !visible.length && !groups.length && (sessions.isLoading || (projectsOn && due.isLoading) || (systemsOn && registry.isLoading));
  const nothing = !loading && !total && !groups.length;
  const memoryRows = showMemory && projectsOn;
  const info = selected && (selected.type === "file" || selected.type === "session") ? selected.info : null;
  const infoFiles = info ? lists[groups.findIndex((g) => g.id === info.id)]?.data?.length ?? info.filesChanged?.files ?? 0 : 0;
  const changeTitle = info && changes.data?.changes.find((c) => c.id === changeOf(info))?.title;

  return (
    <div className="page fill-page">
      <PageHeader title="Review" subtitle="Inspect agent changes before they become accepted work." />
      <Tabs pill label="Kind" value={kind} onChange={setKind}
        items={[{ id: "all", label: "All", count: total }, { id: "code", label: "Code", count: codeCount }, { id: "memory", label: "Memory", count: memoryCount },
          { id: "architecture", label: "Architecture", count: architectureCount }, { id: "learned", label: "Learned", count: learnedCount }]} />
      {!projectsOn && <p className="muted">Memory review needs a newer Living Memory (API 2 with the <code>review</code> command).</p>}
      {sessions.error && <p className="error">{classify(sessions.error).message}</p>}
      {loading ? <p className="muted">Loading…</p>
        : nothing ? <p className="muted">Nothing is waiting for you.</p>
        : (
          <>
          <div className="review">
            <nav className="review-list" aria-label="Items to review" ref={list} onKeyDown={onKeyDown}>
              {showCode && groups.map((g, i) => {
                const files = lists[i];
                const label = reviewLabel(g);
                const mineItems = visible.filter((v) => (v.type === "file" || v.type === "session") && v.info.id === g.id);
                const hidden = (files?.data?.length ?? 0) - MAX_ROWS;
                return (
                  <Fragment key={g.id}>
                    <h2 className="review-group">
                      {sessionHeading(g, displayOf(g))}
                      {g.status === "running" || g.status === "waiting" ? <span className="status-chip running">Working…</span>
                        : label?.tone === "busy" ? <span className="status-chip busy">{label.text}</span> : null}
                    </h2>
                    {files?.isLoading ? <p className="muted small pad">Loading files…</p>
                      : files?.error ? <p className="error small pad">{classify(files.error).message}</p>
                      : mineItems.map((item) => item.type === "file"
                        ? row(item, <FileText size="1.3em" aria-hidden />, baseName(item.file.path),
                          item.file.status === "A" ? <span className="muted small">new</span> : item.file.status === "D" ? <span className="muted small">deleted</span> : null)
                        : row(item, <CircleCheck size="1.3em" aria-hidden />, "No proposed edits"))}
                    {hidden > 0 && <p className="muted small pad">and {hidden} more files</p>}
                  </Fragment>
                );
              })}
              {showCode && !!groups.length && visible.some((v) => v.type !== "file" && v.type !== "session") && <div className="review-divider" role="separator" />}
              {memoryRows && !!counts && (
                <div className="pad">
                  <p className="muted small">{countLine(counts)}</p>
                  <div className="chips">
                    {kindCounts(counts, kinds).map(({ kind: k, count }) => (
                      <button key={k} className={`chip ${kinds.includes(k) ? "on" : ""}`} aria-pressed={kinds.includes(k)}
                        onClick={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])}>{k} {count}</button>
                    ))}
                  </div>
                </div>
              )}
              {memoryRows && active.isLoading && <p className="muted small pad">Loading…</p>}
              {memoryRows && !!active.error && <p className="error small pad">{classify(active.error).message}</p>}
              {visible.map((item) => item.type === "memory" ? row(item, <Layers size="1.3em" aria-hidden />, `Memory: ${item.row.title}`, item.due ? null : <span className="muted small">agent</span>)
                : item.type === "proposal" ? row(item, <Network size="1.3em" aria-hidden />, `Architecture: ${item.system.name} update`)
                : item.type === "behind" ? row(item, <Layers size="1.3em" aria-hidden />, `Architecture: ${item.system.name} is ${item.stale.behind} commit${item.stale.behind === 1 ? "" : "s"} behind`)
                : item.type === "learned" ? row(item, <Lightbulb size="1.3em" aria-hidden />, `Learned: ${item.proposal.title}`, <span className="muted small">{item.run ? "review" : "agent"}</span>)
                : item.type === "skill" ? row(item, <Sparkles size="1.3em" aria-hidden />, proposalTitle(item.proposal))
                : null)}
              {!visible.length && kind in EMPTY && <p className="muted pad">{EMPTY[kind as keyof typeof EMPTY]}</p>}
            </nav>
            {selected?.type === "file" ? <FilePane info={selected.info} file={selected.file} />
              : selected?.type === "session" ? <SessionPane info={selected.info} />
              : selected ? (
                <div className="review-pane">
                  {selected.type === "memory" && <MemoryCard row={selected.row} due={selected.due} />}
                  {selected.type === "learned" && <MemoryProposalCard key={selected.proposal.id} proposal={selected.proposal} run={selected.run} onDone={() => setPicked(null)} />}
                  {selected.type === "skill" && <SkillProposalCard key={selected.proposal.id} proposal={selected.proposal} onDone={() => setPicked(null)} />}
                  {selected.type === "proposal" && (
                    <div className="work-group">
                      <div className="work-head"><span className="badge">system</span><button className="link-row" onClick={() => openSystem(selected.system.slug)}>{selected.system.name}</button></div>
                      <div>An agent session proposed changes to {selected.fields}.</div>
                      <div className="work-actions">
                        <button className="primary" onClick={() => setReviewing({ system: selected.system, update: selected.update })}>Review…</button>
                        <button onClick={() => dismiss(selected.proposer.id)}>Dismiss</button>
                        <ArrowLink onClick={() => openSession(selected.proposer.id)}>Open session</ArrowLink>
                      </div>
                    </div>
                  )}
                  {selected.type === "behind" && (
                    <>
                      <h2>{selected.system.name}</h2>
                      <p>{selected.system.name}'s architecture output is {selected.stale.behind} commit{selected.stale.behind === 1 ? "" : "s"} behind its repository.</p>
                      {selected.stale.exact && selected.stale.sourceSha && <p className="muted">Generated from <code>{selected.stale.sourceSha.slice(0, 7)}</code>.</p>}
                      <ArrowLink onClick={() => openSystem(selected.system.slug)}>Open Architecture</ArrowLink>
                    </>
                  )}
                </div>
              ) : <div className="review-pane" />}
          </div>
          {info && <ReviewBar key={info.id} info={info} files={infoFiles} title={changeTitle ?? info.title}
            onDecided={() => { setPicked(null); go(afterDecision(groups, info.id), { replace: true }); }} />}
          </>
        )}
      {reviewing && (
        <DirectDialog title={`Update system ${reviewing.system.name}`} applyLabel="Update system"
          intro={<ProposedFields system={reviewing.system} update={reviewing.update} />}
          run={() => writeSystem("update", reviewing.update)} done={`Updated ${reviewing.system.name}`}
          onApplied={() => client.invalidateQueries({ queryKey: ["systems"] })}
          onClose={() => setReviewing(null)} />
      )}
    </div>
  );
}
