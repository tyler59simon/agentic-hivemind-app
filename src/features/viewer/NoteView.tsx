import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { read, type Note } from "../../lib/lm";
import { shortDate } from "../../lib/text";

function Properties({ note }: { note: Note }) {
  const rows: [string, React.ReactNode][] = [
    ["Type", <span className={`badge type-${note.type}`}>{note.type}</span>],
    ["Status", <span className={`badge status-${note.status}`}>{note.status}</span>],
    ["Tags", <span className="tags">{note.tags.map((t) => <span key={t} className="tag">{t}</span>)}</span>],
    ["Domain", note.domain],
    ["Created", shortDate(note.created)],
    ["Updated", shortDate(note.updated)],
  ];
  if (note.review_by) rows.push(["Review by", note.review_by]);
  if (note.context) rows.push(["Context", note.context]);
  if (note.files?.length) rows.push(["Files", <span className="files">{note.files.map((f) => <code key={f}>{f}</code>)}</span>]);
  if (note.superseded_by) rows.push(["Superseded by", <code>{note.superseded_by.slice(0, 8)}</code>]);
  return (
    <dl className="properties">
      {rows.map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
    </dl>
  );
}

export function NoteView({ refId }: { refId: string }) {
  const note = useQuery({ queryKey: ["note", refId], queryFn: () => read(refId) });
  if (note.isLoading) return <p className="muted pad">Loading…</p>;
  if (note.error) return <p className="error pad">{String(note.error)}</p>;
  const n = note.data!;
  return (
    <article className="note">
      <h1>{n.title}</h1>
      <Properties note={n} />
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm]}>{n.body}</Markdown>
      </div>
      {n.truncated && <p className="muted">This note is longer than 64,000 characters; the rest is not shown.</p>}
    </article>
  );
}
