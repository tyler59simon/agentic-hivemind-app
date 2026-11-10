import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { classify } from "../../lib/errors";
import { domains, search, type Project } from "../../lib/lm";
import { recordOperation } from "../../lib/oplog";
import { refreshStore } from "../../lib/refresh";
import { Modal } from "../../ui/Modal";
import { toast } from "../../ui/toast";
import { NoteLink } from "../preview/NoteLink";
import { assignToProject, dismiss, dismissed, suggestTriage } from "./triage";
import { useAllLinks, useTriageRows } from "./useProject";

/** Existing notes that may belong to the project, to tag in one go. */
export function Triage({ project, onClose }: { project: Project; onClose: () => void }) {
  const client = useQueryClient();
  const all = useTriageRows(true);
  const links = useAllLinks(true);
  const known = useQuery({ queryKey: ["domains"], queryFn: domains });
  const searchDomain = known.data?.domains[0]?.name;
  const hits = useQuery({
    queryKey: ["triage-search", project.slug, project.name],
    queryFn: () => search({ query: project.name, domain: searchDomain!, scope: "all", limit: 30 }),
    enabled: !!searchDomain, retry: false, staleTime: 60_000,
  });
  const [version, setVersion] = useState(0);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const suggestions = useMemo(() => {
    if (!all.data || !known.data) return [];
    const byId = new Set((hits.data?.results ?? []).map((h) => h.id));
    const found = new Set(all.data.notes.filter((n) => byId.has(n.id)).map((n) => n.ref));
    const skip = dismissed(project.slug);
    return suggestTriage({ project, rows: all.data.notes, domains: known.data.domains, graph: links.data, hits: found })
      .filter((s) => !skip.has(s.ref));
  }, [all.data, known.data, links.data, hits.data, project, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const checked = (s: { ref: string; level: string }) => picked[s.ref] ?? s.level === "likely";
  const chosen = suggestions.filter(checked);

  const assign = async () => {
    const byRef = new Map((all.data?.notes ?? []).map((n) => [n.ref, n]));
    setBusy(true);
    try {
      const results = await assignToProject(chosen.map((s) => byRef.get(s.ref)!).filter(Boolean), project.tag);
      for (const r of results) if (r.ok) recordOperation(r.operation_id);
      await refreshStore(client);
      const ok = results.filter((r) => r.ok).length;
      if (ok) toast(`Added ${ok} note${ok > 1 ? "s" : ""} to ${project.name}`);
      for (const r of results) if (!r.ok) toast(`${byRef.get(r.ref)?.title ?? r.ref}: ${r.error}`, "error");
      setPicked({});
    } finally { setBusy(false); }
  };

  const group = (level: "likely" | "maybe", label: string) => {
    const list = suggestions.filter((s) => s.level === level);
    if (!list.length) return null;
    return (
      <div className="triage-group">
        <div className="muted small triage-label">{label} · {list.length}</div>
        {list.map((s) => (
          <div key={s.ref} className="triage-row">
            <input type="checkbox" checked={checked(s)} onChange={(e) => setPicked({ ...picked, [s.ref]: e.target.checked })} aria-label={`Select ${s.title}`} />
            <div className="triage-main">
              <div className="triage-title">
                <span className={`badge type-${s.type}`}>{s.type}</span>
                <NoteLink row={s} />
                <span className="muted small">{s.domain}</span>
              </div>
              <div className="chips">{s.reasons.map((r) => <span key={r} className="chip reason-chip">{r}</span>)}</div>
              {!!s.otherProjects.length && <div className="muted small">Also in: {s.otherProjects.join(", ")}</div>}
            </div>
            <button className="ghost small" onClick={() => { dismiss(project.slug, s.ref); setVersion((v) => v + 1); }}>Dismiss</button>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Modal title={`Find notes for ${project.name}`} wide onClose={onClose} locked={busy}>
      <p className="muted">Existing notes that may belong to this project. Assigning adds the tag <code>{project.tag}</code>.</p>
      {all.isLoading || known.isLoading ? <p className="muted">Looking through the store…</p>
        : all.error ? <p className="error">{classify(all.error).message}</p>
        : !suggestions.length ? <p className="muted">No suggestions beyond the notes already in the project.</p>
        : <>{group("likely", "Likely")}{group("maybe", "Maybe")}</>}
      <div className="actions">
        <button onClick={onClose} disabled={busy}>Close</button>
        <button className="primary" disabled={!chosen.length || busy} onClick={assign}>{busy ? "Assigning…" : `Assign selected (${chosen.length})`}</button>
      </div>
    </Modal>
  );
}
