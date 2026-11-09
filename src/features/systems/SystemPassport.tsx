import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { agentAvailable, agentStart, sessionsQuery, type SessionInfo } from "../../lib/agent";
import { classify } from "../../lib/errors";
import { systemPlan, type NoteRow, type System } from "../../lib/lm";
import { sections } from "../../lib/note";
import { refreshStore } from "../../lib/refresh";
import { shortDate } from "../../lib/text";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { useWorkspace, type Tab } from "../../workspace/store";
import { PlanDialog } from "../plans/PlanDialog";
import { Card, NoteLink } from "../projects/ProjectDashboard";
import { buildBrief } from "./brief";
import { cloudResources, diagramList, externalSystems, interfaces, passportSections, proposalOf, proposedUpdate, techStack, type DiagramEntry } from "./passport";
import { SystemWizard } from "./SystemWizard";
import { useDiagram, useSystem } from "./useSystem";

const oneLine = (text?: string) => (text ?? "").replace(/\s+/g, " ").trim();
const MAX_ROWS = 40;
const DISMISSED = "hivemind.system-proposals-dismissed";

const dismissedProposals = (): string[] => { try { return JSON.parse(localStorage.getItem(DISMISSED) ?? "[]"); } catch { return []; } };
const dismissProposal = (sessionId: string) => { try { localStorage.setItem(DISMISSED, JSON.stringify([...dismissedProposals(), sessionId].slice(-50))); } catch { /* not persisted */ } };

function NoteList({ rows, badge }: { rows: NoteRow[]; badge?: boolean }) {
  return (
    <ul className="card-list">
      {rows.map((r) => (
        <li key={r.ref} className={r.status === "active" ? "" : "retired"}>
          <div className="row-line">
            {badge && <span className={`badge type-${r.type}`}>{r.type}</span>}
            <NoteLink row={r} />
            <span className="tabbar-fill" />
            {r.status !== "active" && <span className={`badge status-${r.status}`}>{r.status}</span>}
            <span className="muted small">{shortDate(r.updated)}</span>
          </div>
          {r.summary && <p className="muted small clamp">{oneLine(r.summary)}</p>}
        </li>
      ))}
    </ul>
  );
}

