import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Check, Circle, CircleCheck, CircleEllipsis, CircleQuestionMark, Ellipsis, FileText, LoaderCircle, Play, Sparkle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useChangesEnabled, useSystemsEnabled } from "../../lib/connection";
import { classify } from "../../lib/errors";
import {
  addAction, capture, changePlan, check, domainOf, STAGES, update,
  type Change, type ChangeStage, type Note,
} from "../../lib/lm";
import { actionItems, addEvidence, evidenceItems, sections, setEvidence, stepParts, wikilinks } from "../../lib/note";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { openSession, openSystem, useApp } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { Menu } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { ArrowLink, dayMonth, PageHeader, Row, Section, Split } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { isEnded, waitingForReview } from "../agents/session";
import { noteLinks } from "../links/useLinks";
import { PlanDialog } from "../plans/PlanDialog";
import { useAllLinks } from "../projects/useProject";
import { MiniDiagram } from "../systems/MiniDiagram";
import { useSystem } from "../systems/useSystem";
import { noteQuery } from "../viewer/NoteView";
import {
  briefState, checkpointBody, checkpointTitle, engineName, nextStage, sessionLine, stageStates, STAGE_LABELS, type ChangeView,
} from "./changes";
import { useChangeIntent } from "./intent";
import { moveStage, startSessionFor, useChangeViews } from "./useChanges";

const openNote = (ref: string, title: string, split = false) => useWorkspace.getState().openNote(ref, { title, split });
const TOO_LONG = "This brief is too long to edit here. Open the brief and edit it there.";

/** The four stages; only the next one is a button (a guarded one-click move with Undo). */
function Stepper({ change, writable }: { change: Change; writable: boolean }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<ChangeStage | null>(null);
  const next = writable ? nextStage(change) : null;
  const go = async (to: ChangeStage, from: ChangeStage) => {
    setBusy(to);
    try {
      await moveStage(change.id, to, from);
      client.invalidateQueries({ queryKey: ["changes"] });
      toast(`${change.display} moved to ${STAGE_LABELS[to]}`, "info", { label: "Undo", run: () => go(from, to) });
    } catch (e) {
      toast(`${change.display} was not moved: ${classify(e).message}`, "error");
    } finally { setBusy(null); }
  };
  const states = stageStates(change);
  return (
    <ol className="stepper" aria-label="Stage">
      {STAGES.map((stage, i) => (
        <li key={stage} className={states[i]} aria-current={states[i] === "current" ? "step" : undefined}>
          {stage === next ? (
            <button className="step-dot" aria-label={`Move to ${STAGE_LABELS[stage]}`} title={`Move to ${STAGE_LABELS[stage]}`} disabled={!!busy} onClick={() => go(stage, change.stage)}>
              {busy === stage && <LoaderCircle className="spin" size="1em" aria-hidden />}
            </button>
          ) : <span className="step-dot">{states[i] === "done" && <Check size="1em" aria-hidden />}</span>}
          <span className="step-name">{STAGE_LABELS[stage]}</span>
        </li>
      ))}
    </ol>
  );
}

/** "Add step" / "Add evidence": a link that turns into an inline one-line form. */
function AddLine({ label, aria, placeholder, onAdd }: { label: string; aria: string; placeholder: string; onAdd: (text: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) return <button className="link add-link" onClick={() => setOpen(true)}>{label}</button>;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await onAdd(text.trim()); setText(""); setOpen(false); } catch { /* the mutation already toasted */ } finally { setBusy(false); }
  };
  return (
    <form className="add-line" onSubmit={submit}>
      <input autoFocus value={text} aria-label={aria} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } }} />
      <button className="primary" disabled={!text.trim() || busy}>Add</button>
    </form>
  );
}

