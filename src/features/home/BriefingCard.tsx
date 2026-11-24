// Home's briefing: the newest briefing for the scope, a button to write one now, a daily morning schedule, and the older ones
// behind "All briefings". A briefing opens in a modal with its citations and gaps, and can be copied, exported or kept as a status note.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, LoaderCircle, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { copyText } from "../../lib/clipboard";
import { classify } from "../../lib/errors";
import { brief, BRIEFING_LABEL, deleteRecord, exportText, type Briefing } from "../../lib/executive";
import { capture, type Project } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { useApp } from "../../store";
import { Confirm, Modal } from "../../ui/Modal";
import { Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { automationPut, automationsQuery, type Automation } from "../../lib/automations";
import { useShownEngines } from "../agents/engines";
import { domainOf, tagsFor } from "../executive/items";
import { EvidenceList, Gaps } from "../executive/parts";
import { allGaps, briefingMarkdown, numbered, unsupported } from "../executive/texts";
import { useRecords, useStoreFacts } from "../executive/useExecutive";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** One briefing with its citations and gaps: copy, export, keep as a status note, or delete. */
export function BriefingView({ b, projects, onDeleted }: { b: Briefing; projects: Project[]; onDeleted: () => void }) {
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
        onAnswer={(yes) => { setConfirm(null); if (yes) deleteRecord("briefing", b.id).then(onDeleted).catch((e) => toast(String(e), "error")); }} />}
      {confirm === "status" && project && <Confirm title="Save as a status note?" message={`Living Memory gets a new status note for ${project.name} with this briefing's text. Agents and later briefings read it as the project's latest status.`} action="Save"
        onAnswer={(yes) => { setConfirm(null); if (yes) saveStatus(); }} />}
    </article>
  );
}

const MORNING = "Morning briefing";

/** The daily automation that writes the "priorities" briefing at 08:00 for the scope, if one was made. */
const morningOf = (automations: Automation[], project: string | null) =>
  automations.find((a) => a.name === MORNING && a.action.kind === "executive_briefing" && (a.project || null) === project);

/** A new morning briefing for the scope (a project, or null for all active projects); also made from Settings > Schedules. */
export const morningBriefing = (project: string | null, enabled: boolean): Automation => ({
  id: "", name: MORNING, enabled, trigger: { kind: "daily", at: 8 * 60 }, action: { kind: "executive_briefing", briefing: "priorities", days: 1 },
  project, repo: null, askFirst: false, notify: "failures", budgetUsd: 1, createdAt: 0, lastRun: null, nextDue: null, lastSeen: null,
});

/** Turn the scope's morning briefing on or off: the first time it makes the automation, after that it flips `enabled`. */
function MorningToggle({ project }: { project: Project | undefined }) {
  const client = useQueryClient();
  const automations = useQuery({ ...automationsQuery(), retry: false });
  const [busy, setBusy] = useState(false);
  const found = morningOf(automations.data?.automations ?? [], project?.slug ?? null);
  const toggle = async (on: boolean) => {
    if (automations.isError) return;
    setBusy(true);
    try {
      await automationPut(found ? { ...found, enabled: on } : morningBriefing(project?.slug ?? null, on));
      await client.invalidateQueries({ queryKey: ["automations"] });
    } catch (e) { toast(classify(e).message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <>
      <label className="check" title="Writes a priorities briefing every day at 08:00 while Hivemind is open or in the tray">
        <input type="checkbox" checked={!!found?.enabled} disabled={busy || automations.isLoading || automations.isError} onChange={(e) => void toggle(e.target.checked)} /> Write one every morning at 8:00
      </label>
      {automations.isError && <p className="error small">Could not load briefing schedule: {classify(automations.error).message}</p>}
    </>
  );
}

/** The briefing the route names, in a modal, or the list of every briefing of the scope when the route asks for it. */
export function BriefingModals({ project, projects }: { project: Project | undefined; projects: Project[] }) {
  const route = useApp((s) => (s.route.page === "home" ? s.route : undefined));
  const go = useApp((s) => s.go);
  const briefings = useRecords<Briefing>("briefing");
  const mine = (briefings.data ?? []).filter((b) => (b.project ?? null) === (project?.slug ?? null));
  const shown = route?.briefing ? (briefings.data ?? []).find((b) => b.id === route.briefing) : undefined;
  const close = () => go({ page: "home" }, { replace: true });
  if (shown) {
    return <Modal title="Briefing" wide onClose={() => go({ page: "home" })}><BriefingView key={shown.id} b={shown} projects={projects} onDeleted={close} /></Modal>;
  }
  if (route?.view === "briefings") {
    return (
      <Modal title={`Briefings about ${project?.name ?? "all projects"}`} onClose={() => go({ page: "home" })}>
        {mine.length === 0 && <p className="muted">None yet.</p>}
        <ul className="item-list">
          {mine.map((b) => (
            <li key={b.id}>
              <button className="item-row" onClick={() => go({ page: "home", briefing: b.id })}>
                <span className="grow">{b.title}<br /><span className="muted small">{BRIEFING_LABEL[b.kind]} · {when(b.created)}</span></span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>
    );
  }
  return null;
}

/** The newest briefing for the scope, with the ways to read, write and schedule them. */
export function BriefingCard({ project }: { project: Project | undefined }) {
  const client = useQueryClient();
  const go = useApp((s) => s.go);
  const claudeShown = useShownEngines().shows("claude");
  const briefings = useRecords<Briefing>("briefing");
  const [busy, setBusy] = useState(false);
  const mine = (briefings.data ?? []).filter((b) => (b.project ?? null) === (project?.slug ?? null));
  const latest = mine[0];
  const write = async () => {
    setBusy(true);
    try {
      const b = await brief(project ? "project" : "weekly", project?.slug ?? null, 7);
      client.setQueryData<Briefing[]>(["executive", "briefing"], (prev) => [b, ...(prev ?? []).filter((x) => x.id !== b.id)]);
      go({ page: "home", briefing: b.id });
    } catch (e) { toast(classify(e).message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <Section title="Briefing" loading={briefings.isLoading} error={briefings.error}>
      {latest ? (
        <button className="item-row" onClick={() => go({ page: "home", briefing: latest.id })}>
          <span className="grow">{latest.title}<br /><span className="muted small">{BRIEFING_LABEL[latest.kind]} · {when(latest.created)}</span></span>
        </button>
      ) : <p className="muted small">No briefing yet. Write one to see what changed, what is overdue and what needs you.</p>}
      <div className="exec-row">
        {claudeShown && (
          <button className="primary" onClick={write} disabled={busy} title="Reads Living Memory and your milestones and health. Takes about a minute.">
            {busy ? <><LoaderCircle className="spin" size="1em" aria-hidden /> Writing</> : <><Sparkles size="1em" aria-hidden /> Write now</>}
          </button>
        )}
        {latest && <button onClick={() => go({ page: "home", briefing: latest.id })}>Open</button>}
        {mine.length > 1 && <button className="link small" onClick={() => go({ page: "home", view: "briefings" })}>All briefings ({mine.length})</button>}
      </div>
      {claudeShown ? <MorningToggle project={project} /> : <p className="muted small">Briefings run on Claude Code. Show Claude Code in Settings to write or schedule them.</p>}
    </Section>
  );
}
