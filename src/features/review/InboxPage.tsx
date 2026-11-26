import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, FileText, Inbox as InboxIcon, Layers, Lightbulb, Network, NotebookPen, RefreshCwOff, Sparkles, Wrench } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { reviewFiles, reviewRefresh, type FileChange, type SessionInfo } from "../../lib/agent";
import { useProjectsEnabled } from "../../lib/connection";
import { type Staleness } from "../../lib/architecture";
import { classify } from "../../lib/errors";
import type { CaptureBatch } from "../../lib/executive";
import { meta, review, writeSystem, type DocProposalRow, type MemoryProposal, type ReviewKind, type ReviewRow, type System, type SystemUpdate } from "../../lib/lm";
import { learningQuery, type ReviewRun, type Skill, type SkillProposal } from "../../lib/skills";
import { MemoryProposalCard, SkillProposalCard } from "../skills/LearnedCards";
import { SkillSyncCard } from "../skills/SkillSyncCard";
import { proposalTitle, syncTitle } from "../skills/skills";
import { openSession, openSystem, useApp, type InboxKind } from "../../store";
import { sections } from "../../lib/note";
import { Markdown } from "../../ui/Markdown";
import { ArrowLink, PageHeader, Tabs } from "../../ui/Page";
import { notebooksQuery } from "../../lib/notebooks";
import { age, ProposalDetail, proposalWhere } from "../notes/ProposalInbox";
import { DirectDialog } from "../plans/DirectDialog";
import { ReviewDialog } from "../executive/Capture";
import { AppliedPane } from "../maintenance/AppliedPane";
import { reasonText, resultText, type AppliedItem } from "../maintenance/maintenance";
import { ProposedFields } from "../systems/ProposedFields";
import { projectsQuery } from "../projects/useProject";
import { noteQuery } from "../viewer/NoteView";
import { OpenedDialog, ReviewQueue, type Opened } from "../work/ReviewQueue";
import { FilePane, ReviewBar, SessionPane } from "./CodeReview";
import { dueNotes } from "./memory";
import { afterDecision, baseName, fileKey, reviewLabel, reviewVersion, step } from "./review";
import { useInboxItems } from "./useInboxItems";
import { countLine, inboxTabs, kindCounts, shownKind } from "./worklist";

type Kind = "all" | InboxKind;

/** The most file rows one session lists; the rest are counted. */
const MAX_ROWS = 300;
const EMPTY: Record<InboxKind, string> = {
  code: "No code changes are waiting.", memory: "No notes are waiting.", pages: "No page edits are waiting.", captures: "No captures are waiting.",
  maintenance: "No maintenance changes are waiting.", architecture: "No architecture updates are waiting.", skills: "No skill proposals or sync conflicts are waiting.",
};

type Item =
  | { key: string; type: "file"; info: SessionInfo; file: FileChange }
  | { key: string; type: "session"; info: SessionInfo }
  | { key: string; type: "memory"; row: ReviewRow; due: boolean; why?: string }
  | { key: string; type: "draft"; proposal: MemoryProposal; run?: ReviewRun }
  | { key: string; type: "page"; row: DocProposalRow }
  | { key: string; type: "capture"; batch: CaptureBatch }
  | { key: string; type: "applied"; item: AppliedItem }
  | { key: string; type: "proposal"; system: System; update: SystemUpdate; fields: string; proposer: SessionInfo }
  | { key: string; type: "behind"; system: System; stale: Staleness }
  | { key: string; type: "skill"; proposal: SkillProposal }
  | { key: string; type: "skill-sync"; skill: Skill };

/** A Memory item: the existing card, and the note's Executive Summary under it. */
function MemoryCard({ row, due, why, onOpen }: { row: ReviewRow; due: boolean; why?: string; onOpen: (opened: Opened) => void }) {
  const note = useQuery(noteQuery(row.ref));
  const summary = note.data ? sections(note.data.body).summary : undefined;
  return (
    <>
      {!due && <p className="muted">An agent captured this note. Nobody has confirmed it yet.</p>}
      {due && why !== undefined && <p className="muted">Maintenance did not decide this note{why ? `: ${why.replace(/[.\s]+$/, "")}` : ""}.</p>}
      <ReviewQueue rows={[row]} snooze={due} onOpen={onOpen} />
      {summary && <div className="markdown"><Markdown>{summary}</Markdown></div>}
    </>
  );
}

/** Inbox: what waits for you before it counts as accepted. Agent code edits, notes, page edits, captures, what maintenance
 *  changed, registry changes, skill proposals and paused skill syncs each have their rows in the left list; the right pane shows the selected one. */
