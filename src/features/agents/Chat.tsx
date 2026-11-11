import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, AtSign, ChevronDown, ChevronRight, CircleCheck, CircleSlash, CircleX, File, LoaderCircle, Send, ShieldQuestion, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { agentAnswer, agentFiles, agentInterrupt, agentSend, type ChangedFiles, type FileChange, type SessionInfo } from "../../lib/agent";
import { useProjectsEnabled } from "../../lib/connection";
import { domainOf, type NoteRow } from "../../lib/lm";
import { startSession, useApp } from "../../store";
import { Confirm, Modal } from "../../ui/Modal";
import { ArrowLink } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { DiffView } from "../plans/PlanDialog";
import { NotePicker } from "../plans/NotePicker";
import { projectsQuery } from "../projects/useProject";
import { noteQuery } from "../viewer/NoteView";
import { cost, lastTurn, type Item, type Transcript } from "./events";
import { isEnded, noteBlock } from "./session";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const baseName = (path: string) => path.split(/[\\/]/).pop() || path;
const totals = (files: FileChange[]) => ({ added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) });

/** What a permission request is about, in one string: the command, or the file. */
function subject(item: Extract<Item, { kind: "approval" }>): string {
  const input = (item.input ?? {}) as Record<string, unknown>;
  if (item.tool === "Bash" || item.tool === "PowerShell") return str(input.command);
  return str(input.file_path) || item.summary;
}

/** The tool's request in full: a command, a diff, a file, or the raw input for any other tool. */
function Detail({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  switch (tool) {
    case "Bash":
    case "PowerShell":
      return <pre>{str(input.command)}</pre>;
    case "Edit": {
      const lines = (text: string, mark: string) => (text ? text.split("\n").map((l) => mark + l) : []);
      return <><code>{str(input.file_path)}</code><DiffView text={[...lines(str(input.old_string), "-"), ...lines(str(input.new_string), "+")].join("\n")} /></>;
    }
    case "Write":
      return <><code>{str(input.file_path)}</code><pre>{str(input.content)}</pre></>;
    case "Read":
      return <code>{str(input.file_path)}</code>;
    default:
      return <pre>{JSON.stringify(input, null, 2)}</pre>;
  }
}

/** A permission request: asks while open, then collapses to one line with the answer. */
export function ApprovalCard({ item, sessionId }: { item: Extract<Item, { kind: "approval" }>; sessionId: string }) {
  const [answering, setAnswering] = useState(false);
  const input = (item.input ?? {}) as Record<string, unknown>;
  if (item.decision) {
    const [icon, label] = item.decision === "allow" ? [<CircleCheck size="1.3em" aria-hidden />, "Allowed"]
      : item.decision === "allow_always" ? [<CircleCheck size="1.3em" aria-hidden />, "Always allowed"]
      : item.decision === "deny" ? [<CircleX size="1.3em" aria-hidden />, "Denied"]
      : [<CircleSlash size="1.3em" aria-hidden />, "No longer needed"];
    return <div className="approval done">{icon}<span>{label}</span><span className="tool-name">{item.tool}</span><code title={subject(item)}>{subject(item)}</code></div>;
  }
  const answer = async (decision: "allow" | "allow_always" | "deny") => {
    setAnswering(true);
    try {
      await agentAnswer(sessionId, item.requestId, decision);
    } catch (e) {
      toast(String(e), "error");
      setAnswering(false);
    }
  };
  const detail = item.tool === "Bash" || item.tool === "PowerShell" ? str(input.command) : ["Edit", "Write", "Read"].includes(item.tool) ? str(input.file_path) : "";
  return (
    <div className="approval" role="group" aria-label={"Permission request: " + item.tool}>
      <div className="approval-head">
        <ShieldQuestion size="1.3em" aria-hidden />Permission needed<span className="tool-name">{item.tool}</span><span className="fill" />
        <span className="status-chip waiting">Waiting for you</span>
      </div>
      {item.summary !== detail && <p>{item.summary}</p>}
      <Detail tool={item.tool} input={input} />
      <div className="approval-actions">
        <button className="primary" disabled={answering} onClick={() => answer("allow")}>Allow once</button>
        {item.canAlways && <button disabled={answering} title={item.alwaysLabel ? "Allow " + item.alwaysLabel + " for the rest of this session" : undefined} onClick={() => answer("allow_always")}>Always allow for this session</button>}
        <button className="danger-text" disabled={answering} onClick={() => answer("deny")}>Deny</button>
      </div>
    </div>
  );
}

/** The files the agent changed in a turn. Only the latest card can be reviewed. */
export function FilesCard({ files, latest, onReview }: { files: FileChange[]; latest: boolean; onReview?: () => void }) {
  // Until the user toggles it, only the latest card is open.
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? latest;
  if (!files.length) return <p className="turn-line">No file changes remain</p>;
  const { added, removed } = totals(files);
  return (
    <div className="files-card">
      <button className="files-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size="1.2em" aria-hidden /> : <ChevronRight size="1.2em" aria-hidden />}
        <File size="1.2em" aria-hidden />
        <span>{files.length} file{files.length === 1 ? "" : "s"} proposed · <span className="num-add">+{added}</span> <span className="num-del">−{removed}</span></span>
        {latest && <span className="status-chip waiting">Waiting for review</span>}
      </button>
      {open && (
        <>
          <ul className="files-list">
            {files.map((f) => (
              <li key={f.path}>
                <File size="1.2em" aria-hidden />
                <span className={`grow ${f.status === "D" ? "gone" : ""}`} title={f.path}>{baseName(f.path)}</span>
                {f.binary ? <span className="muted small">binary</span> : <><span className="num-add">+{f.added}</span><span className="num-del">−{f.removed}</span></>}
              </li>
            ))}
          </ul>
          {latest && onReview && <button className="outline" onClick={onReview}>Review changes<ArrowRight size="1.1em" aria-hidden /></button>}
        </>
      )}
    </div>
  );
}

/** The worktree's diff against where its branch started, read from disk each time it opens. */
export function ChangesModal({ info, onClose }: { info: SessionInfo & { worktree: NonNullable<SessionInfo["worktree"]> }; onClose: () => void }) {
  const [result, setResult] = useState<ChangedFiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    agentFiles(info.id).then((r) => live && setResult(r)).catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [info.id]);
  const { branch, baseBranch, baseSha } = info.worktree;
  return (
    <Modal title={"Changes on " + branch} wide onClose={onClose}>
      {!result && !error && <p className="muted">Reading the worktree…</p>}
      {error && <p className="error">{error}</p>}
      {result && (
        <>
          <p className="muted">Read-only: the worktree compared with {baseBranch} at {baseSha.slice(0, 7)}.</p>
          {!result.files.length && <p className="muted">No changes.</p>}
          <div className="effects">
            {result.files.map((f) => (
              <details key={f.path} open={result.files.length === 1}>
                <summary><span className="badge">{f.status}</span> {f.path} <span className="num-add">+{f.added}</span> <span className="num-del">−{f.removed}</span></summary>
                {f.binary ? <p className="muted small">Binary or too large to show.</p> : <DiffView text={f.diff} />}
                {f.truncated && <p className="muted small">The diff is cut off at 16,000 characters.</p>}
              </details>
            ))}
          </div>
          {result.truncated && <p className="muted small">More than 200 files changed; the rest are not listed.</p>}
        </>
      )}
      <div className="actions"><button onClick={onClose}>Close</button></div>
    </Modal>
  );
}

