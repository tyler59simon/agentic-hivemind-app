// The pickers for the embeds of a rich page (NS-3D): each opens from the slash menu or the toolbar (or on double-click of
// an embed) and hands back the attributes to store. They only read: Living Memory's notes and systems, and the files of
// the page's own notebook. Nothing is written until the page takes what they hand back.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { systemArchitecture, type Diagram } from "../../../lib/architecture";
import { domains, list, search, systems, type System } from "../../../lib/lm";
import { classify } from "../../../lib/errors";
import { Modal } from "../../../ui/Modal";
import type { NotebookFiles } from "../../editor/rich/context";
import { fromHit, fromRow, type Item } from "../../library/library";
import { captureRange, fileLines, rangeLabel } from "./codeRange";
import { PICTURE_PATH, MAX_GALLERY, MAX_RANGE_LINES } from "../rules";

type Attrs = Record<string, unknown>;
interface DialogProps<T = Attrs> { initial: T | null; onPick(attrs: T): void; onClose(): void }
type FileDialogProps = DialogProps & { files: NotebookFiles | undefined };
/** What a picker needs to copy pictures from outside the notebook into it (the page's attach path). */
type Attacher = { attach?: (bytes: Uint8Array, name: string) => Promise<string>; fail?: (message: string) => void };

const BINARY = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|pdf|zip|gz|7z|rar|exe|dll|woff2?|ttf|otf|mp[34]|mov|wav|bin|docx?|xlsx?|pptx?|excalidraw)$/i;
const baseName = (path: string) => path.split("/").pop() ?? path;
const extOf = (path: string) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1].toLowerCase() ?? "";

const row = (label: string, control: ReactNode) => <label className="hm-view-row"><span>{label}</span>{control}</label>;
const NoNotebook = ({ onClose }: { onClose(): void }) => (
  <Modal title="Embed" onClose={onClose}>
    <p className="muted">This page is not in a folder notebook, so it has no files to embed.</p>
    <div className="actions"><button onClick={onClose}>Close</button></div>
  </Modal>
);

// ---- Memory note ----

