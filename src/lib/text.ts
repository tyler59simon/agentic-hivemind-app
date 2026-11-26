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

/** "today", "yesterday", "N days ago", then the date; for an ISO date or a time in milliseconds. */
export function ago(when: string | number, now = Date.now()): string {
  const at = typeof when === "number" ? when : new Date(when).getTime();
  const days = Math.floor((now - at) / 86_400_000);
  if (Number.isNaN(days)) return typeof when === "string" ? shortDate(when) : "";
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return days < 60 ? `${days} days ago` : typeof when === "string" ? shortDate(when) : new Date(at).toISOString().slice(0, 10);
}

/** The lines of `after` against `before` as a unified diff body for DiffView: removed lines start with -, added ones with +, and
 *  the unchanged line on each side of the changed stretch with a space. Empty when the texts are the same. Texts too long to
 *  compare line by line are shown whole, removed then added. */
export function lineDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n"), b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x = a.slice(start, endA), y = b.slice(start, endB);
  const out: string[] = start > 0 ? [` ${a[start - 1]}`] : [];
  const width = y.length + 1;
  if (x.length * y.length > 4_000_000) out.push(...x.map((l) => `-${l}`), ...y.map((l) => `+${l}`));
  else {
    // The longest common subsequence of the changed stretch, from the end.
    const common = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) {
      for (let j = y.length - 1; j >= 0; j--) {
        common[i * width + j] = x[i] === y[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { out.push(` ${x[i]}`); i++; j++; }
      else if (i < x.length && (j >= y.length || common[(i + 1) * width + j] >= common[i * width + j + 1])) { out.push(`-${x[i]}`); i++; }
      else { out.push(`+${y[j]}`); j++; }
    }
  }
  if (endA < a.length) out.push(` ${a[endA]}`);
  return out.join("\n");
}
