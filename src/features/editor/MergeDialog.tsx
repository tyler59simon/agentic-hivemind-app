import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../../ui/Modal";
import { hasConflictMarkers, mergeFields } from "./merge";
import type { Fields } from "./save";

const LABELS: Record<string, string> = { title: "Title", type: "Type", tags: "Tags", context: "Context", review_by: "Review by", files: "Files" };
const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") || "—" : String(v || "—"));

/** The note changed since it was opened. Merge "your edit" into "the saved version", then save again. */
export function MergeDialog({ base, mine, theirs, onResolve, onCancel }: {
  base: Fields; mine: Fields; theirs: Fields; onResolve: (merged: Fields) => void; onCancel: () => void;
}) {
  const auto = useMemo(() => mergeFields(base, mine, theirs), [base, mine, theirs]);
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
    <Modal title="This note changed since you opened it" onClose={onCancel} wide>
      <p>
        Someone (an agent, the CLI or another window) saved this note after you started editing.{" "}
        {auto.bodyConflicts
          ? <>Some of your lines clash with theirs: fix the <code>{"<<<<<<<"}</code> blocks on the right, then save.</>
          : <>Your edits merge cleanly with theirs. Check the result on the right, then save.</>}
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
        <span>Saved version (read-only)</span>
        <span className="row">Result to save (editable)
          <button className="ghost small" onClick={() => setResult(mine.body)}>Use my version</button>
          <button className="ghost small" onClick={() => setResult(theirs.body)}>Use saved version</button>
        </span>
      </div>
      <div className="merge-host" ref={host} />
      <div className="actions">
        <button onClick={onCancel}>Keep editing</button>
        <button className="primary" disabled={markers} title={markers ? "Remove the conflict markers first" : undefined} onClick={resolve}>Save merged note</button>
      </div>
    </Modal>
  );
}
