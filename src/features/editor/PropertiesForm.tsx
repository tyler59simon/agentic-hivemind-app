import { useId, useState } from "react";
import type { Note, NoteType } from "../../lib/lm";
import { actionItems, allowsActions } from "../../lib/note";
import { typeOptions, useNoteTypes } from "../../lib/noteTypes";
import { shortDate } from "../../lib/text";
import type { Fields } from "./save";

/** `labelledBy`: the id of the text that names the field (a row heading); without it the field is named "Add tag". */
export function TagPicker({ tags, taxonomy, onChange, labelledBy }: { tags: string[]; taxonomy: string[]; onChange: (tags: string[]) => void; labelledBy?: string }) {
  const [text, setText] = useState("");
  const list = useId();
  const known = new Set(taxonomy);
  const add = (value: string) => {
    const tag = value.trim().toLowerCase();
    if (tag && !tags.includes(tag)) onChange([...tags, tag].sort());
    setText("");
  };
  return (
    <div className="tag-picker">
      {tags.map((t) => (
        <span key={t} className={`tag ${known.has(t) || !taxonomy.length ? "" : "unknown"}`} title={known.has(t) ? undefined : "Not in the taxonomy yet"}>
          {t}<button type="button" className="tag-x" onClick={() => onChange(tags.filter((x) => x !== t))}><span aria-hidden>×</span><span className="visually-hidden">Remove {t}</span></button>
        </span>
      ))}
      <input list={list} value={text} placeholder="add tag…" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : "Add tag"} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(text); } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1)); }}
        onBlur={() => text && add(text)} />
      <datalist id={list}>{taxonomy.filter((t) => !tags.includes(t)).map((t) => <option key={t} value={t} />)}</datalist>
    </div>
  );
}

/** Editable properties of a note. Status, origin and the dates LM keeps are shown, not edited. */
export function PropertiesForm({ fields, note, taxonomy, onChange }: {
  fields: Fields; note?: Note; taxonomy: string[]; onChange: (patch: Partial<Fields>) => void;
}) {
  const types = useNoteTypes();
  // The row headings name their fields (`aria-labelledby`), so a screen reader hears "Tags", not only the placeholder.
  const id = useId();
  const hasActions = actionItems(fields.body).length > 0;
  const typeBlocked = (t: NoteType) => hasActions && !allowsActions(t, types.def(t));
  return (
    <dl className="properties editable">
      <div><dt id={`${id}-type`}>Type</dt><dd>
        <select aria-labelledby={`${id}-type`} value={fields.type} onChange={(e) => onChange({ type: e.target.value as NoteType })}>
          {typeOptions(types.active, fields.type).map((t) => <option key={t} value={t} disabled={typeBlocked(t)}>{t}{typeBlocked(t) ? " (has Action items)" : ""}</option>)}
        </select>
      </dd></div>
      {note && <div><dt>Status</dt><dd><span className={`badge status-${note.status}`}>{note.status}</span> <span className="muted small">change it from the ⋯ menu</span></dd></div>}
      <div><dt id={`${id}-tags`}>Tags</dt><dd><TagPicker labelledBy={`${id}-tags`} tags={fields.tags} taxonomy={taxonomy} onChange={(tags) => onChange({ tags })} /></dd></div>
      <div><dt id={`${id}-context`}>Context</dt><dd><input aria-labelledby={`${id}-context`} value={fields.context} placeholder="optional" onChange={(e) => onChange({ context: e.target.value })} /></dd></div>
      <div><dt id={`${id}-review`}>Review by</dt><dd className="row">
        <input type="date" aria-labelledby={`${id}-review`} value={fields.review_by} onChange={(e) => onChange({ review_by: e.target.value })} />
        {fields.review_by && <button type="button" className="ghost small" onClick={() => onChange({ review_by: "" })}>Clear</button>}
      </dd></div>
      <div><dt id={`${id}-files`}>Files</dt><dd>
        <textarea aria-labelledby={`${id}-files`} rows={Math.min(6, Math.max(1, fields.files.length + 1))} value={fields.files.join("\n")} placeholder="one path per line"
          onChange={(e) => onChange({ files: e.target.value.split("\n") })} />
      </dd></div>
      {note && <div><dt>Updated</dt><dd className="muted">{shortDate(note.updated)}{note.origin ? ` · origin ${note.origin}` : ""}</dd></div>}
    </dl>
  );
}
