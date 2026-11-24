// Safe allowlist sanitizer for Draw.io `html=1` cell labels.
// Strips all scripts, iframes, images, links, and event attributes.

const ALLOWED_TAGS = new Set(["BR", "B", "STRONG", "I", "EM", "U", "SUB", "SUP", "DIV", "P", "SPAN", "FONT"]);
const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))$/i;
const SAFE_ALIGN = /^(left|center|right|justify)$/i;
const SAFE_SIZE = /^\d{1,3}(\.\d+)?(px|pt|em|rem|%)$/i;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeStyle(raw: string | null): string {
  if (!raw) return "";
  const kept: string[] = [];
  for (const decl of raw.split(";")) {
    const idx = decl.indexOf(":");
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!val || /url\(|expression\(|javascript:/i.test(val)) continue;
    if (prop === "color" && SAFE_COLOR.test(val)) kept.push(`color:${val}`);
    else if (prop === "background-color" && SAFE_COLOR.test(val)) kept.push(`background-color:${val}`);
    else if (prop === "text-align" && SAFE_ALIGN.test(val)) kept.push(`text-align:${val}`);
    else if (prop === "font-weight" && /^(bold|normal|[1-9]00)$/i.test(val)) kept.push(`font-weight:${val}`);
    else if (prop === "font-style" && /^(italic|normal)$/i.test(val)) kept.push(`font-style:${val}`);
    else if (prop === "text-decoration" && /^(underline|line-through|none)$/i.test(val)) kept.push(`text-decoration:${val}`);
    else if (prop === "font-size" && SAFE_SIZE.test(val)) kept.push(`font-size:${val}`);
  }
  return kept.join(";");
}

function walk(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toUpperCase();
  if (tag === "SCRIPT" || tag === "STYLE" || tag === "IFRAME" || tag === "OBJECT" || tag === "EMBED" || tag === "SVG") {
    return "";
  }
  const inner = [...el.childNodes].map(walk).join("");
  if (!ALLOWED_TAGS.has(tag)) return inner;
  if (tag === "BR") return "<br />";
  const attrs: string[] = [];
  if (tag === "FONT") {
    const c = el.getAttribute("color");
    if (c && SAFE_COLOR.test(c.trim())) attrs.push(`color="${escapeHtml(c.trim())}"`);
  }
  const style = sanitizeStyle(el.getAttribute("style"));
  if (style) attrs.push(`style="${escapeHtml(style)}"`);
  const low = tag.toLowerCase();
  return `<${low}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${inner}</${low}>`;
}

/** Convert a draw.io cell `value` into safe HTML for display (`html=1` sanitized; plain text escaped with line breaks). */
export function sanitizeDrawioLabel(value: string, html: boolean): string {
  if (!value) return "";
  if (!html) return escapeHtml(value).replace(/\r?\n/g, "<br />");
  const doc = new DOMParser().parseFromString(value, "text/html");
  return [...doc.body.childNodes].map(walk).join("");
}

/** Plain text representation of a cell label for editing or aria labels. */
export function labelToPlainText(value: string, html: boolean): string {
  if (!value) return "";
  if (!html) return value;
  const withNewlines = value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p)>/gi, "\n");
  const doc = new DOMParser().parseFromString(withNewlines, "text/html");
  return (doc.body.textContent ?? "").replace(/\n+$/, "");
}
