// Surgical Draw.io (<mxfile>) XML parser and serializer with raw-deflate support and bomb guard.
import { deflateSync, Inflate } from "fflate";
import type { DrawioCell, DrawioDoc, DrawioGeometry, DrawioPage, DrawioPoint } from "./model";

/** Maximum inflated diagram XML size (16 MB) to guard against deflate bombs. */
export const MAX_INFLATED = 16 * 1024 * 1024;

export type ParsedDrawio = { ok: true; doc: DrawioDoc } | { ok: false; reason: string };

const KNOWN_CELL_ATTRS = new Set(["id", "parent", "value", "style", "vertex", "edge", "source", "target"]);
const KNOWN_DIAGRAM_ATTRS = new Set(["id", "name"]);
const KNOWN_GEOMETRY_ATTRS = new Set(["x", "y", "width", "height", "relative", "as"]);

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attrsToRecord(el: Element, exclude?: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of [...el.attributes]) {
    if (!exclude?.has(attr.name)) out[attr.name] = attr.value;
  }
  return out;
}

function formatAttrs(attrs: Record<string, string>): string {
  const parts = Object.entries(attrs).map(([k, v]) => `${k}="${escapeXml(v)}"`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Inflate a standard compressed draw.io `<diagram>` payload with a streaming bomb guard. */
export function inflateDiagramPayload(payload: string, maxBytes = MAX_INFLATED): string {
  const raw = base64ToBytes(payload);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  const inflator = new Inflate((chunk) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      overflow = true;
      return;
    }
    chunks.push(chunk);
  });
  const sliceSize = 8192;
  for (let i = 0; i < raw.length; i += sliceSize) {
    const end = Math.min(i + sliceSize, raw.length);
    inflator.push(raw.subarray(i, end), end === raw.length);
    if (overflow) throw new Error("Compressed diagram exceeds the 16 MB safety limit");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(out);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Compress an `<mxGraphModel>` XML string into standard draw.io base64 + raw-deflate + URI-encoded form. */
export function deflateDiagramPayload(xml: string): string {
  const encoded = encodeURIComponent(xml);
  const bytes = new TextEncoder().encode(encoded);
  const deflated = deflateSync(bytes, { level: 6 });
  return bytesToBase64(deflated);
}

function parsePoint(el: Element): DrawioPoint {
  return { x: Number(el.getAttribute("x") ?? 0) || 0, y: Number(el.getAttribute("y") ?? 0) || 0 };
}

function parseGeometry(el: Element): DrawioGeometry {
  const serializer = new XMLSerializer();
  const extraAttrs = attrsToRecord(el, KNOWN_GEOMETRY_ATTRS);
  const geo: DrawioGeometry = {
    x: Number(el.getAttribute("x") ?? 0) || 0,
    y: Number(el.getAttribute("y") ?? 0) || 0,
    width: Number(el.getAttribute("width") ?? 0) || 0,
    height: Number(el.getAttribute("height") ?? 0) || 0,
    relative: el.getAttribute("relative") === "1" ? true : undefined,
    ...(Object.keys(extraAttrs).length ? { extraAttrs } : {}),
  };
  const extraChildren: string[] = [];
  for (const child of [...el.children]) {
    const tag = child.localName;
    if (tag === "mxPoint") {
      const role = child.getAttribute("as");
      if (role === "sourcePoint") { geo.sourcePoint = parsePoint(child); continue; }
      if (role === "targetPoint") { geo.targetPoint = parsePoint(child); continue; }
    } else if (tag === "Array" && child.getAttribute("as") === "points") {
      const pts = [...child.children].filter((c) => c.localName === "mxPoint").map(parsePoint);
      if (pts.length) { geo.points = pts; continue; }
    }
    extraChildren.push(serializer.serializeToString(child));
  }
  if (extraChildren.length) geo.extraChildrenXml = extraChildren.join("");
  return geo;
}

function parseCell(el: Element, wrapper?: Element): DrawioCell {
  const serializer = new XMLSerializer();
  let geometry: DrawioGeometry | undefined;
  const extraChildren: string[] = [];
  for (const child of [...el.children]) {
    if (child.localName === "mxGeometry" && !geometry) geometry = parseGeometry(child);
    else extraChildren.push(serializer.serializeToString(child));
  }
  const extraAttrs = attrsToRecord(el, KNOWN_CELL_ATTRS);
  const id = wrapper?.getAttribute("id") ?? el.getAttribute("id") ?? "";
  const value = wrapper?.getAttribute("label") ?? el.getAttribute("value") ?? "";
  if (wrapper) {
    extraAttrs["__wrapperTag"] = wrapper.localName;
    for (const a of [...wrapper.attributes]) {
      if (a.name !== "id" && a.name !== "label") extraAttrs[`__wrap:${a.name}`] = a.value;
    }
  }
  return {
    id,
    parent: el.getAttribute("parent") ?? "",
    value,
    style: el.getAttribute("style") ?? "",
    vertex: el.getAttribute("vertex") === "1",
    edge: el.getAttribute("edge") === "1",
    source: el.getAttribute("source") ?? undefined,
    target: el.getAttribute("target") ?? undefined,
    geometry,
    extraAttrs,
    ...(extraChildren.length ? { extraChildrenXml: extraChildren.join("") } : {}),
  };
}

function parseGraphModel(modelEl: Element, diagramEl: Element, compressed: boolean, index: number): DrawioPage {
  const root = [...modelEl.children].find((c) => c.localName === "root");
  const cells: DrawioCell[] = [];
  if (root) {
    for (const child of [...root.children]) {
      if (child.localName === "mxCell") {
        cells.push(parseCell(child));
      } else if (child.localName === "object" || child.localName === "UserObject") {
        const inner = [...child.children].find((c) => c.localName === "mxCell");
        if (inner) cells.push(parseCell(inner, child));
      }
    }
  }
  if (!cells.some((c) => c.id === "0")) cells.unshift({ id: "0", parent: "", value: "", style: "", vertex: false, edge: false, extraAttrs: {} });
  if (!cells.some((c) => c.id === "1")) cells.splice(1, 0, { id: "1", parent: "0", value: "", style: "", vertex: false, edge: false, extraAttrs: {} });
  return {
    id: diagramEl.getAttribute("id") ?? `page-${index + 1}`,
    name: diagramEl.getAttribute("name") ?? `Page-${index + 1}`,
    compressed,
    diagramAttrs: attrsToRecord(diagramEl, KNOWN_DIAGRAM_ATTRS),
    modelAttrs: attrsToRecord(modelEl),
    cells,
  };
}

/** Parse a `.drawio` / `.dio` XML string into a structured `DrawioDoc`. */
export function parseDrawio(text: string): ParsedDrawio {
  if (!text.trim()) return { ok: false, reason: "The Draw.io file is empty" };
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, "application/xml");
  const err = xmlDoc.querySelector("parsererror");
  if (err) {
    return { ok: false, reason: `Malformed XML: ${(err.textContent ?? "parse error").replace(/\s+/g, " ").trim().slice(0, 200)}` };
  }
  const root = xmlDoc.documentElement;
  if (!root) return { ok: false, reason: "No root XML element found" };

  // Support bare `<mxGraphModel>` files as a single-page diagram as well as `<mxfile>`.
  if (root.localName === "mxGraphModel") {
    const dummy = xmlDoc.createElement("diagram");
    return { ok: true, doc: { fileAttrs: { host: "Hivemind" }, pages: [parseGraphModel(root, dummy, false, 0)] } };
  }
  if (root.localName !== "mxfile") {
    return { ok: false, reason: `Expected <mxfile> root element, found <${root.localName}>` };
  }

  const diagrams = [...root.children].filter((c) => c.localName === "diagram");
  if (!diagrams.length) return { ok: false, reason: "<mxfile> has no <diagram> pages" };

  const pages: DrawioPage[] = [];
  for (let i = 0; i < diagrams.length; i++) {
    const diag = diagrams[i];
    const directModel = [...diag.children].find((c) => c.localName === "mxGraphModel");
    if (directModel) {
      pages.push(parseGraphModel(directModel, diag, false, i));
      continue;
    }
    const payload = (diag.textContent ?? "").trim();
    if (!payload) {
      const emptyModel = xmlDoc.createElement("mxGraphModel");
      pages.push(parseGraphModel(emptyModel, diag, false, i));
      continue;
    }
    try {
      const inflatedXml = payload.startsWith("<") ? payload : inflateDiagramPayload(payload);
      const innerDoc = parser.parseFromString(inflatedXml, "application/xml");
      if (innerDoc.querySelector("parsererror")) {
        return { ok: false, reason: `Page "${diag.getAttribute("name") ?? i + 1}" contains malformed diagram XML` };
      }
      const modelEl = innerDoc.documentElement?.localName === "mxGraphModel" ? innerDoc.documentElement : innerDoc.querySelector("mxGraphModel");
      if (!modelEl) return { ok: false, reason: `Page "${diag.getAttribute("name") ?? i + 1}" has no <mxGraphModel>` };
      pages.push(parseGraphModel(modelEl, diag, !payload.startsWith("<"), i));
    } catch (e) {
      return { ok: false, reason: `Could not decode page "${diag.getAttribute("name") ?? i + 1}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  return { ok: true, doc: { fileAttrs: attrsToRecord(root), pages } };
}

/** Return the problem reason if `text` cannot be shown as a Draw.io board, else null. */
export function drawioProblem(text: string): string | null {
  const parsed = parseDrawio(text);
  return parsed.ok ? null : parsed.reason;
}

function serializeGeometry(g: DrawioGeometry): string {
  const attrs: Record<string, string> = {};
  if (!g.relative || g.x) attrs.x = String(g.x);
  if (!g.relative || g.y) attrs.y = String(g.y);
  if (g.width) attrs.width = String(g.width);
  if (g.height) attrs.height = String(g.height);
  if (g.relative) attrs.relative = "1";
  attrs.as = "geometry";
  if (g.extraAttrs) {
    for (const [k, v] of Object.entries(g.extraAttrs)) attrs[k] = v;
  }
  const children: string[] = [];
  if (g.sourcePoint) children.push(`<mxPoint x="${g.sourcePoint.x}" y="${g.sourcePoint.y}" as="sourcePoint" />`);
  if (g.targetPoint) children.push(`<mxPoint x="${g.targetPoint.x}" y="${g.targetPoint.y}" as="targetPoint" />`);
  if (g.points?.length) {
    children.push(`<Array as="points">${g.points.map((p) => `<mxPoint x="${p.x}" y="${p.y}" />`).join("")}</Array>`);
  }
  if (g.extraChildrenXml) children.push(g.extraChildrenXml);
  return children.length ? `<mxGeometry${formatAttrs(attrs)}>${children.join("")}</mxGeometry>` : `<mxGeometry${formatAttrs(attrs)} />`;
}

function serializeCell(cell: DrawioCell): string {
  const wrapTag = cell.extraAttrs["__wrapperTag"];
  const attrs: Record<string, string> = {};
  if (!wrapTag) attrs.id = cell.id;
  if (!wrapTag && (cell.value || cell.vertex)) attrs.value = cell.value;
  if (cell.style) attrs.style = cell.style;
  if (cell.vertex) attrs.vertex = "1";
  if (cell.edge) attrs.edge = "1";
  if (cell.parent) attrs.parent = cell.parent;
  if (cell.source) attrs.source = cell.source;
  if (cell.target) attrs.target = cell.target;

  const wrapAttrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(cell.extraAttrs)) {
    if (k === "__wrapperTag") continue;
    if (k.startsWith("__wrap:")) wrapAttrs[k.slice(7)] = v;
    else attrs[k] = v;
  }

  const inner = `${cell.geometry ? serializeGeometry(cell.geometry) : ""}${cell.extraChildrenXml ?? ""}`;
  const cellXml = inner ? `<mxCell${formatAttrs(attrs)}>${inner}</mxCell>` : `<mxCell${formatAttrs(attrs)} />`;
  if (!wrapTag) return cellXml;
  const fullWrap: Record<string, string> = { id: cell.id, label: cell.value, ...wrapAttrs };
  return `<${wrapTag}${formatAttrs(fullWrap)}>${cellXml}</${wrapTag}>`;
}

function serializeGraphModel(page: DrawioPage): string {
  const body = page.cells.map(serializeCell).join("");
  return `<mxGraphModel${formatAttrs(page.modelAttrs)}><root>${body}</root></mxGraphModel>`;
}

/** Serialize a `DrawioDoc` back to `.drawio` XML, preserving each page's compression mode and unknown attributes. */
export function writeDrawio(doc: DrawioDoc): string {
  const pagesXml = doc.pages.map((p) => {
    const dAttrs: Record<string, string> = { id: p.id, name: p.name, ...p.diagramAttrs };
    const modelXml = serializeGraphModel(p);
    const content = p.compressed ? deflateDiagramPayload(modelXml) : modelXml;
    return `<diagram${formatAttrs(dAttrs)}>${content}</diagram>`;
  }).join("");
  return `<mxfile${formatAttrs(doc.fileAttrs)}>${pagesXml}</mxfile>`;
}