/** The message box under the thread: type ahead while the agent works, Stop it, and attach notes. */
export function Composer({ info, transcript }: { info: SessionInfo; transcript: Transcript }) {
  const client = useQueryClient();
  const appDomain = useApp((s) => s.domain);
  const projectsOn = useProjectsEnabled();
  const registry = useQuery({ ...projectsQuery(), enabled: projectsOn });
  const project = registry.data?.projects.find((p) => p.slug === info.project);
  const domain = project?.charter ? domainOf(project.charter) : null;
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [notes, setNotes] = useState<Pick<NoteRow, "ref" | "title">[]>([]);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [picking, setPicking] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => setStopping(false), [info.status]);
  // Grow with the content up to the CSS maximum, and shrink back when the text is cleared.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  if (isEnded(info)) {
    return (
      <div className="empty-state">
        <p className="muted">This session has ended.</p>
        <ArrowLink onClick={startSession}>Start a new session</ArrowLink>
      </div>
    );
  }

  const idle = info.status === "idle";
  const turn = lastTurn(transcript);
  const send = async () => {
    setSending(true);
    try {
      if (notes.length) {
        const loaded = await Promise.all(notes.map((n) => client.fetchQuery(noteQuery(n.ref))));
        const refs = notes.map((n) => n.ref);
        await agentSend(info.id, text.trim(), { context: refs, briefing: noteBlock(loaded.map((n, i) => ({ ref: refs[i], title: n.title, type: n.type, body: n.body })), "Notes the user added to the context") });
      } else {
        await agentSend(info.id, text.trim());
      }
      setText("");
      setNotes([]);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setSending(false);
    }
  };
  const submit = () => { if (idle && text.trim() && !sending) { if (turn?.outcome === "budget") setAsking(true); else send(); } };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    submit();
  };
  const stop = async () => {
    setStopping(true);
    try {
      await agentInterrupt(info.id);
    } catch (e) {
      toast(String(e), "error");
      setStopping(false);
    }
  };
  const pick = (n: NoteRow) => {
    setPicking(false);
    if (!info.context.includes(n.ref) && !notes.some((x) => x.ref === n.ref)) setNotes([...notes, { ref: n.ref, title: n.title }]);
  };

  return (
    <>
      <form className="composer" onSubmit={(e: FormEvent) => { e.preventDefault(); submit(); }}>
        {!!notes.length && (
          <div className="composer-chips">
            {notes.map((n) => (
              <span key={n.ref} className="chip on">{n.title}<button type="button" className="tag-x" aria-label={"Remove " + n.title} onClick={() => setNotes(notes.filter((x) => x.ref !== n.ref))}>×</button></span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <div className="composer-box">
            <textarea ref={area} rows={1} aria-label="Message" placeholder="Ask, plan, or reference a diagram…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
            <button type="button" className="context-chip" onClick={() => setPicking(true)}><AtSign size="1.1em" aria-hidden />Context</button>
          </div>
          {idle
            ? <button type="submit" className="primary send-button" aria-label="Send" disabled={!text.trim() || sending}><Send size="1.3em" aria-hidden /></button>
            : <button type="button" className="send-button" aria-label="Stop" title="Stop this turn" disabled={stopping} onClick={stop}>
              {stopping ? <LoaderCircle className="spin" size="1.3em" aria-hidden /> : <Square size="1.2em" aria-hidden />}
            </button>}
        </div>
        {info.status === "waiting" && <p className="muted small">Waiting for your answer above.</p>}
      </form>
      {picking && <NotePicker title="Add a note to the context" domain={domain ?? appDomain ?? ""} exclude="" onPick={pick} onClose={() => setPicking(false)} />}
      {asking && (
        <Confirm title="Continue past the spending limit?" action="Continue" onAnswer={(yes) => { setAsking(false); if (yes) send(); }}
          message={"This session has spent " + cost(turn?.costUsd ?? info.costUsd) + ". Continuing starts a new run that can spend up to the limit in Settings again."} />
      )}
    </>
  );
}
