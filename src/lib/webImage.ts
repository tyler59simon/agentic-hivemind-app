// Web images are never loaded (REG-30). A note, a page or an agent reply could hold `![](https://host/?d=...)`, and
// loading it would send whatever the URL carries to that host. The CSP leaves web sources out of `img-src`, and the
// renderers show this note in place of the picture.

/** Whether `src` is a web address: `http:`, `https:` or protocol-relative `//host/...`. */
export const isWebUrl = (src: string): boolean => /^\s*(https?:)?\/\//i.test(src);

/** "Web image not shown (host)" for a web address, or null for any other source. */
export function webImageNote(src: string | undefined | null): string | null {
  if (!src || !isWebUrl(src)) return null;
  let host = "";
  try { host = new URL(src.trim(), "https://invalid/").host; } catch { /* no host to name */ }
  return host ? `Web image not shown (${host})` : "Web image not shown";
}
