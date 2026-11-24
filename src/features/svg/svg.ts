// Pure SVG inspection and safe data-URI helpers (no DOM mounting of untrusted SVG).

export type SvgInfo =
  | { ok: true; width: number | null; height: number | null; viewBox: string | null }
  | { ok: false; error: string };

export const NEW_SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120" width="240" height="120">
  <rect x="16" y="16" width="208" height="88" rx="12" fill="#edf6ff" stroke="#438dd5" stroke-width="2" />
  <text x="120" y="66" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#1f2937">New SVG</text>
</svg>
`;

/** Parse a CSS/SVG length attribute such as "240", "240px", or "120.5" into a positive number, else null. */
function parseLength(raw: string | null): number | null {
  if (!raw) return null;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(?:px)?\s*$/i.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse `viewBox="minX minY width height"` into `[width, height]`, or null. */
function viewBoxSize(viewBox: string | null): [number, number] | null {
  if (!viewBox) return null;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [, , w, h] = parts;
  return w > 0 && h > 0 ? [w, h] : null;
}

/** Inspect SVG XML text in an inert parser without attaching it to the live DOM. */
export function inspectSvg(text: string): SvgInfo {
  if (!text.trim()) return { ok: false, error: "SVG file is empty." };
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const err = parsed.querySelector("parsererror");
  if (err) {
    const msg = (err.textContent ?? "Invalid SVG XML").replace(/\s+/g, " ").trim();
    return { ok: false, error: msg.slice(0, 240) };
  }
  const root = parsed.documentElement;
  if (!root || root.localName.toLowerCase() !== "svg") {
    return { ok: false, error: `Expected an <svg> root element, found <${root?.localName ?? "none"}>.` };
  }
  const viewBox = root.getAttribute("viewBox");
  const vb = viewBoxSize(viewBox);
  const width = parseLength(root.getAttribute("width")) ?? vb?.[0] ?? null;
  const height = parseLength(root.getAttribute("height")) ?? vb?.[1] ?? null;
  return { ok: true, width, height, viewBox };
}

/** Encode SVG text as a base64 `data:image/svg+xml` URL safe for `<img>` (disables scripts and external fetches). */
export function svgToDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Rasterize an SVG string to a PNG Blob via an isolated `<img>` and offscreen `<canvas>`. */
export async function rasterizeSvgToPng(text: string, scale = 2): Promise<Blob> {
  const info = inspectSvg(text);
  const img = new Image();
  const url = svgToDataUrl(text);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not render SVG for PNG export"));
    img.src = url;
  });
  const w = Math.max(1, Math.round(((info.ok && info.width) || img.naturalWidth || 400) * scale));
  const h = Math.max(1, Math.round(((info.ok && info.height) || img.naturalHeight || 300) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode PNG"))), "image/png");
  });
}
