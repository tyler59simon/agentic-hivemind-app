// Everything that waits for the user, in one place: the Inbox page lists it, the sidebar badge adds it up and Home's "Needs you" counts
// from it. Each group is built from the queries the pages used before, under the same keys, so their caches are shared.
// Per-file diffs are not read here: the page loads those for the sessions it shows.
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { sessionsQuery } from "../../lib/agent";
import { systemStaleness } from "../../lib/architecture";
import { useDocsEnabled, useMaintenanceEnabled, useProjectsEnabled, useSystemsEnabled } from "../../lib/connection";
import {
  allProposalsQuery, list as listNotes, maintenanceHistory, maintenanceRun, maintenanceStatus, meta, proposalsList, review, type MaintenanceDecision, type Project,
} from "../../lib/lm";
import { skillProposalsQuery } from "../../lib/skills";
import { useInbox as useCaptureInbox } from "../executive/useExecutive";
import { APPLIED_DAYS, appliedDecisions, DEFER_DAYS, deferredNotes, HISTORY_LIMIT, runsWithin, type RunDecisions } from "../maintenance/maintenance";
import { useSeen } from "../maintenance/seen";
import { systemsForProject } from "../projects/scope";
import { useProject } from "../projects/useProject";
import { systemsQuery, useSystemProposals } from "../systems/useSystem";
import { candidates, CANDIDATES, dueNotes, unconfirmed } from "./memory";
import { reviewSessions } from "./review";
import { countKinds, inboxTotal, NO_COUNTS, type InboxCounts } from "./worklist";

export interface InboxScope {
  /** Narrows code sessions, capture batches and due notes to one project (Home's "Needs you"); the Inbox itself covers all. */
  project?: Project;
  /** A session the route names: listed even when it has nothing to review. */
  routed?: string;
}

const RUN_STALE = 5 * 60_000;

