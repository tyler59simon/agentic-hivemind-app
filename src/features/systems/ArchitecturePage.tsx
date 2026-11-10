import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Ellipsis, MessageCircle, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { agentAvailable, agentStart } from "../../lib/agent";
import type { ArchModel } from "../../lib/architecture";
import { useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import { systemPlan, type NoteRow, type System } from "../../lib/lm";
import { sections } from "../../lib/note";
import { refreshStore } from "../../lib/refresh";
import { shortDate } from "../../lib/text";
import { openSession, openSystem, useApp } from "../../store";
import { Menu } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { PageHeader, Section, Split } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { PlanDialog } from "../plans/PlanDialog";
import { NoteLink } from "../preview/NoteLink";
import { systemsForProject } from "../projects/scope";
import { useCurrentProject } from "../projects/useProject";
import { ArchitectureCanvas, kindLine } from "./ArchitectureCanvas";
import { buildBrief } from "./brief";
import type { CanvasNode } from "./canvas";
import { cloudResources, diagramList, externalSystems, interfaces, passportSections, techStack, type DiagramEntry } from "./passport";
import { SystemWizard } from "./SystemWizard";
import { systemsQuery, useDiagram, useSystem, useSystemIntent, useSystemProposal } from "./useSystem";

const oneLine = (text?: string) => (text ?? "").replace(/\s+/g, " ").trim();
const MAX_ROWS = 40;

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
  const { latest, update, fields, dismiss } = useSystemProposal(system, all);
  const running = latest?.status === "running";
  const [starting, setStarting] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  // When a session for this system ends, its folder and notes have changed.
  const was = useRef(latest?.status);
  useEffect(() => {
    if (was.current === "running" && latest && latest.status !== "running") {
      client.invalidateQueries({ queryKey: ["architecture", system.slug] });
      refreshStore(client);
    }
    was.current = latest?.status;
  }, [latest?.status, latest, client, system.slug]);

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
      openSession(info.id);
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
          <MessageCircle size="1.15em" aria-hidden />{starting ? "Starting…" : "Generate with agent"}
        </button>
        <button onClick={copy} title="Copy the same instructions to paste into an agent yourself">Copy agent brief</button>
        {latest && (
          <button className="link" onClick={() => openSession(latest.id)}>
            Last session: {latest.status} · {new Date(latest.startedAt).toISOString().slice(0, 10)}
          </button>
        )}
        {blocked && !running && <span className="muted small">{blocked}</span>}
      </div>
      {update && (
        <div className="banner">
          The last agent session proposed changes to {fields}.
          <div className="actions">
            <button className="primary" onClick={() => setReviewing(true)}>Review…</button>
            <button className="ghost" onClick={dismiss}>Dismiss</button>
          </div>
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

function SystemChips({ slugs, all, empty }: { slugs: string[]; all: System[]; empty: string }) {
  if (!slugs.length) return <span className="muted small">{empty}</span>;
  return (
    <span className="chips">
      {slugs.map((slug) => {
        const found = all.find((s) => s.slug === slug);
        return (
          <button key={slug} className="chip project" title={found?.description || slug} onClick={() => openSystem(slug)}>
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

/** What is known about the box selected on the canvas: what it is, what it talks to, and the decisions that mention it. */
function Inspector({ node, model, decisions, onClose }: { node: CanvasNode; model: ArchModel; decisions: NoteRow[]; onClose: () => void }) {
  const names = useMemo(() => new Map((model.elements ?? []).map((e) => [e.id, e.name])), [model]);
  const flows = (model.relationships ?? []).filter((r) => r.source_id === node.id || r.destination_id === node.id);
  const name = node.name.toLowerCase();
  const mentions = decisions.filter((d) => `${d.title} ${d.summary ?? ""}`.toLowerCase().includes(name));
  return (
    <Section title={node.name} actions={<button className="icon-button" aria-label="Close" title="Back to the system" onClick={onClose}><X size="1.1em" aria-hidden /></button>}>
      <p className="muted">{kindLine(node)}</p>
      {node.description && <p>{node.description}</p>}
      <h4 className="card-sub">Decisions that mention it</h4>
      {mentions.length ? <NoteList rows={mentions} /> : <p className="muted small">None of this system's decisions mention {node.name} by name.</p>}
      {!!flows.length && (
        <>
          <h4 className="card-sub">Talks to</h4>
          <ul className="card-list compact">
            {flows.slice(0, 12).map((r) => (
              <li key={r.id}>
                <div className="row-line">
                  <span>{r.source_id === node.id ? node.name : names.get(r.source_id) ?? r.source_id}</span><ArrowRight size="1em" aria-hidden />
                  <span>{r.destination_id === node.id ? node.name : names.get(r.destination_id) ?? r.destination_id}</span>
                  {r.technology && <code>{r.technology}</code>}
                </div>
                {r.description && <p className="muted small clamp">{r.description}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function SystemView({ system, all }: { system: System; all: System[] }) {
  const { rows, passport, architecture } = useSystem(system.slug);
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [picked, setPicked] = useState<CanvasNode | null>(null);
  const members = rows.data?.notes ?? [];
  const parts = useMemo(() => passportSections(members, system.passport), [members, system.passport]);
  const arch = architecture.data;
  const model = arch?.model ?? null;
  const stack = useMemo(() => techStack(model), [model]);
  const outside = useMemo(() => externalSystems(model), [model]);
  const io = useMemo(() => interfaces(model, arch?.inventory ?? null), [model, arch?.inventory]);
  const cloud = useMemo(() => cloudResources(model, arch?.topology ?? null), [model, arch?.topology]);
  const diagrams = useMemo(() => diagramList(arch?.diagrams ?? [], model), [arch?.diagrams, model]);
  const summary = passport.data ? sections(passport.data.body).summary : undefined;

  // An architecture section with nothing in it says why: nothing generated yet, or the model simply has none.
  const archEmpty = (has: boolean, none: string) =>
    (has ? undefined : !arch?.error ? none : `${arch.error} ${system.architecture ? "Use “Generate with agent” above." : "Edit the system to choose one."}`);
  const archProps = { loading: architecture.isLoading, error: architecture.error };
  const generated = arch?.generatedAt ? `Generated ${new Date(arch.generatedAt).toISOString().slice(0, 10)}${arch.toolVersion ? ` · Architecture Suite ${arch.toolVersion}` : ""}` : undefined;
  const newNote = (type?: "runbook") => useWorkspace.getState().openTab({ kind: "new-note", init: { type, tags: [system.tag] } });

  return (
    <>
      <Split rail={<>
        {picked && model && <Inspector node={picked} model={model} decisions={parts.decisions} onClose={() => setPicked(null)} />}
        <Section title={system.name} actions={
          <Menu label="System actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
            {(close) => (
              <>
                {system.passport && <li role="none"><button role="menuitem" onClick={() => { close(); useWorkspace.getState().openNote(system.passport!, { title: `${system.name} passport` }); }}>Open passport note</button></li>}
                <li role="none"><button role="menuitem" onClick={() => { close(); newNote(); }}>New note for this system</button></li>
                <li role="none"><button role="menuitem" onClick={() => { close(); setEditing(true); }}>Edit system…</button></li>
                {system.status !== "retired" && <li role="none"><button role="menuitem" className="danger-text" onClick={() => { close(); setRetiring(true); }}>Retire…</button></li>}
              </>
            )}
          </Menu>}>
          <p className="muted"><span className={`status-chip cap ${system.status}`}>{system.status}</span> {system.repos.length ? "System" : "External system"}</p>
          {system.description ? <p>{system.description}</p> : <p className="muted">No purpose recorded yet.</p>}
          {!!system.capabilities.length && <ul className="capabilities">{system.capabilities.map((c) => <li key={c}>{c}</li>)}</ul>}
          <div className="row-line"><span className="muted small dep-label">Owners</span>
            {system.owners.length ? <span className="chips">{system.owners.map((o) => <span key={o} className="chip">{o}</span>)}</span> : <span className="muted small">none recorded</span>}
          </div>
          {!!system.repos.length && <div className="repo-list">{system.repos.map((r) => <code key={r}>{r}</code>)}</div>}
          {summary && summary.trim() !== system.description.trim() && <div className="markdown small"><Markdown remarkPlugins={[remarkGfm]}>{summary}</Markdown></div>}
        </Section>
        <Section title="Decisions" count={parts.decisions.length} loading={rows.isLoading} error={rows.error}
          empty={!parts.decisions.length ? "No decisions recorded for this system." : undefined}>
          <NoteList rows={parts.decisions} />
        </Section>
        <Section title="Runbooks" count={parts.runbooks.length} loading={rows.isLoading} error={rows.error}
          actions={<button className="text" onClick={() => newNote("runbook")}><Plus size="1.1em" aria-hidden />New</button>}
          empty={!parts.runbooks.length ? "No runbooks yet. A runbook is a note of type runbook tagged with this system." : undefined}>
          <NoteList rows={parts.runbooks} />
        </Section>
        <Section title="Weaknesses and tech debt" count={parts.weaknesses.length} loading={rows.isLoading} error={rows.error}
          empty={!parts.weaknesses.length ? "No risks or bugs recorded for this system." : undefined}>
          <NoteList rows={parts.weaknesses} badge />
        </Section>
      </>}>
        <AgentActions system={system} all={all} />
        {model?.elements?.length ? (
          <>
            <ArchitectureCanvas slug={system.slug} model={model} diagrams={diagrams} version={arch?.generatedAt ?? null} caption={generated}
              selected={picked?.id ?? null} onSelect={setPicked} />
            {!!diagrams.length && (
              <details className="rail-more">
                <summary>All generated diagrams ({diagrams.length})</summary>
                <Diagrams slug={system.slug} entries={diagrams} version={arch?.generatedAt ?? null} />
              </details>
            )}
          </>
        ) : (
          <Section title="Diagrams" count={diagrams.length || undefined} {...archProps}
            actions={generated && <span className="muted small">{generated}</span>}
            empty={archEmpty(!!diagrams.length, "The folder has a model but no SVG or PNG diagrams.")}>
            <Diagrams slug={system.slug} entries={diagrams} version={arch?.generatedAt ?? null} />
          </Section>
        )}
        <Section title="Dependencies">
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
        </Section>
        <Section title="Technology stack" count={stack.length || undefined} {...archProps} empty={archEmpty(!!stack.length, "The model names no technologies.")}>
          <ul className="card-list compact">
            {stack.map((t) => (
              <li key={t.technology}><div className="row-line"><strong>{t.technology}</strong><span className="muted small clamp">{t.elements.join(", ")}</span></div></li>
            ))}
          </ul>
        </Section>
        <Section title="APIs and events" count={io.flows.length + io.routes.length || undefined} {...archProps}
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
        </Section>
        <Section title="Cloud resources" count={cloud.elements.length + cloud.resources.length || undefined} {...archProps}
          empty={archEmpty(!!(cloud.elements.length + cloud.resources.length), "The model names no cloud services, and no infrastructure was imported.")}>
          <ul className="card-list compact">
            {cloud.elements.map((e) => (
              <li key={e.name}><div className="row-line"><span className="badge">{e.provider}</span><strong>{e.service}</strong><span className="muted small clamp">{e.name}</span></div></li>
            ))}
            {cloud.resources.map((r) => (
              <li key={r.type}><div className="row-line"><code>{r.type}</code><span className="muted small">{r.count}</span><span className="muted small clamp">{r.ids.join(", ")}</span></div></li>
            ))}
          </ul>
        </Section>
      </Split>
      {editing && <SystemWizard mode="edit" system={system} onClose={() => setEditing(false)} />}
      {retiring && (
        <PlanDialog title={`Retire ${system.name}`} applyLabel="Retire" danger
          intro={<p>The system is marked retired. Its notes, tag and architecture folder stay in place.</p>}
          make={() => systemPlan("retire", { slug: system.slug })}
          onApplied={() => { toast(`Retired ${system.name}`); setRetiring(false); }} onClose={() => setRetiring(false)} />
      )}
    </>
  );
}

/** Architecture: the system behind the picked project (or any system from the list), its diagrams and what is known about it. */
export function ArchitecturePage() {
  const enabled = useSystemsEnabled();
  const routed = useApp((s) => (s.route.page === "architecture" ? s.route.system : undefined));
  const registry = useQuery({ ...systemsQuery(), enabled });
  const { project } = useCurrentProject();
  const { wizard, openWizard, closeWizard } = useSystemIntent();
  const all = registry.data?.systems ?? [];
  const live = all.filter((s) => s.status !== "retired");
  const matched = useMemo(() => (project ? systemsForProject(project, live) : []), [project, live]);
  const system = all.find((s) => s.slug === routed) ?? matched[0] ?? (project ? undefined : live[0]);
  const warnings = registry.data?.warnings ?? [];

  return (
    <div className="page">
      <PageHeader title="Architecture" subtitle="Explore the system and the decisions behind it."
        actions={enabled && <>
          {!!all.length && (
            <select value={system?.slug ?? ""} onChange={(e) => openSystem(e.target.value)} aria-label="System">
              {!system && <option value="">Choose a system…</option>}
              {!!matched.length && <optgroup label="This project">{matched.map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}</optgroup>}
              <optgroup label={matched.length ? "Other systems" : "Systems"}>
                {all.filter((s) => !matched.includes(s)).map((s) => <option key={s.slug} value={s.slug}>{s.name}{s.status !== "active" ? ` (${s.status})` : ""}</option>)}
              </optgroup>
            </select>
          )}
          <button className="text" onClick={openWizard}><Plus size="1.1em" aria-hidden />New system</button>
        </>} />
      {!enabled ? <p className="muted">Systems need a newer Living Memory (one with the <code>systems</code> command).</p>
        : registry.isLoading ? <p className="muted">Loading…</p>
        : registry.error ? <p className="error">{classify(registry.error).message}</p>
        : (
          <>
            {!!warnings.length && <div className="banner warn"><ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
            {system ? <SystemView key={system.slug} system={system} all={all} />
              : (
                <div className="empty-state">
                  <p className="muted">{project && all.length
                    ? `No system is registered for the repositories of ${project.name}. Pick one from the list, or register one.`
                    : "No systems yet. A system is something you run or depend on: a service, an app, a platform."}</p>
                  <button className="primary" onClick={openWizard}><Plus size="1.15em" aria-hidden />New system</button>
                </div>
              )}
          </>
        )}
      {wizard && <SystemWizard mode="create" onClose={closeWizard} onDone={(slug) => openSystem(slug)} />}
    </div>
  );
}