function PlanSteps({ view, note, writable, links }: { view: ChangeView; note: Note; writable: boolean; links: ReturnType<typeof noteLinks> }) {
  const { change, latest } = view;
  const client = useQueryClient();
  const refresh = (r: { operation_id?: string }) => {
    recordOperation(r.operation_id);
    client.invalidateQueries({ queryKey: ["note", change.brief] });
    client.invalidateQueries({ queryKey: ["changes"] });
  };
  const onError = (e: unknown) => toast(classify(e).message, "error");
  const tick = useMutation({ mutationFn: (v: { index: number; done: boolean }) => check(change.brief, v.index, v.done), onSuccess: refresh, onError });
  const add = useMutation({ mutationFn: (text: string) => addAction(change.brief, text), onSuccess: refresh, onError });
  const steps = actionItems(note.body);
  const current = steps.find((s) => !s.done)?.index;
  return (
    <>
      {!steps.length && <p className="muted">No steps yet.</p>}
      <ol className="plan-steps">
        {steps.map((s) => {
          const state = s.done ? "done" : s.index === current ? "current" : "";
          const { title, detail } = stepParts(s.text);
          const proposed = state === "current" && !detail && latest && waitingForReview(latest)
            ? `${engineName(latest.adapter)} proposed ${latest.filesChanged?.files ?? 0} file${latest.filesChanged?.files === 1 ? "" : "s"}.` : detail;
          const decided = wikilinks(s.text).some((l) => links?.out.get(l.target.trim().toLowerCase())?.type === "decision");
          const Icon = s.done ? CircleCheck : state === "current" ? CircleEllipsis : Circle;
          return (
            <li key={s.index} className={`plan-step ${state}`}>
              <button className="step-box" aria-label={s.done ? "Mark as not done" : "Mark as done"} aria-pressed={s.done}
                disabled={!writable || tick.isPending} onClick={() => tick.mutate({ index: s.index, done: !s.done })}>
                <Icon size="1.7em" aria-hidden />
              </button>
              <div className="plan-step-main"><strong>{title}</strong>{proposed && <span className="muted">{proposed}</span>}</div>
              {decided && <span className="status-chip">Decision recorded</span>}
            </li>
          );
        })}
      </ol>
      {writable && <AddLine label="Add step" aria="New step" placeholder="What needs doing" onAdd={(t) => add.mutateAsync(t)} />}
    </>
  );
}

function Evidence({ change, note, writable }: { change: Change; note: Note; writable: boolean }) {
  const client = useQueryClient();
  const write = useMutation({
    mutationFn: async (body: string) => {
      if (note.truncated) throw new Error(TOO_LONG);
      return update(change.brief, { body, expected_revision: note.revision });
    },
    onSuccess: (r) => { recordOperation(r.operation_id); client.invalidateQueries({ queryKey: ["note", change.brief] }); },
    onError: (e) => {
      if (classify(e).kind === "stale") { client.invalidateQueries({ queryKey: ["note", change.brief] }); toast("The brief changed. Try again.", "error"); }
      else toast(classify(e).message, "error");
    },
  });
  const items = evidenceItems(note.body);
  return (
    <>
      {!items.length && <p className="muted">No acceptance evidence yet. Add what must be true before this change is done.</p>}
      <ul className="evidence-list">
        {items.map((e) => (
          <li key={e.index}>
            <label>
              <input type="checkbox" className="action-box" checked={e.done} disabled={!writable || write.isPending}
                onChange={() => write.mutate(setEvidence(note.body, e.index, !e.done))} />
              {e.text}
            </label>
            <span className={"status-chip" + (e.done ? " active" : "")}>{e.done ? "Verified" : "Not verified"}</span>
          </li>
        ))}
      </ul>
      {writable && <AddLine label="Add evidence" aria="New evidence item" placeholder="What must be shown to be true" onAdd={(t) => write.mutateAsync(addEvidence(note.body, t))} />}
    </>
  );
}

function CheckpointDialog({ change, note, onClose }: { change: Change; note: Note; onClose: () => void }) {
  const client = useQueryClient();
  const [summary, setSummary] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const steps = actionItems(note.body), evidence = evidenceItems(note.body);
      return capture(domainOf(change.brief), {
        type: "status", title: checkpointTitle(change.display),
        body: checkpointBody({
          summary: summary.trim(), briefTitle: note.title, stage: change.stage, branch: change.branch,
          steps: { done: steps.filter((s) => s.done).length, total: steps.length },
          evidence: { done: evidence.filter((s) => s.done).length, total: evidence.length },
        }),
        tags: ["subject/project", "concern/workflow", `project/${change.project}`, ...(change.system ? [`system/${change.system}`] : [])],
        allow_similar: true,
      });
    },
    onSuccess: (r) => { recordOperation(r.operation_id); refreshStore(client); toast("Checkpoint recorded"); onClose(); },
  });
  const problem = save.error ? classify(save.error) : null;
  return (
    <Modal title="Record checkpoint" onClose={onClose} locked={save.isPending}>
      <form className="settings" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="muted">Saves a status note linked to {change.display}, so the next session starts from where this stands.</p>
        <label className="field"><span>Where it stands</span>
          <textarea rows={4} autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
        {problem && <p className="error">{problem.kind === "unknown-tags"
          ? `This store's taxonomy lacks a tag the checkpoint needs (${problem.tags.join(", ")}). Add it under Memory, Tags, then record the checkpoint again.`
          : problem.message}</p>}
        <div className="actions">
          <button type="button" onClick={onClose} disabled={save.isPending}>Cancel</button>
          <button className="primary" disabled={!summary.trim() || save.isPending}>Record checkpoint</button>
        </div>
      </form>
    </Modal>
  );
}