export function InboxPage() {
  const client = useQueryClient();
  const route = useApp((s) => s.route);
  const go = useApp((s) => s.go);
  const routed = route.page === "inbox" ? route : { page: "inbox" as const };
  const projectsOn = useProjectsEnabled();
  const inbox = useInboxItems({ routed: routed.session });
  const notebooks = useQuery(notebooksQuery());
  const where = (row: DocProposalRow) => proposalWhere(row, notebooks.data ?? []);
  const { groups, sessions, due, drafts, pages, captures, applied, skills, syncs, proposals, behind, dismiss, counts } = inbox;

  // Code: each session's files. Sessions come from the hook; their file lists are read here, for the rows shown.
  useEffect(() => { reviewRefresh().catch(() => undefined); }, []);
  const lists = useQueries({
    queries: groups.map((g) => ({
      queryKey: ["agent", "review-files", g.id, reviewVersion(g)], queryFn: () => reviewFiles(g.id), staleTime: 0, retry: false,
    })),
  });

  const [picked, setPicked] = useState<string | null>(null);
  const [kinds, setKinds] = useState<ReviewKind[]>([]);
  const [reviewing, setReviewing] = useState<{ system: System; update: SystemUpdate } | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  // A memory card's dialog (a merge with its draft included) lives here, not in the card: a refresh can remove the selected
  // item or empty the Inbox while it is open (Codex re-review, N03).
  const [opened, setOpened] = useState<Opened | null>(null);
  const kind: Kind = shownKind(routed.kind ?? "all", counts);

  // Memory: the unfiltered result gives the counts and the chips; picked kinds are asked of the store so its 100-row limit applies to them.
  const filtered = useQuery({
    queryKey: ["review", "kinds", "*", kinds],
    queryFn: () => review({ allDomains: true, kind: kinds, limit: 100 }),
    enabled: projectsOn && !!kinds.length,
  });
  const active = kinds.length ? filtered : due;
  const notes = useMemo(
    () => (kinds.length ? (inbox.maintenanceLoading ? [] : dueNotes(filtered.data?.notes ?? [], inbox.deferred, inbox.covered)) : inbox.dueRows),
    [kinds.length, filtered.data, inbox.maintenanceLoading, inbox.deferred, inbox.covered, inbox.dueRows],
  );
  const counted = inbox.kindTotals;
  const learning = useQuery(learningQuery());
  const runOf = useMemo(() => {
    const byDraft = new Map<string, ReviewRun>();
    for (const run of learning.data?.runs ?? []) for (const m of run.memory) byDraft.set(m.id, run);
    return byDraft;
  }, [learning.data]);

  // Maintenance: the note each change is about.
  const titles = useQueries({ queries: applied.map((a) => ({ queryKey: ["maintenance", "note", a.ref], queryFn: () => meta(a.ref), retry: false })) });
  const titleOf = (ref: string) => titles[applied.findIndex((a) => a.ref === ref)]?.data?.title;
  const projects = useQuery({ ...projectsQuery(), enabled: projectsOn });

  const total = inbox.total;
  const show = (k: InboxKind) => kind === "all" || kind === k;

  // Everything the left list can hold, in order, and which of it is selected.
  const visible = useMemo(() => {
    const out: Item[] = [];
    if (show("code")) {
      groups.forEach((info, i) => {
        const files = lists[i]?.data ?? [];
        if (lists[i]?.data && !files.length) out.push({ key: `session:${info.id}`, type: "session", info });
        for (const file of files.slice(0, MAX_ROWS)) out.push({ key: fileKey(info.id, file.path), type: "file", info, file });
      });
    }
    if (show("memory")) {
      for (const row of notes) out.push({ key: `memory:${row.ref}`, type: "memory", row, due: true, why: inbox.deferred?.has(row.ref) ? reasonText(inbox.deferred.get(row.ref)!) : undefined });
      // A kind filter narrows the due notes only; unconfirmed notes and drafts have no kind.
      if (!kinds.length) for (const row of inbox.unconfirmedNotes) out.push({ key: `memory:${row.ref}`, type: "memory", row, due: false });
      if (!kinds.length) for (const p of drafts) out.push({ key: `draft:${p.id}`, type: "draft", proposal: p, run: runOf.get(p.id) });
    }
    if (show("pages")) for (const row of pages) out.push({ key: `page:${row.id}`, type: "page", row });
    if (show("captures")) for (const batch of captures) out.push({ key: `capture:${batch.id}`, type: "capture", batch });
    if (show("maintenance")) for (const item of applied) out.push({ key: `applied:${item.key}`, type: "applied", item });
    if (show("architecture")) for (const p of proposals) out.push({ key: `proposal:${p.system.slug}`, type: "proposal", system: p.system, update: p.update!, fields: p.fields, proposer: p.proposer! });
    if (show("architecture")) for (const b of behind) out.push({ key: `behind:${b.system.slug}`, type: "behind", system: b.system, stale: b.stale });
    if (show("skills")) for (const p of skills) out.push({ key: `skill:${p.id}`, type: "skill", proposal: p });
    if (show("skills")) for (const s of syncs) out.push({ key: `skill-sync:${s.name}`, type: "skill-sync", skill: s });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, groups, lists, notes, inbox.deferred, inbox.unconfirmedNotes, kinds, drafts, runOf, pages, captures, applied, proposals, behind, skills, syncs]);
  const routedKey = routed.session && routed.file ? fileKey(routed.session, routed.file) : null;
  const firstOfRouted = visible.find((i) => (i.type === "file" || i.type === "session") && i.info.id === routed.session);
  const selected = (picked && visible.find((i) => i.key === picked))
    || (routedKey && visible.find((i) => i.key === routedKey)) || firstOfRouted || visible[0] || null;

  const select = (item: Item) => {
    const k = kind === "all" ? undefined : kind;
    if (item.type === "file") go({ page: "inbox", session: item.info.id, file: item.file.path, kind: k }, { replace: true });
    else if (item.type === "session") go({ page: "inbox", session: item.info.id, kind: k }, { replace: true });
    else if (routed.session || routed.file) go({ page: "inbox", kind: k }, { replace: true });
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

  const loading = !visible.length && !groups.length && inbox.loading;
  const nothing = !loading && !total && !groups.length;
  const memoryRows = show("memory") && projectsOn;
  const info = selected && (selected.type === "file" || selected.type === "session") ? selected.info : null;
  const infoFiles = info ? lists[groups.findIndex((g) => g.id === info.id)]?.data?.length ?? info.filesChanged?.files ?? 0 : 0;
  const done = () => setPicked(null);

  return (
    <div className="page fill-page">
      <PageHeader title="Inbox" subtitle="Agent changes and drafts that wait for you before they count as accepted." />
      <Tabs pill label="Kind" value={kind} onChange={(id: Kind) => { setPicked(null); setKinds([]); go({ page: "inbox", kind: id === "all" ? undefined : id }, { replace: true }); }} items={inboxTabs(counts)} />
      {!projectsOn && <p className="muted">Memory review needs a newer Living Memory (API 2 with the <code>review</code> command).</p>}
      {sessions.error && <p className="error">{classify(sessions.error).message}</p>}
      {loading ? <p className="muted">Loading…</p>
        : nothing ? <p className="muted">Nothing is waiting for you.</p>
        : (
          <>
          <div className="review">
            <nav className="review-list" aria-label="Items to review" ref={list} onKeyDown={onKeyDown}>
              {show("code") && groups.map((g, i) => {
                const files = lists[i];
                const label = reviewLabel(g);
                const mineItems = visible.filter((v) => (v.type === "file" || v.type === "session") && v.info.id === g.id);
                const hidden = (files?.data?.length ?? 0) - MAX_ROWS;
                return (
                  <Fragment key={g.id}>
                    <h2 className="review-group">
                      {g.title}
                      {g.project && <span className="muted small">{g.project}</span>}
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
              {show("code") && !!groups.length && visible.some((v) => v.type !== "file" && v.type !== "session") && <div className="review-divider" role="separator" />}
              {memoryRows && !!counted && (
                <div className="pad">
                  <p className="muted small">{countLine(counted)}</p>
                  <div className="chips">
                    {kindCounts(counted, kinds).map(({ kind: k, count }) => (
                      <button key={k} className={`chip ${kinds.includes(k) ? "on" : ""}`} aria-pressed={kinds.includes(k)}
                        onClick={() => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])}>{k} {count}</button>
                    ))}
                  </div>
                </div>
              )}
              {memoryRows && (active.isLoading || inbox.maintenanceLoading) && <p className="muted small pad">Loading…</p>}
              {memoryRows && !!active.error && <p className="error small pad">{classify(active.error).message}</p>}
              {visible.map((item) => item.type === "memory" ? row(item, <Layers size="1.3em" aria-hidden />, item.row.title, item.due ? null : <span className="muted small">agent</span>)
                : item.type === "draft" ? row(item, <Lightbulb size="1.3em" aria-hidden />, item.proposal.title, <span className="muted small">{item.run ? "review draft" : "agent draft"}</span>)
                : item.type === "page" ? row(item, <NotebookPen size="1.3em" aria-hidden />, item.row.path, <span className="muted small">{where(item.row).short}{item.row.orphaned ? " · folder gone" : ""}</span>)
                : item.type === "capture" ? row(item, <InboxIcon size="1.3em" aria-hidden />, item.batch.source.label,
                  <span className="muted small">{item.batch.project ?? ""}{item.batch.items.filter((i) => i.state === "pending").length ? ` ${item.batch.items.filter((i) => i.state === "pending").length}` : ""}</span>)
                : item.type === "applied" ? row(item, <Wrench size="1.3em" aria-hidden />, titleOf(item.item.ref) ?? item.item.ref, <span className="muted small">{resultText(item.item.decision).toLowerCase()}</span>)
                : item.type === "proposal" ? row(item, <Network size="1.3em" aria-hidden />, `Architecture: ${item.system.name} update`)
                : item.type === "behind" ? row(item, <Layers size="1.3em" aria-hidden />, `Architecture: ${item.system.name} is ${item.stale.behind} commit${item.stale.behind === 1 ? "" : "s"} behind`)
                : item.type === "skill" ? row(item, <Sparkles size="1.3em" aria-hidden />, proposalTitle(item.proposal))
                : item.type === "skill-sync" ? row(item, <RefreshCwOff size="1.3em" aria-hidden />, syncTitle(item.skill.name))
                : null)}
              {!visible.length && kind !== "all" && !inbox.loading
                && !(kind === "code" && lists.some((q) => q.isLoading))
                && !(kind === "memory" && (active.isLoading || inbox.maintenanceLoading))
                && <p className="muted pad">{EMPTY[kind]}</p>}
            </nav>
            {selected?.type === "file" ? <FilePane key={selected.info.id} info={selected.info} file={selected.file} />
              : selected?.type === "session" ? <SessionPane key={selected.info.id} info={selected.info} />
              : selected ? (
                <div className="review-pane">
                  {selected.type === "memory" && <MemoryCard row={selected.row} due={selected.due} why={selected.why} onOpen={setOpened} />}
                  {selected.type === "draft" && <MemoryProposalCard key={selected.proposal.id} proposal={selected.proposal} run={selected.run} onDone={done} />}
                  {selected.type === "skill" && <SkillProposalCard key={selected.proposal.id} proposal={selected.proposal} onDone={done} />}
                  {selected.type === "skill-sync" && <SkillSyncCard key={selected.skill.name} skill={selected.skill} onDone={done} />}
                  {selected.type === "page" && (
                    <>
                      <h2>{selected.row.path}</h2>
                      <p className="muted small">In {where(selected.row).long} · {selected.row.base_revision ? "edit" : "new page"} · {age(selected.row.created)}{selected.row.orphaned ? " · its folder is no longer registered" : ""}</p>
                      {selected.row.note && <p>{selected.row.note}</p>}
                      <ProposalDetail key={selected.row.id} row={selected.row} onSettled={done} />
                    </>
                  )}
                  {selected.type === "capture" && (
                    <>
                      <h2>{selected.batch.source.label}</h2>
                      <p className="muted small">{selected.batch.project ? `For ${selected.batch.project}. ` : ""}{selected.batch.items.filter((i) => i.state === "pending").length} of {selected.batch.items.length} items to decide.</p>
                      {!!selected.batch.questions.length && <ul className="muted small">{selected.batch.questions.map((q) => <li key={q}>{q}</li>)}</ul>}
                      <div className="work-actions"><button className="primary" onClick={() => setCapturing(selected.batch.id)}>Review…</button></div>
                    </>
                  )}
                  {selected.type === "applied" && <AppliedPane key={selected.item.key} item={selected.item} title={titleOf(selected.item.ref)} />}
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
          {info && <ReviewBar key={info.id} info={info} files={infoFiles} title={info.title}
            onDecided={() => {
              setPicked(null);
              const next = afterDecision(groups, info.id);
              const nextKind = kind === "code" && !next.session ? undefined : (kind === "all" ? undefined : kind);
              go({ ...next, kind: nextKind }, { replace: true });
            }} />}
          </>
        )}
      {opened && <OpenedDialog opened={opened} onClose={() => setOpened(null)} />}
      {capturing && <ReviewDialog key={capturing} id={capturing} projects={projects.data?.projects ?? []} onClose={() => setCapturing(null)} />}
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
