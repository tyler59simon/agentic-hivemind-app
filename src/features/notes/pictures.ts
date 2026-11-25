// Where a picture in a page loads from (NS-1B, phase doc section 5). A relative path is resolved against the page's
// folder and served by `hmfile` under the page's grant. Anything else does not load and the alt text shows instead: a web
// picture (REG-30, `src/lib/webImage.ts`), a `file:` URL, a Windows path, or a path that climbs out of the grant's folder.

/** The URL to load `src` from, or null when it must not load. `base` is the grant's URL prefix (ending in `/`), and
 *  `folder` the page's folder relative to the grant's root ("" for its top level). */
export function pictureUrl(src: string | undefined, base: string | undefined, folder: string): string | null {
  if (!src) return null;
  if (!base) return null;
  const path = relativeTarget(src, folder);
  return path === null ? null : base + path.split("/").map(encodeURIComponent).join("/");
}

/** The path relative to the grant's root that a relative link or picture `src` in a page in `folder` names, or null
 *  for a web or `file:` URL, a Windows path, or a path that climbs out of the root. */
export function relativeTarget(src: string, folder: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || /^[\\/]/.test(src) || src.includes("\\")) return null;
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
  return parts.length ? parts.join("/") : null;
}

const low = (s: string) => s.toLowerCase();

/** The file `![[name]]` names: the path itself, or else the file of that name in the shallowest folder. */
export function findFile(name: string, files: string[]): string | null {
  const want = low(name.replace(/\\/g, "/").replace(/^\/+/, ""));
  const exact = files.find((f) => low(f) === want);
  if (exact) return exact;
  const hits = files.filter((f) => low(f).endsWith(`/${want}`));
  hits.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return hits[0] ?? null;
}
