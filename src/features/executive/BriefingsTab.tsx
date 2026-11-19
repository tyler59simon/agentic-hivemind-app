// Briefings: generate a weekly report, project summary, priorities, commitments or risk assessment from the evidence, read
// it with its citations and gaps, copy or export it, and keep it as a status note.
import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Copy, Download, LoaderCircle, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { copyText } from "../../lib/clipboard";
import { brief, BRIEFING_KINDS, deleteRecord, exportText, type Briefing, type BriefingKind } from "../../lib/executive";
import { capture, type Project } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { openExecutive, openWorkflows } from "../../store";
import { Confirm } from "../../ui/Modal";
import { Section, Split } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { domainOf, tagsFor } from "./items";
import { EvidenceList, Gaps } from "./parts";
import { allGaps, briefingMarkdown, numbered, unsupported } from "./texts";
import { useRecords, useStoreFacts } from "./useExecutive";

export const BRIEFING_LABEL: Record<BriefingKind, string> = {
  weekly: "Weekly leadership report", project: "Project summary", priorities: "Priorities", commitments: "Outstanding commitments", risks: "Risk assessment",
};
const PERIODS = [7, 14, 30];
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function BriefingView({ b, projects }: { b: Briefing; projects: Project[] }) {
  const client = useQueryClient();
  const facts = useStoreFacts();
  const [confirm, setConfirm] = useState<"delete" | "status" | null>(null);
  const { summary, sections, cited, numbers } = numbered(b);
  const project = projects.find((p) => p.slug === b.project);
  const loose = unsupported(b);
  const markdown = briefingMarkdown(b);

  const saveStatus = async () => {
    if (!project) return;
    try {
      const r = await capture(domainOf(project, facts.defaultDomain), { title: `${project.name} status: ${b.title}`, body: `${b.summary}\n\n${markdown.split("\n").slice(4).join("\n")}`, type: "status", tags: tagsFor("status", project, facts.known) });
      recordOperation(r.operation_id);
      await refreshStore(client);
      toast("Saved as a status note in Living Memory");
    } catch (e) { toast(String(e), "error"); }
  };

  return (
    <article className="exec-briefing">
      <header>
        <h2>{b.title}</h2>
        <p className="muted small">
          {BRIEFING_LABEL[b.kind]} · {project?.name ?? "All projects"} · last {b.days} days · {when(b.created)}{b.origin.startsWith("automation:") ? " · scheduled" : ""}
        </p>
      </header>
      <p className="exec-lead">{summary}</p>
      {sections.map((s) => (
        <section key={s.heading}>
          <h3>{s.heading}</h3>
          <ul>
            {s.bullets.map((x, i) => (
              <li key={i} className={x.nums.length ? "" : "exec-uncited"}>
                {x.text}{" "}
                {x.nums.length ? <span className="exec-cite">[{x.nums.join(", ")}]</span> : <span className="muted small" title="The model cited no evidence for this line">no evidence</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {loose > 0 && <p className="muted small">{loose} line{loose === 1 ? "" : "s"} cite no evidence. Check them before you send this on.</p>}
      <Gaps gaps={allGaps(b)} />
      <h3>Sources</h3>
      <EvidenceList evidence={cited} numbers={numbers} />
      <div className="actions">
        <button onClick={() => setConfirm("delete")}><Trash2 size="1em" aria-hidden /> Delete</button>
        {project && <button onClick={() => setConfirm("status")}>Save as status note</button>}
        <button onClick={() => exportText(b.title, "md", markdown).then((p) => p && toast(`Saved ${p}`)).catch((e) => toast(String(e), "error"))}><Download size="1em" aria-hidden /> Export</button>
        <button className="primary" onClick={() => copyText(markdown, "Briefing copied as Markdown")}><Copy size="1em" aria-hidden /> Copy</button>
      </div>
      {confirm === "delete" && <Confirm title="Delete this briefing?" message="It is removed from Hivemind. Notes it cites are not touched." action="Delete" danger
        onAnswer={(yes) => { setConfirm(null); if (yes) deleteRecord("briefing", b.id).then(() => openExecutive({ tab: "briefings" })).catch((e) => toast(String(e), "error")); }} />}
      {confirm === "status" && project && <Confirm title="Save as a status note?" message={`Living Memory gets a new status note for ${project.name} with this briefing's text. Agents and later briefings read it as the project's latest status.`} action="Save"
        onAnswer={(yes) => { setConfirm(null); if (yes) saveStatus(); }} />}
    </article>
  );
}

export function BriefingsTab({ project, projects, picked }: { project?: Project; projects: Project[]; picked?: string }) {
  const briefings = useRecords<Briefing>("briefing");
  const [kind, setKind] = useState<BriefingKind>(project ? "project" : "weekly");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const mine = (briefings.data ?? []).filter((b) => !project || b.project === project.slug);
  const shown = mine.find((b) => b.id === picked) ?? mine[0];
  const generate = async () => {
    setBusy(true);
    try {
      const b = await brief(kind, project?.slug ?? null, days);
      openExecutive({ tab: "briefings", briefing: b.id });
    } catch (e) { toast(String(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <Split rail={
      <>
        <Section title="New briefing">
          <div className="exec-form">
            <label className="field"><span>Kind</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as BriefingKind)} disabled={busy}>
                {BRIEFING_KINDS.map((k) => <option key={k} value={k}>{BRIEFING_LABEL[k]}</option>)}
              </select>
            </label>
            <label className="field"><span>Period</span>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} disabled={busy}>
                {PERIODS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
              </select>
            </label>
            <p className="muted small">About {project?.name ?? "all active projects"}. Pick a project in the sidebar to narrow it. It reads Living Memory and your milestones and health, and takes about a minute.</p>
            <button className="primary" onClick={generate} disabled={busy}>
              {busy ? <><LoaderCircle className="spin" size="1em" aria-hidden /> Writing</> : <><Sparkles size="1em" aria-hidden /> Generate</>}
            </button>
            <button className="link small" onClick={() => openWorkflows({ tab: "automations" })}><CalendarClock size="1em" aria-hidden /> Schedule a weekly briefing in Automations</button>
          </div>
        </Section>
        <Section title="Earlier briefings" count={mine.length} empty={mine.length ? undefined : "None yet."}>
          <ul className="item-list">
            {mine.map((b) => (
              <li key={b.id}>
                <button className={`item-row ${b.id === shown?.id ? "on" : ""}`} onClick={() => openExecutive({ tab: "briefings", briefing: b.id })}>
                  <span className="grow">{b.title}<br /><span className="muted small">{BRIEFING_LABEL[b.kind]} · {when(b.created)}</span></span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      </>
    }>
      <Section loading={briefings.isLoading} error={briefings.error}>
        {shown ? <BriefingView key={shown.id} b={shown} projects={projects} /> : <p className="muted">No briefing yet. Generate one to see what changed, what is overdue and what needs you.</p>}
      </Section>
    </Split>
  );
}
