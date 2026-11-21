// Small editors for what Rich mode shows drawn (NS-3B): math, `[[links]]`, embeds, pictures, inline source and
// footnote references open one on double-click, and the toolbar's link button opens one for links (Ctrl+K stays the
// app's search, as in Live).
import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

const FIELDS: Record<string, { key: string; label: string; area?: boolean }[]> = {
  mathInline: [{ key: "value", label: "TeX" }],
  mathBlock: [{ key: "value", label: "TeX", area: true }],
  wikiLink: [{ key: "value", label: "Page (Page#Heading|shown text)" }],
  embed: [{ key: "value", label: "Page or file to embed (Page#Heading, picture.png|300)" }],
  image: [{ key: "src", label: "Picture path or web address" }, { key: "alt", label: "Description (|300 sets the width)" }],
  rawInline: [{ key: "value", label: "Markdown source" }],
  footnoteRef: [{ key: "label", label: "Footnote name" }],
};

/** Keep the space or line breaks around math as they were written; only the TeX inside changes. */
function framed(old: string, text: string) {
  const lead = /^\s*/.exec(old)![0], tail = /\s*$/.exec(old)![0];
  return old.trim() ? `${lead}${text.trim()}${tail}` : `\n${text.trim()}\n`;
}

export function AtomPopover({ editor, pos, style, onClose }: { editor: Editor; pos: number; style: CSSProperties | null; onClose: () => void }) {
  const node = editor.state.doc.nodeAt(pos);
  const fields = node ? FIELDS[node.type.name] ?? [] : [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => {
    const v = (node?.attrs[f.key] ?? "") as string;
    return [f.key, node?.type.name === "mathBlock" ? v.trim() : v];
  })));
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { first.current?.focus(); first.current?.select(); }, []);
  if (!node || !fields.length) return null;
  const empty = fields.every((f) => !(node.attrs[f.key] ?? ""));
  const apply = () => {
    const current = editor.state.doc.nodeAt(pos);
    if (!current || current.type !== node.type) return onClose();
    const attrs: Record<string, unknown> = { ...current.attrs };
    for (const f of fields) attrs[f.key] = current.type.name === "mathBlock" ? framed(current.attrs.value, values[f.key]) : values[f.key];
    if (current.type.name === "footnoteRef") attrs.identifier = values.label.toLowerCase();
    if (current.type.name === "rawInline") attrs.original = null;
    const tr = fields.every((f) => !values[f.key].trim()) ? editor.state.tr.delete(pos, pos + current.nodeSize) : editor.state.tr.setNodeMarkup(pos, undefined, attrs);
    editor.view.dispatch(tr);
    onClose();
  };
  const cancel = () => {
    // A new atom left empty is removed rather than kept blank.
    const current = editor.state.doc.nodeAt(pos);
    if (empty && current === node) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
    onClose();
  };
  const keys = (e: KeyboardEvent, area?: boolean) => {
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
    else if (e.key === "Enter" && (!area || e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); }
  };
  return (
    <div className="rich-popover card" style={style ?? undefined} role="dialog" aria-label="Edit">
      {fields.map((f, i) => (
        <label key={f.key}>
          <span className="muted">{f.label}</span>
          {f.area
            ? <textarea ref={i === 0 ? first : undefined} rows={4} value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} onKeyDown={(e) => keys(e, true)} spellCheck={false} />
            : <input ref={i === 0 ? first : undefined} value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} onKeyDown={(e) => keys(e)} spellCheck={false} />}
        </label>
      ))}
      <div className="actions">
        <button type="button" className="primary" onClick={apply}>Apply</button>
        <button type="button" onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}

export function LinkPopover({ editor, style, onClose }: { editor: Editor; style: CSSProperties | null; onClose: () => void }) {
  const current = editor.getAttributes("link").href as string | undefined;
  const [href, setHref] = useState(current ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const apply = () => {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!url) chain.unsetLink().run();
    else if (editor.state.selection.empty && !current) chain.insertContent({ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }).run();
    else chain.setLink({ href: url }).run();
    onClose();
  };
  return (
    <div className="rich-popover card" style={style ?? undefined} role="dialog" aria-label="Link">
      <label>
        <span className="muted">Link address (a web address, a relative path or a page)</span>
        <input ref={input} value={href} onChange={(e) => setHref(e.target.value)} spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } else if (e.key === "Escape") { e.preventDefault(); onClose(); } }} />
      </label>
      <div className="actions">
        <button type="button" className="primary" onClick={apply}>Apply</button>
        {current && <button type="button" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); onClose(); }}>Remove link</button>}
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
