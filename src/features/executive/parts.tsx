// Pieces the Executive tabs share: the evidence a generated text rests on, its gaps, and a health chip.
import { TriangleAlert } from "lucide-react";
import type { Evidence, HealthStatus } from "../../lib/executive";
import { NoteLink } from "../preview/NoteLink";
import { HEALTH_CHIP, HEALTH_LABEL } from "./health";

/** A note ref (not one of Hivemind's own `milestone:` or `health:` records). */
export const isNoteRef = (ref?: string | null): ref is string => !!ref && !/^(milestone|health):/.test(ref);

export function EvidenceList({ evidence, numbers }: { evidence: Evidence[]; numbers?: Map<string, number> }) {
  if (!evidence.length) return <p className="muted small">No evidence was cited.</p>;
  return (
    <ol className="exec-evidence">
      {evidence.map((e) => (
        <li key={e.id} value={numbers?.get(e.id)}>
          <span className="badge">{e.kind}</span>{" "}
          {isNoteRef(e.ref) ? <NoteLink row={{ ref: e.ref, title: e.title }} /> : <span>{e.title}</span>}
          <span className="muted small"> {[e.project, e.date].filter(Boolean).join(", ")}</span>
        </li>
      ))}
    </ol>
  );
}

export function Gaps({ gaps, title = "Missing or uncertain" }: { gaps: string[]; title?: string }) {
  if (!gaps.length) return null;
  return (
    <div className="banner warn">
      <strong><TriangleAlert size="1em" aria-hidden /> {title}</strong>
      <ul>{gaps.map((g) => <li key={g}>{g}</li>)}</ul>
    </div>
  );
}

export function HealthChip({ status, suggested }: { status: HealthStatus; suggested?: boolean }) {
  return (
    <span className={`status-chip ${HEALTH_CHIP[status]}`} title={suggested ? "Suggested from the signals; you have not set it" : "Set by you"}>
      {HEALTH_LABEL[status]}{suggested ? " (suggested)" : ""}
    </span>
  );
}
