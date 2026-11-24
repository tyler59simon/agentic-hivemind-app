// The Inbox card for a linked skill whose sync paused (CON-16): both texts side by side and the four ways to settle it.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { classify } from "../../lib/errors";
import { skillResolve, type ResolveAction, type Skill, type SkillText } from "../../lib/skills";
import { openSkills } from "../../store";
import { Markdown } from "../../ui/Markdown";
import { Confirm } from "../../ui/Modal";
import { ArrowLink } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { useWorkspace } from "../../workspace/store";
import { linkRef, pauseChoices, PAUSE_WORDS, syncTitle } from "./skills";

const DONE: Record<ResolveAction, string> = {
  note: "Kept the note's text", skill: "Kept the skill file's text", merge: "Saved the merged text", unlink: "Unlinked from the note",
};

function Text({ label, text, missing }: { label: string; text: SkillText | null; missing: string }) {
  return (
    <div className="sync-text">
      <h3>{label}</h3>
      {text ? (
        <>
          <p className="muted small">{text.description || "No description"}</p>
          <div className="markdown"><Markdown>{text.body}</Markdown></div>
        </>
      ) : <p className="muted small">{missing}</p>}
    </div>
  );
}

export function SkillSyncCard({ skill, onDone }: { skill: Skill; onDone: () => void }) {
  const client = useQueryClient();
  const link = skill.link!;
  const pause = link.paused!;
  const choices = pauseChoices(pause.kind);
  const [asking, setAsking] = useState<null | "note" | "unlink">(null);
  const start = pause.skillText ?? pause.noteText;
  const [merging, setMerging] = useState(false);
  const [description, setDescription] = useState(start?.description ?? skill.description);
  const [body, setBody] = useState(start?.body ?? skill.body);
  const [busy, setBusy] = useState(false);
  const resolve = (action: ResolveAction, text?: SkillText) => {
    setBusy(true);
    skillResolve(skill.name, action, text).then(() => {
      toast(DONE[action]);
      client.invalidateQueries({ queryKey: ["skills"] });
      client.invalidateQueries({ queryKey: ["note"] });
      onDone();
    }, (e) => toast(classify(e).message, "error")).finally(() => setBusy(false));
  };
  const hints = [choices.note, choices.skill, choices.merge].filter((c) => c.hint).map((c) => c.hint!);
  const noteRef = linkRef(link);
  return (
    <>
      <h2>{syncTitle(skill.name)}</h2>
      <p>{PAUSE_WORDS[pause.kind]}.</p>
      {pause.reason && <p className="muted small">{pause.reason}</p>}
      <p className="muted small">
        Linked to{" "}
        <button className="link" onClick={() => useWorkspace.getState().openNote(noteRef, { title: link.title })}>{link.title}</button>.{" "}
        <ArrowLink onClick={() => openSkills(skill.name)}>Open Skills</ArrowLink>
      </p>
      <div className="sync-texts">
        <Text label="Note" text={pause.noteText} missing={pause.kind === "note_missing" ? "The note cannot be read." : "The note's text is not shown for this pause."} />
        <Text label="SKILL.md" text={pause.skillText} missing="The skill file's text is not shown for this pause." />
      </div>
      {merging ? (
        <>
          <label className="field">
            <span>Description: when should an agent use it?</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="field">
            <span>Merged text (needs When to use, When not to use and Steps)</span>
            <textarea rows={16} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="work-actions">
            <button className="primary" disabled={busy || !description.trim() || !body.trim()} onClick={() => resolve("merge", { description, body })}>Save</button>
            <button disabled={busy} onClick={() => setMerging(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="work-actions">
          <button className="primary" disabled={busy || !choices.note.enabled}
            onClick={() => (pause.skillText ? setAsking("note") : resolve("note"))}>Keep the note</button>
          <button disabled={busy || !choices.skill.enabled} onClick={() => resolve("skill")}>Keep the skill file</button>
          <button disabled={busy || !choices.merge.enabled} onClick={() => setMerging(true)}>Edit a merge</button>
          <button className="danger-text" disabled={busy} onClick={() => setAsking("unlink")}>Unlink</button>
        </div>
      )}
      {hints.length > 0 && <p className="muted small">{[...new Set(hints)].join(" ")}</p>}
      {asking === "note" && (
        <Confirm title="Keep the note's text?" action="Keep the note" danger
          message="The note's text becomes the skill's next version. Edits in the Claude Code and Codex SKILL.md copies are replaced."
          onAnswer={(yes) => { setAsking(null); if (yes) resolve("note"); }} />
      )}
      {asking === "unlink" && (
        <Confirm title={`Unlink ${skill.name}?`} action="Unlink" danger
          message="The skill and the note stop syncing. Both keep their current text. You can link them again from Skills."
          onAnswer={(yes) => { setAsking(null); if (yes) resolve("unlink"); }} />
      )}
    </>
  );
}
