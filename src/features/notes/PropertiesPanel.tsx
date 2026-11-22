// The properties panel above a page (NS-7B): the frontmatter as typed fields. An edit changes the page's text through its
// document session (the open editor follows it, in Rich, Live and Source alike), and only the value of that key: `frontmatter.ts`
// copies every other byte of the block as it was. The page is then saved the way any edit is.
import { ChevronRight, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { edit, useDocuments } from "../../documents/store";
import { classify } from "../../lib/errors";
import { toast } from "../../ui/toast";
import { readProps, removeProp, setProp, type PropKind, type PropRow, type PropValue } from "./frontmatter";
import { isoDate } from "./tasks";

const NEW_KINDS: { id: Exclude<PropKind, "link">; label: string; start: PropValue }[] = [
  { id: "text", label: "Text", start: "" }, { id: "number", label: "Number", start: 0 }, { id: "date", label: "Date", start: "" },
  { id: "checkbox", label: "Checkbox", start: false }, { id: "list", label: "List", start: [] },
];

/** The value a field's text stands for. A list is its comma separated items; a number that is not one stays text. */
function valueOfField(kind: PropKind, raw: string): PropValue {
  if (kind === "list") return raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (kind === "number") return raw.trim() === "" || Number.isNaN(Number(raw)) ? raw : Number(raw);
  return raw;
}

function Field({ row, disabled, onSet, onOpen }: { row: PropRow; disabled: boolean; onSet: (value: PropValue) => void; onOpen?: (target: string) => void }) {
  const shown = Array.isArray(row.value) ? row.value.join(", ") : String(row.value);
  const commit = (raw: string) => { if (raw !== shown) onSet(valueOfField(row.kind, raw)); };
  const label = `Property ${row.key}`;
  if (!row.editable) return <code className="props-source" title="Hivemind leaves this value as it is">{row.source}</code>;
  if (row.kind === "checkbox") return <input type="checkbox" aria-label={label} checked={row.value === true} disabled={disabled} onChange={(e) => onSet(e.target.checked)} />;
  const link = row.kind === "link" ? String(row.value).slice(2, -2).split(/[|#]/)[0] : null;
  return (
    <>
      <input
        // A new key gives the field a fresh value when the page text changes under it.
        key={shown} aria-label={label} className={row.kind === "link" ? "props-link" : undefined} defaultValue={shown} disabled={disabled}
        type={row.kind === "number" ? "number" : row.kind === "date" ? "date" : "text"}
        placeholder={row.kind === "list" ? "a, b, c" : undefined}
        onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      />
      {link && onOpen && <button type="button" className="link" onClick={() => onOpen(link)} title={`Open ${link}`}>Open</button>}
    </>
  );
}

/** `docKey`: the document session of the page. `readOnly`: the page cannot take edits now. `onOpenLink` follows a `[[link]]`. */
export function PropertiesPanel({ docKey, readOnly, onOpenLink }: { docKey: string; readOnly: boolean; onOpenLink?: (target: string) => void }) {
  const text = useDocuments((s) => s.docs[docKey]?.text ?? "");
  const read = useMemo(() => readProps(text), [text]);
  const rows = read.state === "ok" ? read.props : [];
  const [adding, setAdding] = useState<{ name: string; kind: (typeof NEW_KINDS)[number]["id"] } | null>(null);
  const [open, setOpen] = useState(rows.length > 0);
  const change = (make: (current: string) => string) => {
    try {
      const current = useDocuments.getState().docs[docKey]?.text ?? "";
      const next = make(current);
      if (next !== current) edit(docKey, next, true);
    } catch (e) {
      toast(classify(e).message, "error");
    }
  };
  const add = () => {
    const name = adding?.name.trim() ?? "";
    if (!adding || !name) return;
    if (rows.some((r) => r.key === name)) { toast(`This page already has a property named ${name}.`, "warn"); return; }
    const kind = NEW_KINDS.find((k) => k.id === adding.kind)!;
    change((current) => setProp(current, name, kind.id === "date" ? isoDate(new Date()) : kind.start));
    setAdding(null);
  };

  return (
    <section className="props-panel" aria-label="Properties">
      <button type="button" className="props-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size="1em" aria-hidden className={open ? "turned" : ""} />Properties <span className="muted small">{rows.length || ""}</span>
      </button>
      {open && (
        <div className="props-body">
          {read.state === "bad" && <p className="muted small">{read.reason}, so Hivemind leaves them alone. Fix them in Source mode.</p>}
          {read.state === "ok" && (
            <dl>
              {rows.map((row) => (
                <div key={row.key} className="props-row">
                  <dt title={row.kind}>{row.key}</dt>
                  <dd>
                    <Field row={row} disabled={readOnly} onOpen={onOpenLink} onSet={(value) => change((current) => setProp(current, row.key, value))} />
                    {!readOnly && <button type="button" className="ghost icon" aria-label={`Remove property ${row.key}`} title="Remove" onClick={() => change((current) => removeProp(current, row.key))}><X size="1em" aria-hidden /></button>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {read.state !== "bad" && !readOnly && (adding
            ? (
              <form className="props-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
                <input autoFocus aria-label="Property name" placeholder="Name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
                <select aria-label="Property type" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as typeof adding.kind })}>
                  {NEW_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                </select>
                <button type="submit" className="primary" disabled={!adding.name.trim()}>Add</button>
                <button type="button" onClick={() => setAdding(null)}>Cancel</button>
              </form>
            )
            : <button type="button" className="ghost" onClick={() => setAdding({ name: "", kind: "text" })}><Plus size="1em" aria-hidden />Add property</button>)}
        </div>
      )}
    </section>
  );
}
