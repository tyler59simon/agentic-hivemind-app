// The note body layout, mirrored from Living Memory's core/note_format.py so the app numbers Action Items,
// finds sections and resolves [[links]] exactly as LM does. Parity is checked against fixtures LM generates
// (scripts/gen_note_fixtures.py -> src/lib/__fixtures__/note-format.json).
import type { NoteType } from "./lm";

export type SectionKey = "summary" | "details" | "links" | "actions" | "important";
export const HEADINGS: Record<Exclude<SectionKey, "important">, string> = {
  summary: "📌 Executive Summary",
  details: "📝 Key Details",
  links: "🗂️ Resource Links",
  actions: "🟩 Action Items",
};
export const CALLOUT = "> ℹ️ **Important Note:**";
export const ACTION_TYPES = new Set<NoteType>(["plan", "bug", "risk"]);

const H2 = /^##\s+(.*?)\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const CALLOUT_LINE = /^>\s*(?:ℹ️|ℹ|\[!\w+\])?\s*\**\s*Important Note:?\s*\**:?\s*(.*)$/i;
const EMPTY_LINE = /^\s*(?:>\s*)?(?:[-*+]\s*)?(?:\[[ xX]\]\s*)?(?:\*\*[^*]*:?\*\*:?|\*[^*]*:\*)?\s*$/;
const ACTION = /^(\s*[-*+]\s*)\[([ xX])\](.*)$/;

const letters = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean).join(" ");
const KEYS = Object.entries(HEADINGS).map(([key, label]) => [key, letters(label)] as const);

/** The layout key a `## heading` names (matched on its letters only), or null for a custom heading. */
export function sectionKey(heading: string): Exclude<SectionKey, "important"> | null {
  const text = letters(heading);
  return (KEYS.find(([, label]) => label === text)?.[0] as Exclude<SectionKey, "important">) ?? null;
}

function trim(lines: string[]): string[] {
  let a = 0, b = lines.length;
  while (a < b && (!lines[a].trim() || lines[a].trim() === "---")) a++;
  while (b > a && (!lines[b - 1].trim() || lines[b - 1].trim() === "---")) b--;
  return lines.slice(a, b);
}

/** Python's str.strip(ch): the character removed from both ends only. */
function stripChar(text: string, ch: string): string {
  let a = 0, b = text.length;
  while (a < b && text[a] === ch) a++;
  while (b > a && text[b - 1] === ch) b--;
  return text.slice(a, b);
}

export function stripTitle(body: string): string {
  let text = (body ?? "").trimStart();
  if (text.startsWith("# 🎯")) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
  return text.trim();
}

export interface Part { key: SectionKey | "preamble" | null; heading: string | null; text: string }

/** Ordered sections, as LM's `split`: fenced code is text; the callout runs until a non-quote line. */
export function split(body: string): Part[] {
  const parts: { key: Part["key"]; heading: string | null; lines: string[] }[] = [{ key: "preamble", heading: null, lines: [] }];
  let fence: string | null = null;
  for (const line of stripTitle(body).replace(/\r\n/g, "\n").split("\n")) {
    const last = parts[parts.length - 1];
    const mark = FENCE.exec(line);
    if (fence) {
      last.lines.push(line);
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !stripChar(line.trim(), fence[0])) fence = null;
      continue;
    }
    if (mark) fence = mark[1];
    const heading = mark ? null : H2.exec(line);
    const callout = CALLOUT_LINE.exec(line);
    if (heading) parts.push({ key: sectionKey(heading[1]), heading: heading[1], lines: [] });
    else if (callout && line.trimStart().startsWith(">")) parts.push({ key: "important", heading: null, lines: callout[1].trim() ? [callout[1]] : [] });
    else if (last.key === "important" && line.trimStart().startsWith(">")) last.lines.push(line.replace(/^\s*>\s?/, ""));
    else if (last.key === "important" && !line.trim()) last.lines.push("");
    else {
      if (last.key === "important") parts.push({ key: null, heading: null, lines: [] });
      parts[parts.length - 1].lines.push(line);
    }
  }
  return parts.map((p) => ({ key: p.key, heading: p.heading, text: trim(p.lines).join("\n") }));
}

const isEmpty = (text: string) => text.split("\n").every((line) => EMPTY_LINE.test(line));

/** Section text by key for a saved (already formatted) body; empty sections are left out. */
export function sections(body: string): Partial<Record<SectionKey, string>> {
  const found: Partial<Record<SectionKey, string>> = {};
  for (const part of split(body)) {
    if (part.key && part.key !== "preamble" && !isEmpty(part.text)) found[part.key] = part.text;
  }
  return found;
}

export interface ActionItem { index: number; line: number; done: boolean; text: string }

/** Checkboxes in Action Items with LM's 1-based `check --index` numbering (ticked items count too).
 *  Like LM, the section ends at the next `##` heading or the Important Note callout. */
export function actionItems(body: string): ActionItem[] {
  const found: ActionItem[] = [];
  let inside = false;
  body.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const heading = H2.exec(line);
    if (heading) inside = sectionKey(heading[1]) === "actions";
    else if (line.trimStart().startsWith(">") && CALLOUT_LINE.test(line)) inside = false;
    else if (inside) {
      const m = ACTION.exec(line);
      if (m) found.push({ index: found.length + 1, line: i, done: m[2] !== " ", text: m[3].trim() });
    }
  });
  return found;
}

export const EVIDENCE_HEADING = "Acceptance evidence";
export interface EvidenceItem { index: number; line: number; done: boolean; text: string }

/** Lines of the body, and the line range [start, end) of the evidence section: its heading line up to the next
 *  `##` heading or Important Note callout outside a code fence, or the end. `start` is -1 when there is no such section.
 *  `fenced[i]` says line i is part of a code fence. */