function Checkpoint({ view, note }: { view: ChangeView; note: Note }) {
  const [open, setOpen] = useState(false);
  const last = view.checkpoints[0];
  return (
    <div className="checkpoint-line">
      <button className="text underline" onClick={() => setOpen(true)}><Bookmark size="1.2em" aria-hidden />Record checkpoint</button>
      {last && <><span className="muted small">Last checkpoint: </span><button className="link" onClick={() => openNote(last.ref, last.title)}>{last.title}</button></>}
      {open && <CheckpointDialog change={view.change} note={note} onClose={() => setOpen(false)} />}
    </div>
  );
}

function LinkedSession({ view }: { view: ChangeView }) {
  const { latest } = view;
  return (
    <Section title="Linked session">
      {latest ? (
        <div className="session-card">
          <span><Sparkle size="1.1em" aria-hidden /> <strong>{engineName(latest.adapter)}</strong></span>
          <span className="session-title">{latest.title}</span>
          <span className="muted">{sessionLine(latest)}</span>
          <ArrowLink onClick={() => openSession(latest.id)}>{waitingForReview(latest) ? "Review proposed changes" : "Open session"}</ArrowLink>
        </div>
      ) : <p className="muted">No agent session yet.</p>}
    </Section>
  );
}

function ChangeMenu({ change }: { change: Change }) {
  const [plan, setPlan] = useState<"done" | "cancel" | "reopen" | null>(null);
  const active = change.status === "active";
  const dialog = {
    done: { title: `Mark ${change.display} as done`, label: "Mark as done", danger: false, make: () => changePlan("close", { id: change.id }),
      intro: "The change is marked done and its brief is resolved: it leaves open work and moves to the archive. Reopen the change to bring both back." },
    cancel: { title: `Cancel ${change.display}`, label: "Cancel change", danger: true, make: () => changePlan("close", { id: change.id, status: "cancelled" }),
      intro: "The change is marked cancelled and its brief is resolved. Its number is not reused." },
    reopen: { title: `Reopen ${change.display}`, label: "Reopen", danger: false, make: () => changePlan("update", { id: change.id, status: "active" }),
      intro: "The change becomes active again and its brief is reopened." },
  };
  const d = plan && dialog[plan];
  return (
    <>
      <Menu label="Change actions" align="right" button={<Ellipsis size="1.3em" aria-hidden />} className="icon-menu">
        {(close) => {
          const item = (label: string, act: () => void, cls = "") => <li><button role="menuitem" className={cls} onClick={() => { close(); act(); }}>{label}</button></li>;
          return (
            <>
              {briefState(change) !== "missing" && item("Open brief", () => openNote(change.brief, change.title))}
              {item("Edit change…", () => useChangeIntent.getState().open({ mode: "edit", change }))}
              {active && item("Mark as done…", () => setPlan("done"))}
              {active && item("Cancel change…", () => setPlan("cancel"), "danger-text")}
              {!active && item("Reopen change…", () => setPlan("reopen"))}
            </>
          );
        }}
      </Menu>
      {d && <PlanDialog title={d.title} make={d.make} applyLabel={d.label} danger={d.danger} intro={<p>{d.intro}</p>} onClose={() => setPlan(null)} />}
    </>
  );
}

