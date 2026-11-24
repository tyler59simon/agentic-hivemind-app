// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { labelToPlainText, sanitizeDrawioLabel } from "./label";
import { absoluteRects, addEdge, addPage, addShape, deleteCells, moveCells, resizeCell, setCellStyle } from "./model";
import { NEW_DRAWIO_TEXT } from "./starter";
import { parseStyle, safeImageUri, updateStyle } from "./style";
import { deflateDiagramPayload, inflateDiagramPayload, parseDrawio, writeDrawio } from "./xml";

const ARCHITECTURE_SAMPLE = `<mxfile host="Architecture Suite" version="2.0"><diagram id="architecture" name="AWS deployment"><mxGraphModel page="1" pageWidth="1760" pageHeight="881"><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="n0" value="" style="rounded=1;fillColor=#f8f9fa;strokeColor=#5f6368;dashed=1;customFlag=yes;" vertex="1" parent="1" customAttr="keepme"><mxGeometry as="geometry" x="72" y="130" width="400" height="300" /></mxCell><mxCell id="n1" value="Worker" style="rounded=1;fillColor=#edf6ff;strokeColor=#438dd5;" vertex="1" parent="n0"><mxGeometry as="geometry" x="28" y="52" width="160" height="80" /></mxCell><mxCell id="n1-icon" value="" style="shape=image;imageAspect=1;image=data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E;" vertex="1" parent="n1"><mxGeometry as="geometry" x="60" y="10" width="40" height="40" /></mxCell><mxCell id="e0" edge="1" parent="1" source="n1" target="n0" style="endArrow=block;strokeColor=#526580;"><mxGeometry as="geometry" relative="1" /></mxCell></root></mxGraphModel></diagram></mxfile>`;

