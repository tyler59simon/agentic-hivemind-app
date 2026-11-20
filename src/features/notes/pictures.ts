// Where a picture in a page loads from (NS-1B, phase doc section 5). A relative path is resolved against the page's
// folder and served by `hmfile` under the page's grant; web pictures load as they are; anything else (a `file:` URL, a
// Windows path, a path that climbs out of the grant's folder) does not load, and the alt text shows instead.

/** The URL to load `src` from, or null when it must not load. `base` is the grant's URL prefix (ending in `/`), and
 *  `folder` the page's folder relative to the grant's root ("" for its top level). */
export function pictureUrl(src: string | undefined, base: string | undefined, folder: string): string | null {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  if (!base || /^[a-z][a-z0-9+.-]*:/i.test(src) || /^[\\/]/.test(src) || src.includes("\\")) return null;
  let path: string;
  try {
    path = decodeURIComponent(src.replace(/[?#].*$/, ""));
  } catch {
    return null;
  }
  const parts: string[] = folder ? folder.split("/") : [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length) return null;
  return base + parts.map(encodeURIComponent).join("/");
}
