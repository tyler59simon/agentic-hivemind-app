import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "../../ui/Modal";
import { hasConflictMarkers, mergeFields, MINE, THEIRS, type Sides } from "./merge";
import type { Fields } from "./save";

const LABELS: Record<string, string> = { title: "Title", type: "Type", tags: "Tags", context: "Context", review_by: "Review by", files: "Files" };
const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") || "—" : String(v || "—"));

interface Words {
  title: string; who: string; saved: string; useSaved: string; useMine: string; save: string; cancel: string;
  clean: string; clash: (markers: ReactNode) => ReactNode; sides: Sides;
}
const STALE = {
  useMine: "Use my version", cancel: "Keep editing", sides: { mine: MINE, theirs: THEIRS },
  clean: "Your edits merge cleanly with theirs. Check the result on the right, then save.",
  clash: (m: ReactNode) => <>Some of your lines clash with theirs: fix the {m} blocks on the right, then save.</>,
};
const WORDS: Record<"note" | "page" | "proposal", Words> = {
  note: {
    ...STALE, title: "This note changed since you opened it", who: "Someone (an agent, the CLI or another window) saved this note after you started editing.",
    saved: "Saved version", useSaved: "Use saved version", save: "Save merged note",
  },
  page: {
    ...STALE, title: "This page changed on disk", who: "Another program saved this page after you started editing.",
    saved: "Version on disk", useSaved: "Use version on disk", save: "Save merged page",
  },
  // An agent's proposed edit merged into the page as it is now, then accepted (NS-2C UI pass): nothing was being edited,
  // and the read-only side is the agent's text, not the page on disk.
  proposal: {
    title: "Merge the agent's edit", who: "The agent's version is on the left. The result on the right merges it into the page as it is now.",
    saved: "Agent's version", useSaved: "Use the agent's version", useMine: "Use the page as it is", save: "Accept merged page", cancel: "Cancel",
    clean: "Check or change the result, then accept it.",
    clash: (m: ReactNode) => <>The page changed where the agent edited it: fix the {m} blocks on the right, then accept.</>,
    sides: { mine: "Page now", theirs: "Agent's edit" },
  },
};

/** The note (or notebook page) changed since it was opened. Merge "your edit" into "the saved version", then save
 *  again. Pages have only a body, so they pass the same other fields on every side. A proposal merges an agent's
 *  edit ("theirs") into the page as it is now ("mine"). */
export function MergeDialog({ base, mine, theirs, onResolve, onCancel, noun = "note" }: {
  base: Fields; mine: Fields; theirs: Fields; onResolve: (merged: Fields) => void; onCancel: () => void; noun?: "note" | "page" | "proposal";
}) {
  const words = WORDS[noun];
  const auto = useMemo(() => mergeFields(base, mine, theirs, words.sides), [base, mine, theirs, words]);
  const [picks, setPicks] = useState<Record<string, "mine" | "theirs">>(() => Object.fromEntries(auto.conflicts.map((k) => [k, "mine"])));
  const [markers, setMarkers] = useState(auto.bodyConflicts > 0);
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<MergeView | null>(null);

  useEffect(() => {
    const common = [markdown(), EditorView.lineWrapping];
    merge.current = new MergeView({
      parent: host.current!,
      a: { doc: theirs.body, extensions: [...common, EditorState.readOnly.of(true), EditorView.editable.of(false)] },
      b: {
        doc: auto.merged.body,
        extensions: [...common, EditorView.updateListener.of((u) => { if (u.docChanged) setMarkers(hasConflictMarkers(u.state.doc.toString())); })],
      },
      highlightChanges: true,
      gutter: true,
    });
    return () => merge.current?.destroy();
  }, [auto, theirs.body]);

  const setResult = (text: string) => {
    const b = merge.current?.b;
    b?.dispatch({ changes: { from: 0, to: b.state.doc.length, insert: text } });
  };

  const resolve = () => {
    const merged: Fields = { ...auto.merged, body: merge.current!.b.state.doc.toString() };
    for (const key of auto.conflicts) (merged as unknown as Record<string, unknown>)[key] = (picks[key] === "mine" ? mine : theirs)[key];
    onResolve(merged);
  };

  return (
    <Modal title={words.title} onClose={onCancel} wide>
      <p>
        {words.who}{" "}
        {auto.bodyConflicts ? words.clash(<code>{"<<<<<<<"}</code>) : words.clean}
      </p>
      {auto.conflicts.length > 0 && (
        <div className="field-conflicts">
          {auto.conflicts.map((key) => (
            <fieldset key={key}>
              <legend>{LABELS[key]}</legend>
              {(["mine", "theirs"] as const).map((side) => (
                <label key={side}>
                  <input type="radio" name={key} checked={picks[key] === side} onChange={() => setPicks({ ...picks, [key]: side })} />
                  {side === "mine" ? "Yours" : "Saved"}: <code>{show((side === "mine" ? mine : theirs)[key])}</code>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
      <div className="merge-head">
        <span>{words.saved} (read-only)</span>
        <span className="row">Result to save (editable)
          <button className="ghost small" onClick={() => setResult(mine.body)}>{words.useMine}</button>
          <button className="ghost small" onClick={() => setResult(theirs.body)}>{words.useSaved}</button>
        </span>
      </div>
      <div className="merge-host" ref={host} />
      <div className="actions">
        <button onClick={onCancel}>{words.cancel}</button>
        <button className="primary" disabled={markers} title={markers ? "Remove the conflict markers first" : undefined} onClick={resolve}>{words.save}</button>
      </div>
    </Modal>
  );
}

const bodyOnly = (body: string): Fields => ({ title: "", body, type: "knowledge", tags: [], context: "", review_by: "", files: [] });

/** The merge dialog for a notebook page, or for an agent's proposal to one: text only. */
export function PageMergeDialog({ base, mine, theirs, onResolve, onCancel, noun = "page" }: {
  base: string; mine: string; theirs: string; onResolve: (text: string) => void; onCancel: () => void; noun?: "page" | "proposal";
}) {
  const sides = useMemo(() => ({ base: bodyOnly(base), mine: bodyOnly(mine), theirs: bodyOnly(theirs) }), [base, mine, theirs]);
  return <MergeDialog {...sides} noun={noun} onResolve={(m) => onResolve(m.body)} onCancel={onCancel} />;
}
