// The panels Home's rail and "since you were last here" section share with what the Overview showed: what waits for the user, what
// agents did lately, the project's system, and the repositories' recent commits and pull requests.
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bot, Clock, CodeXml, Inbox, Layers } from "lucide-react";
import { useEffect, useMemo } from "react";
import { reviewRefresh, sessionsQuery } from "../../lib/agent";
import { useSystemsEnabled } from "../../lib/connection";
import type { RepoActivity } from "../../lib/git";
import { driftQuery } from "../../lib/architecture";
import type { Project } from "../../lib/lm";
import { skillHistory } from "../../lib/skills";
import { automationsQuery, workflowsQuery } from "../../lib/workflows";
import { ago } from "../../lib/text";
import { openInbox, openSession, openSkills, openSystem, openWorkflows, useApp } from "../../store";
import { ArrowLink, Row, Section } from "../../ui/Page";
import { agentActivity, agentNeeds, type Need } from "../projects/agentwork";
import { useInboxItems } from "../review/useInboxItems";
import { systemsForProject } from "../projects/scope";
import { MiniDiagram } from "../systems/MiniDiagram";
import { systemsQuery, useStaleness, useSystem } from "../systems/useSystem";
import { inboxNeeds } from "./home";

const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** Recent commits and pull requests of the project's repositories. */
export function Commits({ repos }: { repos: RepoActivity[] }) {
  return (
    <>
      {repos.map((r) => (
        <div key={r.repo} className="repo-activity">
          <div className="repo-name"><code title={r.repo}>{folderName(r.repo)}</code></div>
          {r.error && <p className="muted small">{/not a git repository/i.test(r.error) ? "This folder is not a git repository." : r.error}</p>}
          {r.commits && !r.commits.length && !r.error && <p className="muted small">No commits in the last 30 days.</p>}
          <ul className="commit-list">
            {(r.commits ?? []).slice(0, 6).map((c) => (
              <li key={c.sha}>
                <code className="sha">{c.sha.slice(0, 7)}</code>
                <span className="commit-subject" title={c.subject}>{c.subject}</span>
                <span className="muted small">{c.author} · {ago(c.date)}</span>
              </li>
            ))}
          </ul>
          {!!r.prs?.length && (
            <div className="pr-list">
              {r.prs.map((pr) => (
                <a key={pr.number} className={`chip pr pr-${pr.state.toLowerCase()}`} href={pr.url} title={`${pr.title} (${pr.state})`}
                  onClick={(e) => { e.preventDefault(); if (/^https?:/i.test(pr.url)) openUrl(pr.url).catch(() => undefined); }}>
                  #{pr.number} {pr.title}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** The system registered for the project's repositories, as a row of its containers. */
export function SystemContext({ project }: { project: Project }) {
  const systemsOn = useSystemsEnabled();
  const registry = useQuery({ ...systemsQuery(), enabled: systemsOn });
  const matched = useMemo(() => systemsForProject(project, (registry.data?.systems ?? []).filter((s) => s.status !== "retired")), [project, registry.data]);
  const system = matched[0];
  const { architecture } = useSystem(system?.slug);
  const go = useApp((s) => s.go);
  const arch = architecture.data;
  if (!systemsOn) return null;
  return (
    <Section title="System context" loading={registry.isLoading} error={registry.error}>
      {system ? (
        <>
          {arch?.model ? <MiniDiagram model={arch.model} />
            : <p className="muted">{architecture.isLoading ? "Loading…" : arch?.error ?? `${system.name} has no architecture output yet.`}</p>}
          <ArrowLink onClick={() => openSystem(system.slug)}>{arch?.model ? "Open diagram" : `Open ${system.name}`}</ArrowLink>
        </>
      ) : (
        <>
          <p className="muted">No system is registered for this project's repositories.</p>
          <ArrowLink onClick={() => go({ page: "home", tab: "architecture" })}>Open Architecture</ArrowLink>
        </>
      )}
    </Section>
  );
}

/** What waits for the user: what the Inbox holds (counted by the hook that also counts the sidebar badge), an architecture output
 *  that is behind its repository, and what agents and automations did that needs a look. */
export function NeedsReview({ project }: { project?: Project }) {
  const systemsOn = useSystemsEnabled();
  const inbox = useInboxItems({ project });
  const due = inbox.due;
  // Edits made in a worktree by hand count too, so every worktree is looked at once when this is shown.
  useEffect(() => { reviewRefresh().catch(() => undefined); }, []);
  const registry = useQuery({ ...systemsQuery(), enabled: systemsOn && !!project });
  const system = useMemo(() => (project ? systemsForProject(project, (registry.data?.systems ?? []).filter((s) => s.status !== "retired"))[0] : undefined), [project, registry.data]);
  const { architecture } = useSystem(system?.slug);
  const stale = useStaleness(system?.slug, architecture.data?.generatedAt);
  const behind = system && stale.data?.behind ? stale.data.behind : 0;
  // A capture batch with no project, or one for a project not picked, still waits; it is shown on the project it is for, or everywhere when it has none.
  const captures = inbox.captures;
  const rows = inboxNeeds(inbox.counts, inbox.dueRows.length);
  const automations = useQuery({ ...automationsQuery(), retry: false });
  const workflows = useQuery({ ...workflowsQuery(), retry: false });
  const drift = useQuery({ ...driftQuery(system?.slug ?? ""), enabled: !!system, retry: false });
  const needs = agentNeeds({
    memoryDrafts: inbox.drafts.length, skillDrafts: inbox.skills.length,
    runs: automations.data?.runs ?? [], workflows: (workflows.data ?? []).filter((w) => !project || w.project === project.slug),
    drift: drift.data, behindShown: behind > 0, stale: inbox.kindTotals?.stale, duplicates: inbox.kindTotals?.duplicate, now: Date.now(),
  });
  const open = (n: Need) => (n.target.page === "inbox" ? openInbox(undefined, undefined, n.target.kind)
    : n.target.page === "architecture" ? openSystem(n.target.system) : openWorkflows({ tab: n.target.tab, run: n.target.run }));
  return (
    <Section title="Needs you" count={rows.length + (behind ? 1 : 0) + needs.length + captures.length} loading={due.isLoading || inbox.maintenanceLoading} error={due.error}
      empty={!due.isLoading && !inbox.maintenanceLoading && !rows.length && !behind && !needs.length && !captures.length ? "Nothing is waiting for you." : undefined}>
      {rows.filter((r) => r.kind === "code").map((r) => (
        <Row key={r.key} icon={<CodeXml size="1.3em" aria-hidden />} onClick={() => openInbox(undefined, undefined, r.kind)}>{r.text}</Row>
      ))}
      {behind > 0 && system && (
        <Row icon={<Layers size="1.3em" aria-hidden />} onClick={() => openSystem(system.slug)}>Architecture snapshot is {behind} commit{behind === 1 ? "" : "s"} behind</Row>
      )}
      {rows.filter((r) => r.kind !== "code").map((r) => (
        <Row key={r.key} icon={<Clock size="1.3em" aria-hidden />} onClick={() => openInbox(undefined, undefined, r.kind)}>{r.text}</Row>
      ))}
      {captures.map((b) => (
        <Row key={b.id} icon={<Inbox size="1.3em" aria-hidden />} onClick={() => openInbox(undefined, undefined, "captures")} meta={b.items.filter((i) => i.state === "pending").length || undefined}>
          Capture to review: {b.source.label}
        </Row>
      ))}
      {needs.map((n) => (
        <Row key={n.key} icon={<Bot size="1.3em" aria-hidden />} onClick={() => open(n)}>{n.text}</Row>
      ))}
    </Section>
  );
}

/** What agent sessions, workflows, automations and the skills library did lately. */
export function AgentActivity({ project }: { project?: Project }) {
  const sessions = useQuery(sessionsQuery());
  const workflows = useQuery({ ...workflowsQuery(), retry: false });
  const automations = useQuery({ ...automationsQuery(), retry: false });
  const ledger = useQuery({ queryKey: ["skills", "history", "*"], queryFn: () => skillHistory(), retry: false });
  const names = new Map((automations.data?.automations ?? []).map((a) => [a.id, a.name]));
  const items = agentActivity({
    sessions: (sessions.data ?? []).filter((s) => !project || s.project === project.slug),
    workflows: (workflows.data ?? []).filter((w) => !project || w.project === project.slug),
    runs: (automations.data?.runs ?? []).filter((r) => {
      const a = automations.data?.automations.find((x) => x.id === r.automation);
      return !project || !a?.project || a.project === project.slug;
    }),
    ledger: ledger.data ?? [], automationName: (id) => names.get(id) ?? "A removed automation",
  });
  return (
    <Section title="Agent activity" loading={sessions.isLoading} empty={!items.length ? "No agent activity yet." : undefined}>
      {items.map((a) => (
        <Row key={a.key} meta={ago(new Date(a.at).toISOString())}
          onClick={() => ("session" in a.target ? openSession(a.target.session) : "workflow" in a.target ? openWorkflows({ run: a.target.workflow })
            : "skill" in a.target ? openSkills(a.target.skill) : openWorkflows({ tab: "automations" }))}>{a.text}</Row>
      ))}
    </Section>
  );
}