/** Change detail: stage, steps, acceptance evidence, checkpoints and the linked session, architecture and decisions. */
export function ChangeDetail({ id }: { id: number }) {
  const enabled = useChangesEnabled();
  const systemsOn = useSystemsEnabled();
  const { views, query } = useChangeViews();
  const view = views.find((v) => v.change.id === id);
  const change = view?.change;
  const state = change ? briefState(change) : "missing";
  const note = useQuery({ ...noteQuery(change?.brief ?? ""), enabled: !!change && state !== "missing" });
  const links = noteLinks(useAllLinks(enabled).data, change?.brief);
  const { system, architecture } = useSystem(change?.system ?? undefined);
  const go = useApp((s) => s.go);

  if (!view || !change) {
    if (query.error) return <div className="page"><p className="error">{classify(query.error).message}</p></div>;
    if (query.isLoading || !query.data) return <p className="muted pad">Loading…</p>;
    return (
      <div className="page">
        <p className="muted">CHG-{String(id).padStart(3, "0")} is not in the change registry. It may have been undone.</p>
        <ArrowLink onClick={() => go({ page: "changes" })}>All changes</ArrowLink>
      </div>
    );
  }

  const writable = change.status === "active" && state === "ok";
  const { latest } = view;
  const resume = latest && !isEnded(latest);
  const body = note.data?.body ?? "";
  return (
    <div className="page">
      <PageHeader eyebrow={`Change brief · ${change.display}`} title={change.title}
        meta={<>
          <span className={"status-chip " + view.chip.tone}>{view.chip.tone === "waiting" && <Play size="1.1em" aria-hidden />}{view.chip.label}</span>
          <span className="muted">Updated {dayMonth(view.updated)}</span>
        </>}
        actions={<>
          <ChangeMenu change={change} />
          {resume ? <button className="primary big" onClick={() => openSession(latest.id)}><Play size="1.2em" aria-hidden />Resume agent session</button>
            : writable && <button className="primary big" onClick={() => startSessionFor(view)}><Play size="1.2em" aria-hidden />Start agent session</button>}
        </>} />
      {state === "missing" && <div className="banner warn">The brief note of this change is missing: it was deleted, or its reference no longer resolves. The change can still be edited or cancelled.</div>}
      {state === "retired" && (
        <div className="banner warn">
          <span>The brief of this change was {change.brief_status}, so it is shown read-only. Undo the archive from the brief's History to work on it again, or cancel the change.</span>
          <div className="actions"><button onClick={() => openNote(change.brief, change.title)}>Open brief</button></div>
        </div>
      )}
      <Split rail={
        <>
          <LinkedSession view={view} />
          {change.system && systemsOn && (
            <Section title="Architecture">
              {!system ? <p className="muted">The system “{change.system}” is no longer registered.</p>
                : architecture.isLoading ? <p className="muted">Loading…</p>
                : architecture.data?.model ? <><MiniDiagram model={architecture.data.model} selected={change.element ?? undefined} /><ArrowLink onClick={() => openSystem(system.slug)}>Open diagram</ArrowLink></>
                : <><p className="muted">{system.name} has no architecture output yet.</p><ArrowLink onClick={() => openSystem(system.slug)}>Open {system.name}</ArrowLink></>}
            </Section>
          )}
          <Section title="Decisions" empty={!view.decisions.length && !view.questions.length ? "No decisions are linked to this change yet." : undefined}>
            {view.decisions.map((n) => <Row key={n.ref} icon={<FileText size="1.3em" aria-hidden />} onClick={() => openNote(n.ref, n.title)}>{n.title}</Row>)}
            {view.questions.map((n) => (
              <button key={n.ref} className="question-row" onClick={() => openNote(n.ref, n.title)}><CircleQuestionMark size="1.3em" aria-hidden />{n.title}</button>
            ))}
          </Section>
        </>
      }>
        <Stepper change={change} writable={writable} />
        {state !== "missing" && (
          <>
            <Section title="Outcome" loading={note.isLoading} error={note.error}>
              <div className="markdown"><Markdown>{sections(body).summary ?? ""}</Markdown></div>
            </Section>
            <Section title="Implementation plan" loading={note.isLoading} error={note.error}>
              {note.data && <PlanSteps view={view} note={note.data} writable={writable} links={links} />}
            </Section>
            <Section title="Acceptance evidence" loading={note.isLoading} error={note.error}>
              {note.data && <Evidence change={change} note={note.data} writable={writable} />}
            </Section>
            {writable && note.data && <Checkpoint view={view} note={note.data} />}
          </>
        )}
      </Split>
    </div>
  );
}
