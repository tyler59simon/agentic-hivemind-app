// The wiki with All projects picked: the projects to open it on, and "Whole domain" for the wiki of a whole domain. Also the
// state of a picked project that has no notes in its domain.
import { BookOpen, Package } from "lucide-react";
import { Row, Section } from "../../ui/Page";
import { plural } from "./parts";

export function WikiProjects({ rows, domain, onWhole, onPick }: {
  rows: { slug: string; name: string; count?: number }[]; domain: string | null; onWhole: () => void; onPick: (slug: string) => void;
}) {
  return (
    <Section title="Projects" count={rows.length} className="wiki-projects">
      <p className="muted">Pick a project to read its memory as a wiki. It becomes the project picked in the sidebar.</p>
      <Row icon={<BookOpen size="1.2em" aria-hidden />} onClick={onWhole} title="Every note of the domain, in both editions">Whole domain{domain ? ` (${domain})` : ""}</Row>
      {rows.map((r) => (
        <Row key={r.slug} icon={<Package size="1.2em" aria-hidden />} onClick={() => onPick(r.slug)} meta={r.count != null ? plural(r.count, "note") : undefined}>{r.name}</Row>
      ))}
      {!rows.length && <p className="muted">No projects yet.</p>}
    </Section>
  );
}

/** A picked project none of whose notes are in the domain: plain, not an error. */
export function NoNotes({ domain, name, tag }: { domain: string; name: string; tag: string }) {
  return (
    <div className="wiki-empty">
      <BookOpen size="1.6em" aria-hidden />
      <h2>No notes yet</h2>
      <p className="muted">No note in the <b>{domain}</b> domain carries the tag <code>{tag}</code>, so {name} has no wiki yet. Notes with that tag appear here.</p>
    </div>
  );
}
