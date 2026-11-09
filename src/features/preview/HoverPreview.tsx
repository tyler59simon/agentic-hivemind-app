import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { read } from "../../lib/lm";
import { sections } from "../../lib/note";

const DELAY = 400;

/** The preview card itself, at a screen position (used by HoverPreview and the graph). */
export function PreviewCard({ refId, x, y }: { refId: string; x: number; y: number }) {
  const note = useQuery({ queryKey: ["preview", refId], queryFn: () => read(refId, { maxChars: 2000 }), staleTime: 60_000 });
  const n = note.data;
  return createPortal(
    <div className="hover-card" style={{ left: x, top: y }}>
      {note.isLoading && <p className="muted">Loading…</p>}
      {note.error && <p className="error">{String(note.error)}</p>}
      {n && (
        <>
          <strong className="hover-title">{n.title}</strong>
          <div className="result-meta">
            <span className={`badge type-${n.type}`}>{n.type}</span>
            {n.status !== "active" && <span className={`badge status-${n.status}`}>{n.status}</span>}
            <span className="muted small">{n.domain}</span>
          </div>
          <div className="markdown small"><Markdown remarkPlugins={[remarkGfm]}>{sections(n.body).summary ?? ""}</Markdown></div>
          {!!n.tags.length && <div className="tags">{n.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>}
        </>
      )}
    </div>,
    document.body,
  );
}

/** Wrap anything that names a note; after a short hover, a card shows its type, tags and summary. */
export function HoverPreview({ refId, children }: { refId: string | null | undefined; children: ReactNode }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const span = useRef<HTMLSpanElement>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!refId) return <>{children}</>;
  const show = () => {
    timer.current = setTimeout(() => {
      const r = span.current?.getBoundingClientRect();
      if (!r) return;
      const x = Math.min(r.left, window.innerWidth - 380);
      const y = r.bottom + 260 > window.innerHeight ? Math.max(8, r.top - 260) : r.bottom + 6;
      setAt({ x: Math.max(8, x), y });
    }, DELAY);
  };
  const hide = () => { if (timer.current) clearTimeout(timer.current); setAt(null); };
  return (
    <span ref={span} className="hover-anchor" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {at && <PreviewCard refId={refId} x={at.x} y={at.y} />}
    </span>
  );
}