/** Start an agent session for the system, copy its brief, and review what the last session proposed. */
function AgentActions({ system, all }: { system: System; all: System[] }) {
  const client = useQueryClient();
  const available = useQuery({ queryKey: ["agent", "available"], queryFn: agentAvailable, retry: false, staleTime: 60_000 });
  const sessions = useQuery(sessionsQuery());
  const mine = (sessions.data ?? []).filter((s) => s.task.kind === "system_passport" && s.task.slug === system.slug);
  const latest: SessionInfo | undefined = mine[0];
  const running = latest?.status === "running";
  const [starting, setStarting] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [dismissed, setDismissed] = useState(dismissedProposals);

  // When a session for this system ends, its folder and notes have changed.
  const was = useRef(latest?.status);
  useEffect(() => {
    if (was.current === "running" && latest && latest.status !== "running") {
      client.invalidateQueries({ queryKey: ["architecture", system.slug] });
      refreshStore(client);
    }
    was.current = latest?.status;
  }, [latest?.status, latest, client, system.slug]);

  const proposer = mine.find((s) => s.status === "succeeded");
  const update = useMemo(
    () => (proposer && !dismissed.includes(proposer.id) ? proposedUpdate(system, proposalOf(proposer.structured), all.map((s) => s.slug)) : null),
    [proposer, dismissed, system, all],
  );

  const blocked = !system.repos.length ? "Add a repository to this system first."
    : !system.architecture ? "Set an architecture folder for this system first."
    : available.error ? String(available.error)
    : running ? "An agent session for this system is running."
    : null;
  const brief = () => buildBrief(system, all);

  const start = async () => {
    setStarting(true);
    try {
      const info = await agentStart({ kind: "system_passport", slug: system.slug }, brief());
      client.invalidateQueries({ queryKey: ["agent", "sessions"] });
      useWorkspace.getState().openSession(info.id, info.title);
    } catch (e) {
      toast(String(e), "error");
    } finally { setStarting(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(brief()); toast("Agent brief copied"); } catch { setFallback(brief()); }
  };

  return (
    <>
      <div className="agent-line">
        <button className="primary" disabled={!!blocked || starting} title={blocked ?? "Run Claude Code in the background to generate the architecture output"} onClick={start}>
          {starting ? "Starting…" : "Generate with agent"}
        </button>
        <button onClick={copy} title="Copy the same instructions to paste into an agent yourself">Copy agent brief</button>
        {latest && (
          <button className="link" onClick={() => useWorkspace.getState().openSession(latest.id, latest.title)}>
            Last session: {latest.status} · {new Date(latest.startedAt).toISOString().slice(0, 10)}
          </button>
        )}
        {blocked && !running && <span className="muted small">{blocked}</span>}
      </div>
      {update && proposer && (
        <div className="banner">
          The last agent session proposed changes to {Object.keys(update).filter((k) => k !== "slug").join(", ").replace(/_/g, " ")}.
          <span className="tabbar-fill" />
          <button className="primary" onClick={() => setReviewing(true)}>Review…</button>
          <button className="ghost" onClick={() => { dismissProposal(proposer.id); setDismissed(dismissedProposals()); }}>Dismiss</button>
        </div>
      )}
      {reviewing && update && (
        <PlanDialog title={`Update system ${system.name}`} applyLabel="Update system"
          intro={<p>These are the registry fields the agent proposed. Nothing changes until you apply the plan.</p>}
          make={() => systemPlan("update", update)}
          onApplied={() => { client.invalidateQueries({ queryKey: ["systems"] }); toast(`Updated ${system.name}`); }}
          onClose={() => setReviewing(false)} />
      )}
      {fallback !== null && (
        <Modal title="Agent brief" wide onClose={() => setFallback(null)}>
          <p className="muted small">The clipboard is not available here. Select the text and copy it.</p>
          <textarea className="briefing-text" readOnly value={fallback} autoFocus onFocus={(e) => e.currentTarget.select()} />
        </Modal>
      )}
    </>
  );
}

function Overview({ system, all, summary }: { system: System; all: System[]; summary?: string }) {
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  return (
    <section className="dash-card overview">
      <header className="card-head">
        <h2>{system.name}</h2>
        <span className={`badge status-${system.status}`}>{system.status}</span>
        <span className="tabbar-fill" />
        <div className="card-actions">
          {system.passport && <button onClick={() => useWorkspace.getState().openNote(system.passport!, { title: `${system.name} passport` })}>Open passport note</button>}
          <button onClick={() => useWorkspace.getState().openTab({ kind: "new-note", init: { tags: [system.tag] } })}>New note</button>
          <button onClick={() => setEditing(true)}>Edit</button>
          {system.status !== "retired" && <button onClick={() => setRetiring(true)}>Retire…</button>}
        </div>
      </header>
      <div className="card-body overview-body">
        {system.description ? <p className="project-desc">{system.description}</p> : <p className="muted small">No purpose recorded yet.</p>}
        {!!system.capabilities.length && <ul className="capabilities">{system.capabilities.map((c) => <li key={c}>{c}</li>)}</ul>}
        <div className="row-line">
          <span className="muted small">Owners</span>
          {system.owners.length ? <span className="chips">{system.owners.map((o) => <span key={o} className="chip">{o}</span>)}</span> : <span className="muted small">none recorded</span>}
        </div>
        {!!system.repos.length && <div className="repo-list">{system.repos.map((r) => <code key={r}>{r}</code>)}</div>}
        {summary && summary.trim() !== system.description.trim() && <div className="markdown small"><Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown></div>}
        <AgentActions system={system} all={all} />
      </div>
      {editing && <SystemWizard mode="edit" system={system} onClose={() => setEditing(false)} />}
      {retiring && (
        <PlanDialog title={`Retire ${system.name}`} applyLabel="Retire" danger
          intro={<p>The system is marked retired. Its notes, tag and architecture folder stay in place.</p>}
          make={() => systemPlan("retire", { slug: system.slug })}
          onApplied={() => { toast(`Retired ${system.name}`); setRetiring(false); }} onClose={() => setRetiring(false)} />
      )}
    </section>
  );
}

function SystemChips({ slugs, all, empty }: { slugs: string[]; all: System[]; empty: string }) {
  if (!slugs.length) return <span className="muted small">{empty}</span>;
  return (
    <span className="chips">
      {slugs.map((slug) => {
        const found = all.find((s) => s.slug === slug);
        return (
          <button key={slug} className="chip project" title={found?.description || slug} onClick={() => useWorkspace.getState().openSystem(slug, found?.name)}>
            {found?.name ?? slug}{found && found.status !== "active" ? ` (${found.status})` : ""}
          </button>
        );
      })}
    </span>
  );
}

function Diagrams({ slug, entries, version }: { slug: string; entries: DiagramEntry[]; version: number | null }) {
  const preferred = entries.find((e) => e.key.endsWith("/containers")) ?? entries[0];
  const [picked, setPicked] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const current = entries.find((e) => e.key === picked) ?? preferred;
  const image = useDiagram(slug, current?.path ?? "", version, !!current);
  if (!current) return null;
  const levels = [...new Set(entries.map((e) => e.level))];
  const picture = image.isLoading ? <p className="muted small">Loading diagram…</p>
    : image.error ? <p className="error small">{String(image.error)}</p>
    : <img src={image.data} alt={current.title} />;
  return (
    <div className="diagrams">
      <nav className="diagram-list">
        {levels.map((level) => (
          <div key={level}>
            <div className="muted small triage-label">{level}</div>
            {entries.filter((e) => e.level === level).map((e) => (
              <button key={e.key} className={`tree-item ${e.key === current.key ? "on" : ""}`} title={e.path} onClick={() => setPicked(e.key)}>{e.title}</button>
            ))}
          </div>
        ))}
      </nav>
      <button className="diagram-frame" title="Click to enlarge" onClick={() => setZoomed(true)}>{picture}</button>
      {zoomed && <Modal title={current.title} wide onClose={() => setZoomed(false)}><div className="diagram-zoom">{picture}</div></Modal>}
    </div>
  );
}

export function SystemPassport({ tab }: { tab: Tab }) {
  const slug = tab.slug;
  const { enabled, registry, system, rows, passport, architecture, loading } = useSystem(slug);
  const updateTab = useWorkspace((s) => s.updateTab);
  useEffect(() => { if (system && tab.title !== system.name) updateTab(tab.id, { title: system.name }); }, [system?.name, tab.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const members = rows.data?.notes ?? [];
  const parts = useMemo(() => passportSections(members, system?.passport ?? null), [members, system?.passport]);
  const arch = architecture.data;
  const model = arch?.model ?? null;
  const stack = useMemo(() => techStack(model), [model]);
  const outside = useMemo(() => externalSystems(model), [model]);
  const io = useMemo(() => interfaces(model, arch?.inventory ?? null), [model, arch?.inventory]);
  const cloud = useMemo(() => cloudResources(model, arch?.topology ?? null), [model, arch?.topology]);
  const diagrams = useMemo(() => diagramList(arch?.diagrams ?? [], model), [arch?.diagrams, model]);

  if (!enabled) return <p className="muted pad">Systems need a newer Living Memory (one with the <code>systems</code> command).</p>;
  if (loading) return <p className="muted pad">Loading…</p>;
  if (registry.error) return <p className="error pad">{classify(registry.error).message}</p>;
  if (!system) return <p className="muted pad">There is no system named <code>{slug}</code>. It may have been removed; pick another from the Systems list.</p>;

  const all = registry.data?.systems ?? [];
  // An architecture card with nothing in it says why: nothing generated yet, or the model simply has none.
  const archEmpty = (has: boolean, none: string) =>
    (has ? undefined : !arch?.error ? none : `${arch.error} ${system.architecture ? "Use “Generate with agent” above." : "Edit the system to choose one."}`);
  const archProps = { loading: architecture.isLoading, error: architecture.error };
  const generated = arch?.generatedAt ? `Generated ${new Date(arch.generatedAt).toISOString().slice(0, 10)}${arch.toolVersion ? ` · Architecture Suite ${arch.toolVersion}` : ""}` : undefined;
  const newRunbook = () => useWorkspace.getState().openTab({ kind: "new-note", init: { type: "runbook", tags: [system.tag] } });

  return (
    <div className="project-dash">
      <Overview system={system} all={all} summary={passport.data ? sections(passport.data.body).summary : undefined} />
      <div className="project-grid">
        <Card title="Dependencies">
          <div className="row-line"><span className="muted small dep-label">Depends on</span><SystemChips slugs={system.depends_on} all={all} empty="nothing registered" /></div>
          <div className="row-line"><span className="muted small dep-label">Used by</span><SystemChips slugs={system.dependents} all={all} empty="nothing registered" /></div>
          {!!outside.length && (
            <>
              <h4 className="card-sub">From the architecture model</h4>
              <ul className="card-list compact">
                {outside.map((e) => (
                  <li key={e.name}>
                    <div className="row-line">
                      <span className="badge">{e.kind === "person" ? "person" : e.uses && e.usedBy ? "both ways" : e.uses ? "upstream" : e.usedBy ? "downstream" : "external"}</span>
                      <strong>{e.name}</strong>
                    </div>
                    {e.description && <p className="muted small clamp">{e.description}</p>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        <Card title="Technology stack" count={stack.length || undefined} {...archProps} empty={archEmpty(!!stack.length, "The model names no technologies.")}>
          <ul className="card-list compact">
            {stack.map((t) => (
              <li key={t.technology}><div className="row-line"><strong>{t.technology}</strong><span className="muted small clamp">{t.elements.join(", ")}</span></div></li>
            ))}
          </ul>
        </Card>
        <Card title="APIs and events" count={io.flows.length + io.routes.length || undefined} {...archProps}
          empty={archEmpty(!!(io.flows.length + io.routes.length), "The model shows no interactions across the system boundary, and no route inventory was generated.")}>
          {!!io.flows.length && (
            <ul className="card-list compact">
              {io.flows.slice(0, MAX_ROWS).map((f, i) => (
                <li key={i}>
                  <div className="row-line"><span className="badge">{f.direction === "in" ? "inbound" : "outbound"}</span><span>{f.from} → {f.to}</span>{f.technology && <code>{f.technology}</code>}</div>
                  {f.description && <p className="muted small clamp">{f.description}</p>}
                </li>
              ))}
            </ul>
          )}
          {!!io.routes.length && (
            <>
              <h4 className="card-sub">Routes declared in code · {io.routes.length}</h4>
              <ul className="card-list compact">
                {io.routes.slice(0, MAX_ROWS).map((r) => (
                  <li key={r.path + r.reference}><div className="row-line"><code>{r.path}</code><span className="muted small clamp">{r.reference}{r.line ? `:${r.line}` : ""}</span></div></li>
                ))}
              </ul>
              {io.routes.length > MAX_ROWS && <p className="muted small">and {io.routes.length - MAX_ROWS} more</p>}
            </>
          )}
        </Card>
        <Card title="Cloud resources" count={cloud.elements.length + cloud.resources.length || undefined} {...archProps}
          empty={archEmpty(!!(cloud.elements.length + cloud.resources.length), "The model names no cloud services, and no infrastructure was imported.")}>
          <ul className="card-list compact">
            {cloud.elements.map((e) => (
              <li key={e.name}><div className="row-line"><span className="badge">{e.provider}</span><strong>{e.service}</strong><span className="muted small clamp">{e.name}</span></div></li>
            ))}
            {cloud.resources.map((r) => (
              <li key={r.type}><div className="row-line"><code>{r.type}</code><span className="muted small">{r.count}</span><span className="muted small clamp">{r.ids.join(", ")}</span></div></li>
            ))}
          </ul>
        </Card>
        <Card title="Architecture diagrams" className="wide" count={diagrams.length || undefined} {...archProps}
          actions={generated && <span className="muted small">{generated}</span>}
          empty={archEmpty(!!diagrams.length, "The folder has a model but no SVG or PNG diagrams.")}>
          <Diagrams slug={system.slug} entries={diagrams} version={arch?.generatedAt ?? null} />
        </Card>
        <Card title="Operational runbooks" count={parts.runbooks.length} loading={rows.isLoading} error={rows.error}
          actions={<button className="ghost small" onClick={newRunbook}>New runbook</button>}
          empty={!parts.runbooks.length ? "No runbooks yet. A runbook is a note of type runbook tagged with this system." : undefined}>
          <NoteList rows={parts.runbooks} />
        </Card>
        <Card title="Architectural decisions" count={parts.decisions.length} loading={rows.isLoading} error={rows.error}
          empty={!parts.decisions.length ? "No decisions recorded for this system." : undefined}>
          <NoteList rows={parts.decisions} />
        </Card>
        <Card title="Weaknesses and tech debt" count={parts.weaknesses.length} loading={rows.isLoading} error={rows.error}
          empty={!parts.weaknesses.length ? "No risks or bugs recorded for this system." : undefined}>
          <NoteList rows={parts.weaknesses} badge />
        </Card>
      </div>
    </div>
  );
}
