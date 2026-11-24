// Draw.io semicolon-delimited style parser and surgical serializer.
// Preserves key ordering and all unrecognized keys/stencils verbatim on round-trip.

export interface StyleEntry {
  /** Key name (or bare token when `value` is null, e.g. `text`, `ellipse`, `rhombus`). */
  key: string;
  value: string | null;
}

export type DrawioShapeKind =
  | "rect"
  | "rounded"
  | "ellipse"
  | "diamond"
  | "cylinder"
  | "cloud"
  | "hexagon"
  | "swimlane"
  | "text"
  | "image"
  | "group";

export interface ParsedStyle {
  entries: StyleEntry[];
  shape: DrawioShapeKind;
  arcSize: number;
  fillColor: string | null;
  strokeColor: string | null;
  strokeWidth: number;
  dashed: boolean;
  opacity: number;
  fontColor: string | null;
  fontSize: number;
  fontFamily: string | null;
  fontBold: boolean;
  fontItalic: boolean;
  fontUnderline: boolean;
  align: "left" | "center" | "right";
  verticalAlign: "top" | "middle" | "bottom";
  labelBackgroundColor: string | null;
  image: string | null;
  html: boolean;
  endArrow: string;
  startArrow: string;
  edgeStyle: string | null;
  exitX: number | null;
  exitY: number | null;
  entryX: number | null;
  entryY: number | null;
}

/** Split a draw.io style string into entries, keeping `;base64,` or `;utf8,` data URIs intact. */
export function parseStyleEntries(raw: string | null | undefined): StyleEntry[] {
  if (!raw) return [];
  const parts = raw.split(";");
  const merged: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    const prev = merged[merged.length - 1];
    if (prev && /^image=data:image\/[a-z0-9.+-]+$/i.test(prev) && /^(base64|utf8|charset=[^,]+),/i.test(part)) {
      merged[merged.length - 1] = `${prev};${part}`;
    } else {
      merged.push(part);
    }
  }
  return merged.map((token) => {
    const eq = token.indexOf("=");
    if (eq < 0) return { key: token.trim(), value: null };
    return { key: token.slice(0, eq).trim(), value: token.slice(eq + 1) };
  });
}

/** Serialize entries back into a draw.io style string (preserving trailing semicolon). */
export function serializeStyleEntries(entries: StyleEntry[]): string {
  if (!entries.length) return "";
  return `${entries.map((e) => (e.value === null ? e.key : `${e.key}=${e.value}`)).join(";")};`;
}

/** Update or remove one style key while keeping all other keys in their original positions. */
export function updateStyle(raw: string, patch: Record<string, string | null | undefined>): string {
  const entries = parseStyleEntries(raw);
  for (const [key, val] of Object.entries(patch)) {
    const idx = entries.findIndex((e) => e.key === key);
    if (val === undefined) continue;
    if (val === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { key, value: val };
    } else {
      entries.push({ key, value: val });
    }
  }
  return serializeStyleEntries(entries);
}

/** Allow only safe inline `data:image/...` URIs; rejects external URLs and scriptable schemes. */
export function safeImageUri(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const m = /^data:image\/(svg\+xml|png|jpeg|jpg|gif|webp)(;base64|;utf8)?,([\s\S]+)$/i.exec(trimmed);
  if (!m) return null;
  const mime = m[1].toLowerCase() === "jpg" ? "jpeg" : m[1].toLowerCase();
  const encoding = m[2]?.toLowerCase() ?? "";
  const payload = m[3];
  if (encoding === ";base64") return `data:image/${mime};base64,${payload}`;
  // Draw.io often writes `data:image/svg+xml,PHN2Zy...` (base64 without `;base64`) or percent-encoded XML `%3Csvg...`.
  if (mime === "svg+xml" && !payload.startsWith("%") && !payload.startsWith("<") && /^[A-Za-z0-9+/=]+$/.test(payload)) {
    return `data:image/svg+xml;base64,${payload}`;
  }
  return `data:image/${mime}${encoding},${payload}`;
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const optNum = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const color = (v: string | undefined): string | null => {
  if (!v || v === "none" || v === "default") return v === "none" ? "none" : null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^[a-z]{3,20}$/i.test(v)) return v;
  return null;
};

/** Parse draw.io style string into structured visual properties. */
export function parseStyle(raw: string | null | undefined): ParsedStyle {
  const entries = parseStyleEntries(raw);
  const map = new Map<string, string>();
  const flags = new Set<string>();
  for (const e of entries) {
    if (e.value === null) flags.add(e.key);
    else map.set(e.key, e.value);
  }
  const shapeAttr = (map.get("shape") ?? "").toLowerCase();
  let shape: DrawioShapeKind = "rect";
  if (flags.has("group")) shape = "group";
  else if (flags.has("text") || shapeAttr === "text") shape = "text";
  else if (shapeAttr === "image" || flags.has("image") || map.has("image")) shape = "image";
  else if (flags.has("ellipse") || shapeAttr === "ellipse") shape = "ellipse";
  else if (flags.has("rhombus") || shapeAttr === "rhombus") shape = "diamond";
  else if (shapeAttr === "cylinder" || shapeAttr === "cylinder3") shape = "cylinder";
  else if (shapeAttr === "cloud" || flags.has("cloud")) shape = "cloud";
  else if (shapeAttr === "hexagon" || flags.has("hexagon")) shape = "hexagon";
  else if (flags.has("swimlane") || shapeAttr === "swimlane") shape = "swimlane";
  else if (map.get("rounded") === "1") shape = "rounded";

  const fontStyle = num(map.get("fontStyle"), 0);
  const alignRaw = map.get("align");
  const vAlignRaw = map.get("verticalAlign");

  return {
    entries,
    shape,
    arcSize: Math.min(50, Math.max(0, num(map.get("arcSize"), 12))),
    fillColor: color(map.get("fillColor")),
    strokeColor: color(map.get("strokeColor")),
    strokeWidth: Math.max(0, num(map.get("strokeWidth"), 1.5)),
    dashed: map.get("dashed") === "1",
    opacity: Math.min(100, Math.max(0, num(map.get("opacity"), 100))) / 100,
    fontColor: color(map.get("fontColor")),
    fontSize: Math.max(8, Math.min(72, num(map.get("fontSize"), 12))),
    fontFamily: map.get("fontFamily") ?? null,
    fontBold: (fontStyle & 1) !== 0,
    fontItalic: (fontStyle & 2) !== 0,
    fontUnderline: (fontStyle & 4) !== 0,
    align: alignRaw === "left" || alignRaw === "right" ? alignRaw : "center",
    verticalAlign: vAlignRaw === "top" || vAlignRaw === "bottom" ? vAlignRaw : "middle",
    labelBackgroundColor: color(map.get("labelBackgroundColor")),
    image: safeImageUri(map.get("image")),
    html: map.get("html") === "1",
    endArrow: map.get("endArrow") ?? "classic",
    startArrow: map.get("startArrow") ?? "none",
    edgeStyle: map.get("edgeStyle") ?? null,
    exitX: optNum(map.get("exitX")),
    exitY: optNum(map.get("exitY")),
    entryX: optNum(map.get("entryX")),
    entryY: optNum(map.get("entryY")),
  };
}
