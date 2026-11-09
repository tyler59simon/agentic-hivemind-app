// An agent context pack for a project: Markdown built from the registry entry, charter and member notes.
import { sections } from "../../lib/note";
import type { Note, NoteRow, OpenItem, Project } from "../../lib/lm";

export interface BriefingCommit { sha: string; subject: string; date: string; author?: string }

export const isoDay = (value: Date | string) => (typeof value === "string" ? value : value.toISOString()).slice(0, 10);
export const shortRef = (ref: string) => (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref).slice(0, 8);

const oneLine = (text?: string) => (text ?? "").replace(/\s+/g, " ").trim();

export function buildBriefing(input: {
  project: Project; charter?: Pick<Note, "title" | "body"> | null; rows: NoteRow[]; open: OpenItem[];
  commits?: BriefingCommit[]; now?: Date; maxChars?: number;
}): string {
  const { project, charter, rows, now = new Date(), maxChars = 8000 } = input;
  const active = (type: NoteRow["type"]) => rows.filter((r) => r.type === type && r.status === "active");
  const newest = (a: NoteRow, b: NoteRow) => b.created.localeCompare(a.created);

  // Open items grouped by note, in order of first appearance.
  const groups = new Map<string, OpenItem[]>();
  for (const item of input.open) (groups.get(item.ref) ?? groups.set(item.ref, []).get(item.ref)!).push(item);
  const open = [...groups.values()].flat().map((i) => `- [ ] ${oneLine(i.item)} (${i.title} · ${i.short_ref})`);

  const withSummary = (r: NoteRow, line: string) => (r.summary ? `${line} — ${oneLine(r.summary)}` : line);
  const decisions = active("decision").sort(newest).slice(0, 15)
    .map((r) => withSummary(r, `- **${r.title}** (${isoDay(r.created)}, ${r.ref})`));
  const risks = [...active("risk"), ...active("bug")].sort(newest)
    .map((r) => withSummary(r, `- **${r.title}** (${r.type}, ${r.ref})`));
  const plans = active("plan").sort(newest).map((r) => {
    const total = r.actions ? r.actions.open + r.actions.done : 0;
    return `- **${r.title}** (${r.ref})${r.actions ? ` — ${r.actions.done}/${total} done` : ""}`;
  });
  const status = active("status").sort(newest)[0];
  const commits = (input.commits ?? []).slice(0, 10).map((c) => `- ${c.sha.slice(0, 7)} ${oneLine(c.subject)} (${c.date})`);

  const head = [
    `# ${project.name} — project briefing`, "",
    `> Reference only: generated from Living Memory on ${isoDay(now)}. Verify against the current code before acting.`,
  ];
  const info = [`- Slug: ${project.slug} (tag \`${project.tag}\`)`, `- Status: ${project.status}`];
  if (project.repos.length) info.push("- Repos:", ...project.repos.map((r) => `  - ${r}`));
  if (project.description.trim()) info.push(`- Description: ${oneLine(project.description)}`);
  const charterParts: string[] = [];
  if (charter) {
    const s = sections(charter.body);
    if (s.summary) charterParts.push(s.summary);
    if (s.details) charterParts.push(s.details);
  }
  const footer = `Capture new notes for this project with \`--project ${project.slug}\`.`;

  const render = (truncated: boolean) => {
    const block = (title: string, lines: string[]) => (lines.length ? ["", `## ${title}`, ...lines] : []);
    return [
      ...head, ...block("Project", info),
      ...block("Charter", charterParts.length ? charterParts.join("\n\n").split("\n") : []),
      ...block("Open work", open), ...block("Decisions", decisions), ...block("Risks and open bugs", risks),
      ...block("Plans", plans),
      ...block("Latest status", status ? [withSummary(status, `**${status.title}** (${isoDay(status.created)}, ${status.ref})`)] : []),
      ...block("Recent commits", commits),
      ...(truncated ? ["", "_Content was truncated to fit the size limit._"] : []),
      "", footer, "",
    ].join("\n");
  };

  // Drop the lowest-priority content first, one line at a time.
  const order = [commits, plans, risks, decisions, open];
  let text = render(false);
  while (text.length > maxChars) {
    const list = order.find((l) => l.length);
    if (!list) break;
    list.pop();
    text = render(true);
  }
  return text;
}
