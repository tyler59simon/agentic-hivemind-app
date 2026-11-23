// Tag usage for the unified Tags view (CON-12): Living Memory's registered taxonomy plus folder notebook #tags.
import type { NoteRow } from "../../lib/lm";
import type { TagCount } from "../../lib/noteindex";

export const FACETS = ["subject", "concern", "platform", "technology", "project", "system"] as const;

/** Facets from LM's taxonomy when it reports them, else the built-in list. */
export const facetsOf = (taxonomy?: { facets?: string[] }): string[] =>
  taxonomy?.facets?.length ? taxonomy.facets : [...FACETS];

export interface TagUsage { tag: string; count: number; pageCount: number; known: boolean }

/** Human-readable usage summary for a tag across memory notes and folder notebook pages. */
export function formatTagCounts(t: Pick<TagUsage, "count" | "pageCount">): string {
  const parts: string[] = [];
  if (t.count) parts.push(`${t.count} note${t.count === 1 ? "" : "s"}`);
  if (t.pageCount) parts.push(`${t.pageCount} page${t.pageCount === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "unused";
}

/** Registered tags grouped by facet with memory note + page counts, unregistered memory tags, and page-only #tags. */
export function tagUsage(
  taxonomy: string[],
  notes: Pick<NoteRow, "tags">[],
  facets: readonly string[] = FACETS,
  pageTags: TagCount[] = [],
) {
  const noteCounts = new Map<string, number>();
  for (const n of notes) for (const t of n.tags) noteCounts.set(t, (noteCounts.get(t) ?? 0) + 1);

  const pageByLower = new Map<string, { tag: string; count: number }>();
  for (const pt of pageTags) {
    const key = pt.tag.trim().replace(/^#/, "").toLowerCase();
    if (!key) continue;
    const prev = pageByLower.get(key);
    pageByLower.set(key, { tag: prev?.tag ?? key, count: (prev?.count ?? 0) + pt.count });
  }
  const claimedPages = new Set<string>();
  const takePageCount = (tag: string): number => {
    const key = tag.toLowerCase();
    const hit = pageByLower.get(key);
    if (!hit) return 0;
    claimedPages.add(key);
    return hit.count;
  };

  const known = new Set(taxonomy);
  const byFacet: Record<string, TagUsage[]> = Object.fromEntries(facets.map((f) => [f, []]));
  for (const tag of [...taxonomy].sort()) {
    const facet = tag.split("/")[0];
    (byFacet[facet] ??= []).push({ tag, count: noteCounts.get(tag) ?? 0, pageCount: takePageCount(tag), known: true });
  }
  const unknown = [...noteCounts]
    .filter(([t]) => !known.has(t))
    .map(([tag, count]) => ({ tag, count, pageCount: takePageCount(tag), known: false }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  const pageOnly: TagUsage[] = [...pageByLower.entries()]
    .filter(([key]) => !claimedPages.has(key))
    .map(([, v]) => ({ tag: v.tag, count: 0, pageCount: v.count, known: false }))
    .sort((a, b) => b.pageCount - a.pageCount || a.tag.localeCompare(b.tag));

  return { byFacet, unknown, pageOnly };
}

/** Normalised tags from free text (comma or space separated), and the ones LM would refuse. */
export const PROJECT_TAG_MESSAGE = "Create a project instead of adding project/ tags here";
export const SYSTEM_TAG_MESSAGE = "Create a system instead of adding system/ tags here";

export function parseTags(text: string, facets: readonly string[] = FACETS): { tags: string[]; invalid: string[]; error?: string } {
  const words = text.split(/[,\s]+/).map((w) => w.trim().toLowerCase()).filter(Boolean);
  const isProject = (t: string) => t.split("/")[0] === "project";
  const isSystem = (t: string) => t.split("/")[0] === "system";
  const valid = (t: string) => !isProject(t) && !isSystem(t) && facets.includes(t.split("/")[0]) && /^[a-z]+\/[a-z0-9][a-z0-9._/-]*$/.test(t);
  return {
    tags: [...new Set(words.filter(valid))],
    invalid: words.filter((w) => !valid(w)),
    ...(words.some(isProject) ? { error: PROJECT_TAG_MESSAGE } : words.some(isSystem) ? { error: SYSTEM_TAG_MESSAGE } : {}),
  };
}