describe("Draw.io style and label safety", () => {
  it("parses and updates styles while keeping unknown keys and data:image;base64 URIs intact", () => {
    const raw = "shape=image;imageAspect=1;image=data:image/svg+xml;base64,PHN2Zy8+Cg==;customKey=42;";
    const st = parseStyle(raw);
    expect(st.shape).toBe("image");
    expect(st.image).toBe("data:image/svg+xml;base64,PHN2Zy8+Cg==");
    const updated = updateStyle(raw, { strokeColor: "#112233" });
    expect(updated).toContain("customKey=42");
    expect(updated).toContain("strokeColor=#112233");
    expect(updated).toContain("image=data:image/svg+xml;base64,PHN2Zy8+Cg==");
  });

  it("rejects external HTTP and javascript image URIs", () => {
    expect(safeImageUri("https://evil.example/x.png")).toBeNull();
    expect(safeImageUri("javascript:alert(1)")).toBeNull();
    expect(safeImageUri("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeImageUri("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    // Draw.io base64 shorthand without `;base64`
    expect(safeImageUri("data:image/svg+xml,PHN2Zy8+")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
  });

  it("sanitizes html=1 labels against XSS while keeping safe formatting", () => {
    const dirty = '<b>Title</b><br><script>alert(1)</script><iframe src="x"></iframe><span style="color:#ff0000;background:url(http://bad)" onclick="evil()">Sub</span>';
    const clean = sanitizeDrawioLabel(dirty, true);
    expect(clean).toContain("<b>Title</b>");
    expect(clean).toContain("<br />");
    expect(clean).toContain('style="color:#ff0000"');
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("<iframe");
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("url(");
    expect(labelToPlainText("Line 1<br>Line 2", true)).toBe("Line 1\nLine 2");
  });
});

describe("Draw.io XML round-trip and model mutations", () => {
  it("parses nested Architecture Suite XML, resolves absolute coords, and preserves unknown attrs/styles on save", () => {
    const parsed = parseDrawio(ARCHITECTURE_SAMPLE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rects = absoluteRects(parsed.doc.pages[0].cells);
    expect(rects.get("n0")).toEqual({ x: 72, y: 130, width: 400, height: 300 });
    expect(rects.get("n1")).toEqual({ x: 100, y: 182, width: 160, height: 80 });
    expect(rects.get("n1-icon")).toEqual({ x: 160, y: 192, width: 40, height: 40 });

    const moved = moveCells(parsed.doc, 0, new Set(["n0"]), 20, 10);
    const outXml = writeDrawio(moved);
    expect(outXml).toContain('customAttr="keepme"');
    expect(outXml).toContain("customFlag=yes");

    const reparsed = parseDrawio(outXml);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    const afterRects = absoluteRects(reparsed.doc.pages[0].cells);
    // Moving container n0 shifts both n0 and its nested children automatically.
    expect(afterRects.get("n0")).toEqual({ x: 92, y: 140, width: 400, height: 300 });
    expect(afterRects.get("n1")).toEqual({ x: 120, y: 192, width: 160, height: 80 });
    expect(afterRects.get("n1-icon")).toEqual({ x: 180, y: 202, width: 40, height: 40 });
  });

  it("round-trips deflate-compressed draw.io pages cleanly", () => {
    const inner = '<mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="a" value="Hello" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry" /></mxCell></root></mxGraphModel>';
    const compressedPayload = deflateDiagramPayload(inner);
    expect(inflateDiagramPayload(compressedPayload)).toBe(inner);

    const xml = `<mxfile host="app.diagrams.net"><diagram id="d1" name="Main">${compressedPayload}</diagram></mxfile>`;
    const parsed = parseDrawio(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.doc.pages[0].compressed).toBe(true);
    expect(parsed.doc.pages[0].cells.find((c) => c.id === "a")?.value).toBe("Hello");

    const rewritten = writeDrawio(parsed.doc);
    // Still compressed on save
    expect(rewritten).not.toContain("<mxGraphModel>");
    const second = parseDrawio(rewritten);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.doc.pages[0].cells.find((c) => c.id === "a")?.value).toBe("Hello");
    // Bomb guard rejects payloads exceeding the configured byte cap
    expect(() => inflateDiagramPayload(compressedPayload, 32)).toThrow(/safety limit/i);
  });

  it("supports adding shapes, edges, resizing, styling, deleting cascades, and multi-page operations", () => {
    const base = parseDrawio(NEW_DRAWIO_TEXT);
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const s1 = addShape(base.doc, 0, "rounded", { x: 100, y: 100 });
    const s2 = addShape(s1.doc, 0, "cylinder", { x: 400, y: 100 });
    const linked = addEdge(s2.doc, 0, s1.id, s2.id);
    const resized = resizeCell(linked.doc, 0, s1.id, "se", 32, 16);
    const styled = setCellStyle(resized, 0, new Set([s1.id]), { fillColor: "#ffffff" });
    const withPage = addPage(styled, "Details");
    expect(withPage.doc.pages).toHaveLength(2);
    expect(withPage.doc.pages[1].name).toBe("Details");

    // Deleting s1 also removes its attached edge
    const afterDel = deleteCells(withPage.doc, 0, new Set([s1.id]));
    expect(afterDel.pages[0].cells.some((c) => c.id === s1.id)).toBe(false);
    expect(afterDel.pages[0].cells.some((c) => c.id === linked.id)).toBe(false);
    expect(afterDel.pages[0].cells.some((c) => c.id === s2.id)).toBe(true);
  });

  it("preserves unmapped mxGeometry children (offset, alternateBounds) and extra attributes across edits", () => {
    const xml = `<mxfile host="app.diagrams.net"><diagram id="d1" name="Page-1"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="g1" value="Group" vertex="1" parent="1"><mxGeometry x="10" y="20" width="200" height="120" as="geometry" customGeo="1"><mxRectangle x="10" y="20" width="80" height="30" as="alternateBounds" /></mxGeometry></mxCell><mxCell id="e1" value="Edge" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="12" y="-8" as="offset" /></mxGeometry></mxCell></root></mxGraphModel></diagram></mxfile>`;
    const parsed = parseDrawio(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const moved = moveCells(parsed.doc, 0, new Set(["g1"]), 16, 8);
    const out = writeDrawio(moved);
    expect(out).toContain('as="alternateBounds"');
    expect(out).toContain('as="offset"');
    expect(out).toContain('customGeo="1"');
  });

  it("rejects malformed XML cleanly without throwing", () => {
    expect(parseDrawio("<mxfile><broken").ok).toBe(false);
    expect(parseDrawio("<notmx/>").ok).toBe(false);
  });
});
