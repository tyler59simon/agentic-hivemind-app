// Ask a question about the project (or all projects): it starts an Executive Assistant session and opens it in Agents. The
// assistant starts from the evidence (projects, commitments, milestones, decisions, risks), may read Living Memory and cannot write
// to it; when the conversation ends, what it decided waits for review.
import { LoaderCircle, MessageSquare } from "lucide-react";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { agentStart } from "../../lib/executive";
import type { Project } from "../../lib/lm";
import { openSession } from "../../store";
import { Section } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useShownEngines } from "../agents/engines";

const SUGGESTIONS = ["What needs my attention this week?", "Which commitments are overdue, and who owns them?"];

export function AskBox({ project }: { project: Project | undefined }) {
  const engines = useShownEngines();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async (prompt: string) => {
    if (!prompt.trim() || !engines.first) return;
    setBusy(true);
    try {
      const info = await agentStart(project?.slug ?? null, prompt, { engine: engines.first });
      setText("");
      openSession(info.id);
    } catch (e) { toast(classify(e).message, "error"); }
    finally { setBusy(false); }
  };
  return (
    <Section title="Ask">
      <div className="exec-ask-box">
        <input value={text} placeholder={`Ask about ${project?.name ?? "your projects"}…`} aria-label="Ask the Executive Assistant" disabled={busy}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void ask(text); }} />
        <button className="primary" onClick={() => void ask(text)} disabled={busy || !text.trim() || !engines.first} aria-label="Ask" title="Starts an Executive Assistant session in Agents">
          {busy ? <LoaderCircle className="spin" size="1em" aria-hidden /> : <MessageSquare size="1em" aria-hidden />}
        </button>
        <div className="exec-chips">{SUGGESTIONS.map((s) => <button key={s} className="chip" disabled={busy || !engines.first} onClick={() => void ask(s)}>{s}</button>)}</div>
      </div>
    </Section>
  );
}
