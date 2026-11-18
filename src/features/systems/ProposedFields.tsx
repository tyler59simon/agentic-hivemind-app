import type { System, SystemUpdate } from "../../lib/lm";

const show = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "(none)" : Array.isArray(v) ? (v.length ? v.join(", ") : "(none)") : String(v);

/** The fields of a proposed system update that differ, as current and proposed values. */
export function changedFields(system: System, update: SystemUpdate): { field: string; before: string; after: string }[] {
  const now = system as unknown as Record<string, unknown>;
  return Object.entries(update).filter(([k]) => k !== "slug")
    .map(([field, value]) => ({ field, before: show(now[field]), after: show(value) }));
}

export function ProposedFields({ system, update }: { system: System; update: SystemUpdate }) {
  return (
    <>
      <p>These are the registry fields the agent proposed. Nothing changes until you apply them.</p>
      <ul>
        {changedFields(system, update).map((c) => (
          <li key={c.field}><strong>{c.field}</strong>: <span className="muted">{c.before}</span> → {c.after}</li>
        ))}
      </ul>
    </>
  );
}