export function useInboxItems({ project, routed }: InboxScope = {}) {
  const projectsOn = useProjectsEnabled();
  const systemsOn = useSystemsEnabled();
  const docsOn = useDocsEnabled();
  const maintenanceOn = useMaintenanceEnabled();

  // Code: the sessions with edits to review.
  const sessions = useQuery(sessionsQuery());
  const groups = useMemo(() => reviewSessions(sessions.data ?? [], project?.slug, routed), [sessions.data, project?.slug, routed]);

  // Maintenance: its recent runs, with their decisions. The last 30 days say which due notes it deferred; the last 7 say what it
  // changed that the user may want to undo.
  const status = useQuery({ queryKey: ["maintenance", "status"], queryFn: maintenanceStatus, enabled: maintenanceOn, staleTime: 60_000, retry: false });
  const history = useQuery({ queryKey: ["maintenance", "history"], queryFn: () => maintenanceHistory(HISTORY_LIMIT), enabled: maintenanceOn, staleTime: 60_000, retry: false });
  const wanted = useMemo(() => runsWithin(history.data?.runs ?? [], Date.now(), Math.max(DEFER_DAYS, APPLIED_DAYS)), [history.data]);
  const details = useQueries({
    queries: wanted.map((run) => ({ queryKey: ["maintenance", "run", run.id], queryFn: () => maintenanceRun(run.id), staleTime: RUN_STALE, retry: false })),
    combine: (results) => ({ data: results.map((r) => r.data), pending: results.some((r) => r.isPending), failed: results.some((r) => r.isError) }),
  });
  const done = useMemo<RunDecisions[]>(() => wanted.flatMap((run, i) => (details.data[i] ? [{ run, decisions: details.data[i]!.decisions ?? [] }] : [])), [wanted, details.data]);
  const seen = useSeen((s) => s.seen);
  const applied = useMemo(() => (maintenanceOn ? appliedDecisions(done, Date.now(), seen) : []), [maintenanceOn, done, seen]);

  // Memory: notes due for confirmation. With maintenance on, only the ones it deferred or could not decide (CON-7).
  const mine = useProject(project?.slug).due;
  const everything = useQuery({ queryKey: ["review", "*"], queryFn: () => review({ allDomains: true, limit: 100 }), enabled: projectsOn && !project });
  const due = project ? mine : everything;
  const filtering = maintenanceOn && status.data?.enabled === true;
  const maintenanceLoading = maintenanceOn && (status.isPending || (filtering && (history.isPending || details.pending)));
  const maintenanceFailed = status.isError || history.isError || details.failed;
  const deferred = useMemo<Map<string, MaintenanceDecision> | null>(
    () => (filtering && !maintenanceLoading && !maintenanceFailed ? deferredNotes(done, Date.now()) : null),
    [filtering, maintenanceLoading, maintenanceFailed, done],
  );
  const covered = status.data?.domains;
  const dueRows = useMemo(() => (maintenanceLoading ? [] : dueNotes(due.data?.notes ?? [], deferred, covered)), [maintenanceLoading, due.data, deferred, covered]);
  // The store's counts include notes the list leaves out while maintenance filters it, so count the rows themselves then.
  const kindTotals = deferred ? countKinds(dueRows) : due.data?.counts;

  // Notes an agent captured and nobody has confirmed. `["meta", ref]` is the cache the history page uses too.
  const recent = useQuery({
    queryKey: ["list", "review-candidates", project?.slug ?? "*"],
    queryFn: () => listNotes({ allDomains: true, status: "active", tags: project ? [project.tag] : undefined, limit: CANDIDATES }),
    enabled: projectsOn,
  });
  const recentRows = useMemo(() => candidates(recent.data?.notes ?? []), [recent.data]);
  const metas = useQueries({ queries: recentRows.map((r) => ({ queryKey: ["meta", r.ref], queryFn: () => meta(r.ref), staleTime: Infinity })) });
  const dueRefs = useMemo(() => new Set(dueRows.map((r) => r.ref)), [dueRows]);
  const unconfirmedNotes = useMemo(() => unconfirmed(recentRows, metas.map((m) => m.data), dueRefs), [recentRows, metas, dueRefs]);
  // Agents stage drafts without telling the app, so read the inbox again whenever a page that lists them opens.
  const memoryDrafts = useQuery({ queryKey: ["proposals", "list"], queryFn: proposalsList, enabled: projectsOn, retry: false, refetchOnMount: "always" });
  const drafts = useMemo(() => memoryDrafts.data?.proposals ?? [], [memoryDrafts.data]);

  // Pages: edits agents proposed to notebook pages, in every notebook.
  const pageDrafts = useQuery({ ...allProposalsQuery(), enabled: docsOn, retry: false, refetchOnMount: "always" });
  const pages = useMemo(() => (pageDrafts.data ?? []).filter((p) => p.status === "pending"), [pageDrafts.data]);

  // Captures: Executive capture batches with items still to decide. A batch with no project still waits.
  const captureInbox = useCaptureInbox();
  const captures = useMemo(() => captureInbox.waiting.filter((b) => !project || !b.project || b.project === project.slug), [captureInbox.waiting, project]);

  // Architecture: registry updates an agent proposed, and architecture output that fell behind its repository.
  const registry = useQuery({ ...systemsQuery(), enabled: systemsOn });
  const all = useMemo(() => registry.data?.systems ?? [], [registry.data]);
  const scoped = useMemo(() => (project ? systemsForProject(project, all) : all).filter((s) => s.status !== "retired"), [project, all]);
  const { items: proposed, dismiss } = useSystemProposals(scoped, all);
  const proposals = proposed.filter((i) => i.update && i.proposer);
  // Only systems with both a repository and an architecture folder can be behind.
  const tracked = useMemo(() => scoped.filter((s) => s.repos.length && s.architecture), [scoped]);
  const staleness = useQueries({
    queries: tracked.map((s) => ({ queryKey: ["architecture", s.slug, "staleness", "review"], queryFn: () => systemStaleness(s.slug), staleTime: 60_000, retry: false })),
  });
  const behind = useMemo(() => tracked.flatMap((system, i) => {
    const stale = staleness[i]?.data;
    return stale?.behind ? [{ system, stale }] : [];
  }), [tracked, staleness]);

  // Skills: proposals to publish, change or archive a skill.
  const skillDrafts = useQuery({ ...skillProposalsQuery(), refetchOnMount: "always" });
  const skills = useMemo(() => skillDrafts.data ?? [], [skillDrafts.data]);

  const counts: InboxCounts = {
    ...NO_COUNTS,
    code: groups.reduce((sum, g) => (g.review?.state === "approved" || g.review?.state === "dismissed" ? sum : sum + (g.filesChanged?.files ?? 0)), 0),
    memory: dueRows.length + unconfirmedNotes.length + drafts.length,
    pages: pages.length,
    captures: captures.length,
    maintenance: applied.length,
    architecture: proposals.length + behind.length,
    skills: skills.length,
  };
  const loading = sessions.isLoading || (projectsOn && (due.isLoading || memoryDrafts.isLoading))
    || (docsOn && pageDrafts.isLoading) || (systemsOn && registry.isLoading)
    || maintenanceLoading || captureInbox.batches.isLoading || skillDrafts.isLoading;
  return {
    counts, total: inboxTotal(counts), loading, sessions, groups,
    due, dueRows, kindTotals, deferred, covered, maintenanceLoading, unconfirmedNotes, drafts, pages, captures, applied, skills,
    registry, proposals, behind, dismiss,
  };
}