export function NoteCardDialog({ initial, onPick, onClose }: DialogProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    const timer = setTimeout(() => {
      (async () => {
        if (query.trim()) {
          const known = await domains();
          const domain = known.domains[0]?.name;
          if (!domain) return [];
          return (await search({ query: query.trim(), domain, scope: "all", limit: 20 })).results.map(fromHit);
        }
        return (await list({ allDomains: true, status: "active", limit: 20 })).notes.map(fromRow);
      })().then((items) => { if (!gone) { setHits(items); setError(null); } }, (e) => { if (!gone) setError(classify(e).message); });
    }, query ? 250 : 0);
    return () => { gone = true; clearTimeout(timer); };
  }, [query]);
  return (
    <Modal title="Embed a memory note" onClose={onClose}>
      {initial?.ref ? <p className="muted">Now: {String(initial.title || initial.ref)}</p> : null}
      <input autoFocus aria-label="Search notes" placeholder="Search Living Memory notes" value={query} onChange={(e) => setQuery(e.target.value)} />
      {error && <p className="muted">Living Memory did not answer: {error}</p>}
      {hits && !hits.length && !error && <p className="muted">No notes found.</p>}
      <ul className="plain-list hm-pick-list" aria-label="Notes">
        {(hits ?? []).map((h) => (
          <li key={h.ref}>
            <button className="link-row" onClick={() => onPick({ ref: h.ref, title: h.title })}>
              {h.title} <span className="muted small">{h.type} · {h.domain}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="actions"><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

// ---- Architecture diagram ----

export function DiagramDialog({ initial, onPick, onClose }: DialogProps) {
  const [all, setAll] = useState<System[] | null>(null);
  const [slug, setSlug] = useState<string>(String(initial?.system ?? ""));
  const [diagrams, setDiagrams] = useState<Diagram[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { systems().then((r) => setAll(r.systems), (e) => setError(classify(e).message)); }, []);
  useEffect(() => {
    setDiagrams(null);
    if (!slug) return;
    let gone = false;
    systemArchitecture(slug).then((a) => { if (!gone) { setDiagrams(a.diagrams); setError(a.error); } }, (e) => { if (!gone) setError(classify(e).message); });
    return () => { gone = true; };
  }, [slug]);
  const system = all?.find((s) => s.slug === slug);
  return (
    <Modal title="Embed an architecture diagram" onClose={onClose}>
      {row("System", (
        <select aria-label="System" value={slug} onChange={(e) => setSlug(e.target.value)}>
          <option value="">Choose a system</option>
          {(all ?? []).map((s) => <option key={s.slug} value={s.slug}>{s.name}</option>)}
        </select>
      ))}
      {error && <p className="muted">{error}</p>}
      {diagrams && !diagrams.length && !error && <p className="muted">This system has no diagrams listed in its Architecture Suite output.</p>}
      <ul className="plain-list hm-pick-list" aria-label="Diagrams">
        {(diagrams ?? []).map((d) => (
          <li key={d.path}>
            <button className="link-row" onClick={() => onPick({ system: slug, path: d.path, title: `${system?.name ?? slug}, ${d.level}` })}>
              {d.path} <span className="muted small">{d.level} · {d.format}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="actions"><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

// ---- Code range ----

export function CodeRangeDialog({ initial, files, onPick, onClose }: FileDialogProps) {
  const candidates = useMemo(() => (files?.files ?? []).filter((f) => !BINARY.test(f)).sort(), [files]);
  const [file, setFile] = useState(String(initial?.file ?? ""));
  const [lines, setLines] = useState<string[] | null>(null);
  const [from, setFrom] = useState(Number(initial?.from ?? 1));
  const [to, setTo] = useState(Number(initial?.to ?? 1));
  const [title, setTitle] = useState(String(initial?.title ?? ""));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLines(null);
    if (!file || !files) return;
    let gone = false;
    files.read(file).then((f) => {
      if (gone) return;
      if (f.binary) { setError(`${file} is not a text file.`); return; }
      setError(null);
      setLines(fileLines(f.text));
    }, (e) => { if (!gone) setError(classify(e).message); });
    return () => { gone = true; };
  }, [file, files]);
  if (!files) return <NoNotebook onClose={onClose} />;
  const captured = lines ? captureRange(lines, from, to) : null;
  const pick = () => {
    if (!captured?.ok) return;
    onPick({ file, from, to, sha256: captured.captured.sha256, text: captured.captured.text, language: extOf(file), title: title.trim() });
  };
  return (
    <Modal title="Embed a code range" onClose={onClose} wide>
      {row("File", (
        <select aria-label="File" value={file} onChange={(e) => { setFile(e.target.value); setFrom(1); setTo(1); }}>
          <option value="">Choose a file</option>
          {file && !candidates.includes(file) && <option value={file}>{file}</option>}
          {candidates.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      ))}
      {error && <p className="muted">{error}</p>}
      {lines && (
        <>
          <div className="hm-view-row">
            <span>Lines</span>
            <input aria-label="First line" type="number" min={1} max={lines.length || 1} value={from} onChange={(e) => setFrom(Number(e.target.value))} />
            <span>to</span>
            <input aria-label="Last line" type="number" min={1} max={lines.length || 1} value={to} onChange={(e) => setTo(Number(e.target.value))} />
            <span className="muted small">of {lines.length}, at most {MAX_RANGE_LINES}</span>
          </div>
          {captured && !captured.ok && <p className="muted" role="alert">{captured.reason}</p>}
          {captured?.ok && <pre className="hm-pick-preview" aria-label="Preview">{captured.captured.text.split("\n").slice(0, 12).join("\n")}</pre>}
          {row("Title (optional)", <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />)}
        </>
      )}
      <div className="actions">
        <button className="primary" onClick={pick} disabled={!captured?.ok}>{file && captured?.ok ? `Embed ${rangeLabel(file, from, to)}` : "Embed"}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---- PDF page ----

export function PdfDialog({ initial, files, onPick, onClose }: FileDialogProps) {
  const pdfs = useMemo(() => (files?.files ?? []).filter((f) => /\.pdf$/i.test(f)).sort(), [files]);
  const [file, setFile] = useState(String(initial?.file ?? ""));
  const [page, setPage] = useState(Number(initial?.page ?? 1));
  const [title, setTitle] = useState(String(initial?.title ?? ""));
  if (!files) return <NoNotebook onClose={onClose} />;
  const valid = !!file && Number.isInteger(page) && page >= 1;
  return (
    <Modal title="Embed a PDF page" onClose={onClose}>
      {row("PDF", (
        <select aria-label="PDF" value={file} onChange={(e) => setFile(e.target.value)}>
          <option value="">Choose a PDF</option>
          {file && !pdfs.includes(file) && <option value={file}>{file}</option>}
          {pdfs.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
      ))}
      {!pdfs.length && <p className="muted">This notebook has no PDF files. Add one to the notebook's folder first.</p>}
      {row("Page", <input aria-label="Page" type="number" min={1} value={page} onChange={(e) => setPage(Number(e.target.value))} />)}
      {row("Title (optional)", <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />)}
      <div className="actions">
        <button className="primary" disabled={!valid} onClick={() => onPick({ file, page, title: title.trim() })}>Embed page {valid ? page : ""}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---- Gallery ----

export function GalleryDialog({ initial, files, attach, fail, onPick, onClose }: FileDialogProps & Attacher) {
  // Pictures added from outside the notebook are in the notebook at once, before its tree lists them.
  const [added, setAdded] = useState<string[]>([]);
  const pictures = useMemo(() => [...new Set([...(files?.files ?? []), ...added])].filter((f) => PICTURE_PATH.test(f)).sort(), [files, added]);
  const [chosen, setChosen] = useState<string[]>(Array.isArray(initial?.images) ? (initial.images as string[]) : []);
  const [columns, setColumns] = useState(Number(initial?.columns ?? 3));
  const [title, setTitle] = useState(String(initial?.title ?? ""));
  const picker = useRef<HTMLInputElement>(null);
  if (!files) return <NoNotebook onClose={onClose} />;
  const toggle = (p: string) => setChosen((c) => (c.includes(p) ? c.filter((x) => x !== p) : c.length < MAX_GALLERY ? [...c, p] : c));
  const add = async (list: FileList | null) => {
    for (const file of [...(list ?? [])].filter((f) => PICTURE_PATH.test(f.name) || f.type.startsWith("image/"))) {
      try {
        const path = await attach!(new Uint8Array(await file.arrayBuffer()), file.name);
        setAdded((a) => [...a, path]);
        setChosen((c) => (c.length < MAX_GALLERY ? [...c, path] : c));
      } catch (e) { fail?.(`${file.name} was not attached: ${classify(e).message}`); }
    }
  };
  return (
    <Modal title="Embed a gallery" onClose={onClose} wide>
      <p className="muted">Pictures show in the order you choose them.</p>
      {!pictures.length && <p className="muted">This notebook has no pictures yet.</p>}
      <ul className="hm-pick-grid" aria-label="Pictures">
        {pictures.map((p) => {
          const url = files.url(p);
          return (
            <li key={p}>
              <label title={p}>
                <input type="checkbox" checked={chosen.includes(p)} onChange={() => toggle(p)} aria-label={p} />
                {url ? <img src={url} alt="" loading="lazy" /> : <span className="rich-missing">{baseName(p)}</span>}
                <span className="small">{chosen.includes(p) ? `${chosen.indexOf(p) + 1}. ` : ""}{baseName(p)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      {attach && (
        <>
          <button onClick={() => picker.current?.click()}>Add pictures from your computer…</button>
          <input ref={picker} type="file" accept="image/*" multiple hidden aria-label="Add pictures"
            onChange={(e) => { const list = e.target.files; void add(list).finally(() => { e.target.value = ""; }); }} />
        </>
      )}
      {row("Columns", (
        <select aria-label="Columns" value={columns} onChange={(e) => setColumns(Number(e.target.value))}>
          {[2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      ))}
      {row("Title (optional)", <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />)}
      <div className="actions">
        <button className="primary" disabled={!chosen.length} onClick={() => onPick({ images: chosen, columns, title: title.trim() })}>Embed {chosen.length || ""} {chosen.length === 1 ? "picture" : "pictures"}</button>
        <button onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
