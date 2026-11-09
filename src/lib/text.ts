// Small text helpers shared by search, the switcher and the palette.

/** Subsequence match score (higher is better), or null when `query` is not a subsequence of `text`. */
export function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  // A contiguous match beats any scattered one; earlier and at a word start is better.
  const exact = t.indexOf(q);
  if (exact >= 0) return 1000 + (exact === 0 || /\W/.test(t[exact - 1]) ? 50 : 0) - exact - t.length * 0.01;
  let score = 0, at = 0, run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, at);
    if (found < 0) return null;
    run = found === at ? run + 1 : 1;
    score += run * 2 + (found === 0 || /\W/.test(t[found - 1]) ? 3 : 0);
    at = found + 1;
  }
  return score - t.length * 0.01;
}

/** Query words worth highlighting (two or more characters). */
export function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 1))];
}

/** Split text into plain and matched parts for highlighting. */
export function highlight(text: string, words: string[]): { text: string; hit: boolean }[] {
  if (!words.length) return [{ text, hit: false }];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(${escaped.join("|")})`, "giu");
  return text.split(pattern).filter(Boolean).map((part) => ({ text: part, hit: words.includes(part.toLowerCase()) }));
}

export const shortDate = (value?: string) => (value ?? "").slice(0, 10);