function evidenceRange(body: string): { lines: string[]; fenced: boolean[]; start: number; end: number } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const fenced: boolean[] = [];
  let fence: string | null = null;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mark = FENCE.exec(line);
    fenced.push(fence !== null || !!mark);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !stripChar(line.trim(), fence[0])) fence = null;
      continue;
    }
    if (mark) { fence = mark[1]; continue; }
    const heading = H2.exec(line);
    if (heading && start < 0 && letters(heading[1]) === letters(EVIDENCE_HEADING)) start = i;
    else if (start >= 0 && (heading || (line.startsWith(">") && CALLOUT_LINE.test(line)))) { end = i; break; }
  }
  return { lines, fenced, start, end };
}

/** Task-list lines of the brief's custom "## Acceptance evidence" section, numbered from 1. */
export function evidenceItems(body: string): EvidenceItem[] {
  const range = evidenceRange(body);
  if (range.start < 0) return [];
  const found: EvidenceItem[] = [];
  for (let i = range.start + 1; i < range.end; i++) {
    const m = range.fenced[i] ? null : ACTION.exec(range.lines[i]);
    if (m) found.push({ index: found.length + 1, line: i, done: m[2] !== " ", text: m[3].trim() });
  }
  return found;
}

/** The body with evidence item `index` (1-based) ticked or unticked; no other line changes. Throws RangeError when there is no such item. */
export function setEvidence(body: string, index: number, done: boolean): string {
  const item = evidenceItems(body).find((e) => e.index === index);
  if (!item) throw new RangeError(`No acceptance evidence item ${index}`);
  const { lines } = evidenceRange(body);
  const m = ACTION.exec(lines[item.line])!;
  lines[item.line] = m[1] + "[" + (done ? "x" : " ") + "]" + m[3];
  return lines.join("\n");
}

/** The body with one unchecked evidence item added at the end of the section, which is created when missing. */
export function addEvidence(body: string, text: string): string {
  const item = "- [ ] " + text.replace(/\s+/g, " ").trim();
  const { lines, fenced, start, end } = evidenceRange(body);
  if (start >= 0) {
    let last = end - 1;
    while (last > start && !lines[last].trim()) last--;
    lines.splice(last + 1, 0, item);
    return lines.join("\n");
  }
  const callout = lines.findIndex((line, i) => !fenced[i] && line.startsWith(">") && CALLOUT_LINE.test(line));
  if (callout < 0) return body.replace(/\s+$/, "") + "\n\n## " + EVIDENCE_HEADING + "\n" + item;
  lines.splice(callout, 0, ...(callout > 0 && lines[callout - 1].trim() ? [""] : []), "## " + EVIDENCE_HEADING, item, "");
  return lines.join("\n");
}

/** An Action Item's text as a title and a detail line: split at the first " — " outside a [[link]]; links shown as their text. */
export function stepParts(text: string): { title: string; detail: string } {
  const plain = text.replace(WIKILINK_FULL, (_, target: string, _heading, alias: string) => alias || target.trim());
  const i = plain.indexOf(" — ");
  return i > 0 ? { title: plain.slice(0, i).trim(), detail: plain.slice(i + 3).trim() } : { title: plain.trim(), detail: "" };
}

/** A [[link]] as written: the target LM resolves (text before | or #), plus where it sits. */
export interface WikiLink { target: string; from: number; to: number; alias?: string; heading?: string }
const WIKILINK_FULL = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

export function wikilinks(text: string): WikiLink[] {
  return [...text.matchAll(WIKILINK_FULL)].map((m) => ({
    target: m[1].trim(), from: m.index!, to: m.index! + m[0].length,
    heading: m[2]?.slice(1) || undefined, alias: m[3] || undefined,
  }));
}

/** Point every [[Old Title…]] at a new title, keeping any #heading and |alias (case-insensitive, like LM). */
export function rewriteWikilinks(body: string, oldTitle: string, newTitle: string): string {
  const escaped = oldTitle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.replace(new RegExp(`\\[\\[\\s*${escaped}\\s*(?=[\\]|#])`, "giu"), `[[${newTitle.trim()}`);
}

export interface Heading { level: number; text: string; line: number }

/** Markdown headings outside code fences, for the outline panel. */
export function outline(body: string): Heading[] {
  const found: Heading[] = [];
  let fence: string | null = null;
  body.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const mark = FENCE.exec(line);
    if (fence) { if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length) fence = null; return; }
    if (mark) { fence = mark[1]; return; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) found.push({ level: h[1].length, text: h[2], line: i });
  });
  return found;
}

/** A starting body for a new note of this type (LM rejects an empty Executive Summary on save). */
export function template(type: NoteType): string {
  const parts = [`## ${HEADINGS.summary}\n`, "---", `## ${HEADINGS.details}\n* `];
  if (ACTION_TYPES.has(type)) parts.push(`## ${HEADINGS.actions}\n- [ ] `);
  return parts.join("\n\n") + "\n";
}

const SUBJECT_BY_TYPE: Partial<Record<NoteType, string>> = { preference: "subject/user" };
const CONCERN_BY_TYPE: Partial<Record<NoteType, string>> = {
  decision: "concern/decision", preference: "concern/preference", bug: "concern/bug",
  knowledge: "concern/knowledge", policy: "concern/workflow",
};

/** The subject/ and concern/ tags LM would infer for this type (cli._infer_tags), when the taxonomy has them. */
export function defaultTags(type: NoteType, taxonomy: string[]): string[] {
  const known = new Set(taxonomy);
  return [SUBJECT_BY_TYPE[type] ?? "subject/project", CONCERN_BY_TYPE[type]].filter((t): t is string => !!t && known.has(t));
}
