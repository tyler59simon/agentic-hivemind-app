// Briefings and drafts as text to copy or export, and the checks on what a generated text cites.
import type { Briefing, Evidence } from "../../lib/executive";

/** The evidence ids a bullet cites that the briefing really carries; a bullet with none is unsupported. */
export function knownCitations(ids: string[], evidence: Evidence[]): string[] {
  const have = new Set(evidence.map((e) => e.id));
  return ids.filter((id) => have.has(id));
}

/** Bullets that cite nothing the briefing carries. */
export function unsupported(b: Pick<Briefing, "sections" | "evidence">): number {
  return b.sections.reduce((n, s) => n + s.bullets.filter((x) => !knownCitations(x.evidence, b.evidence).length).length, 0);
}

/** Every gap the briefing reports, the model's and the pack's, without repeats. */
export const allGaps = (b: Pick<Briefing, "gaps" | "packGaps">) => [...new Set([...(b.gaps ?? []), ...(b.packGaps ?? [])])];

const INLINE = /\s*\[(E\d+(?:\s*,\s*E\d+)*)\]/g;

/** A briefing with its citations numbered in the order first cited, the summary first. Inline ids like [E3] in the summary
 * become those numbers; in a bullet they are dropped, since the bullet's own evidence list is shown as its citation. */
export function numbered(b: Pick<Briefing, "summary" | "sections" | "evidence">) {
  const have = new Set(b.evidence.map((e) => e.id));
  const order: string[] = [];
  const num = (id: string) => {
    if (!order.includes(id)) order.push(id);
    return order.indexOf(id) + 1;
  };
  const summary = b.summary.replace(INLINE, (_, ids: string) => {
    const n = ids.split(",").map((id) => id.trim()).filter((id) => have.has(id)).map(num);
    return n.length ? ` [${n.join(", ")}]` : "";
  });
  const sections = b.sections.map((s) => ({
    heading: s.heading,
    bullets: s.bullets.map((x) => ({ text: x.text.replace(INLINE, ""), nums: knownCitations(x.evidence, b.evidence).map(num) })),
  }));
  const byId = new Map(b.evidence.map((e) => [e.id, e]));
  return { summary, sections, cited: order.map((id) => byId.get(id)!), numbers: new Map(order.map((id, i) => [id, i + 1])) };
}

/** A draft without evidence ids such as [E3]: they are for Hivemind, not the reader. */
export const stripCitations = (text: string) => text.replace(INLINE, "");

/** Markdown with numbered sources at the end, in the order first cited. */
export function briefingMarkdown(b: Briefing): string {
  const n = numbered(b);
  const lines = [`# ${b.title}`, "", n.summary, ""];
  for (const s of n.sections) {
    lines.push(`## ${s.heading}`, "");
    for (const x of s.bullets) lines.push(`- ${x.text}${x.nums.length ? ` [${x.nums.join(", ")}]` : ""}`);
    lines.push("");
  }
  const gaps = allGaps(b);
  if (gaps.length) lines.push("## Missing or uncertain", "", ...gaps.map((g) => `- ${g}`), "");
  if (n.cited.length) lines.push("## Sources", "", ...n.cited.map((e, i) => `${i + 1}. ${sourceLine(e)}`), "");
  return lines.join("\n").trim() + "\n";
}

const sourceLine = (e: Evidence) => [e.title, e.project, e.date].filter(Boolean).join(", ");

/** Markdown as plain text: headings, emphasis and links reduced to their words. */
export function plainText(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/`([^`]+)`/g, "$1");
}

/** An unsent email file (`X-Unsent: 1` makes Outlook open it as a draft to send). */
export function emlText(to: string, subject: string, body: string): string {
  const header = (v: string) => v.replace(/[\r\n]+/g, " ").trim();
  return [`To: ${header(to)}`, `Subject: ${header(subject)}`, "X-Unsent: 1", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", plainText(body).replace(/\r?\n/g, "\r\n")].join("\r\n");
}

/** Whether the user changed a generated draft enough to learn from: more than whitespace, and more than a few characters. */
export function edited(generated: string, kept: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const a = squash(generated);
  const b = squash(kept);
  if (a === b) return false;
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  let end = 0;
  while (end < a.length - same && end < b.length - same && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length, b.length) - same - end >= 20;
}
