// Tag usage for the taxonomy manager. LM validates tags against tag_taxonomy.json; the four facets are fixed.
import type { NoteRow } from "../../lib/lm";

export const FACETS = ["subject", "concern", "platform", "technology"] as const;

export interface TagUsage { tag: string; count: number; known: boolean }

/** Registered tags grouped by facet with how many notes use each, plus tags in use that are not registered. */
export function tagUsage(taxonomy: string[], notes: Pick<NoteRow, "tags">[]) {
  const counts = new Map<string, number>();
  for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const known = new Set(taxonomy);
  const byFacet: Record<string, TagUsage[]> = Object.fromEntries(FACETS.map((f) => [f, []]));
  for (const tag of [...taxonomy].sort()) {
    const facet = tag.split("/")[0];
    (byFacet[facet] ??= []).push({ tag, count: counts.get(tag) ?? 0, known: true });
  }
  const unknown = [...counts].filter(([t]) => !known.has(t)).map(([tag, count]) => ({ tag, count, known: false })).sort((a, b) => b.count - a.count);
  return { byFacet, unknown };
}

/** Normalised tags from free text (comma or space separated), and the ones LM would refuse. */
export function parseTags(text: string): { tags: string[]; invalid: string[] } {
  const words = text.split(/[,\s]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
  const valid = (t: string) => (FACETS as readonly string[]).includes(t.split("/")[0]) && /^[a-z]+\/[a-z0-9][a-z0-9._/-]*$/.test(t);
  return { tags: [...new Set(words.filter(valid))], invalid: words.filter((w) => !valid(w)) };
}
