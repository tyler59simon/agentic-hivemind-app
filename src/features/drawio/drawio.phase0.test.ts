// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { exportPageSvg } from "./DrawioBoard";
import { hasRichHtml, normalizeEditedHtml } from "./label";
import { absoluteRects, edgeLabelPoints, moveCells, pageGridSize, reorderCells } from "./model";
import { parseDrawio } from "./xml";

describe("Phase 0 Draw.io fidelity and data-loss fixes", () => {
  it("detects and sanitizes rich HTML labels without stripping formatting tags", () => {
    expect(hasRichHtml("Plain text<br>Line 2", true)).toBe(false);
    expect(hasRichHtml("<b>Bold</b> <font color=\"#dc2626\">Red</font>", true)).toBe(true);
    expect(hasRichHtml("<b>Bold</b>", false)).toBe(false);
    const clean = normalizeEditedHtml('<b>Title</b> <font color="#dc2626">Alert</font><script>evil()</script><br />');
    expect(clean).toContain("<b>Title</b>");
    expect(clean).toContain('color="#dc2626"');
    expect(clean).not.toContain("script");
    expect(clean.endsWith("<br />")).toBe(false);
  });

  it("exportPageSvg emits real geometries for ellipse, diamond, hexagon, cylinder, cloud, swimlane, startArrow, and edge labels", () => {
    const xml = `<mxfile><diagram id="p1" name="Shapes"><mxGraphModel gridSize="10"><root>
      <mxCell id="0" /><mxCell id="1" parent="0" />
      <mxCell id="e" value="El" style="ellipse;html=1;fontStyle=7;opacity=80;" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="50" as="geometry" /></mxCell>
      <mxCell id="d" value="Di" style="rhombus;html=1;" vertex="1" parent="1"><mxGeometry x="120" y="10" width="80" height="50" as="geometry" /></mxCell>
      <mxCell id="h" value="Hx" style="shape=hexagon;html=1;" vertex="1" parent="1"><mxGeometry x="220" y="10" width="80" height="50" as="geometry" /></mxCell>
      <mxCell id="c" value="Cy" style="shape=cylinder3;html=1;" vertex="1" parent="1"><mxGeometry x="320" y="10" width="80" height="60" as="geometry" /></mxCell>
      <mxCell id="cl" value="Cl" style="shape=cloud;html=1;" vertex="1" parent="1"><mxGeometry x="420" y="10" width="100" height="60" as="geometry" /></mxCell>
      <mxCell id="sw" value="Lane" style="swimlane;html=1;verticalAlign=top;" vertex="1" parent="1"><mxGeometry x="10" y="100" width="200" height="120" as="geometry" /></mxCell>
      <mxCell id="edge1" value="inline-lbl" style="startArrow=classic;endArrow=block;strokeColor=#1a73e8;" edge="1" parent="1" source="e" target="d"><mxGeometry relative="1" as="geometry" /></mxCell>
      <mxCell id="elbl1" value="child-lbl" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="edge1"><mxGeometry x="0" y="-12" relative="1" as="geometry" /></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const parsed = parseDrawio(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const page = parsed.doc.pages[0];
    expect(pageGridSize(page)).toBe(10);
    const rects = absoluteRects(page.cells);
    // Edge label child cell must not appear as a stray (0,0) vertex rect.
    expect(rects.has("elbl1")).toBe(false);
    const elPts = edgeLabelPoints(page.cells, rects);
    expect(elPts.has("elbl1")).toBe(true);
    expect(elPts.get("elbl1")!.x).toBeGreaterThan(50);

    const svg = exportPageSvg(page.cells, rects);
    expect(svg).toContain("<ellipse");
    expect(svg).toContain("<polygon"); // diamond, hexagon, and both arrowheads
    expect(svg).toContain("<path"); // cylinder + cloud
    expect(svg).toContain("<line"); // swimlane divider
    expect(svg).toContain('opacity="0.8"');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain('text-decoration="underline"');
    expect(svg).toContain("inline-lbl");
    expect(svg).toContain("child-lbl");
    // Both startArrow and endArrow polygons are emitted for edge1.
    const arrowCount = (svg.match(/<polygon points="[^"]+" fill="#1a73e8"/g) ?? []).length;
    expect(arrowCount).toBe(2);
  });

  it("reorderCells('back') keeps child vertices strictly after their parent container", () => {
    const xml = `<mxfile><diagram id="p1" name="Nested"><mxGraphModel><root>
      <mxCell id="0" /><mxCell id="1" parent="0" />
      <mxCell id="parent" value="Container" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="300" height="200" as="geometry" /></mxCell>
      <mxCell id="child1" value="C1" style="rounded=1;" vertex="1" parent="parent"><mxGeometry x="20" y="20" width="80" height="40" as="geometry" /></mxCell>
      <mxCell id="child2" value="C2" style="rounded=1;" vertex="1" parent="parent"><mxGeometry x="120" y="20" width="80" height="40" as="geometry" /></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const parsed = parseDrawio(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const next = reorderCells(parsed.doc, 0, new Set(["child2"]), "back");
    const ids = next.pages[0].cells.map((c) => c.id);
    expect(ids.indexOf("parent")).toBeLessThan(ids.indexOf("child2"));
    expect(ids.indexOf("child2")).toBeLessThan(ids.indexOf("child1"));
  });

  it("moveCells snaps moved vertices to the provided gridSize", () => {
    const xml = `<mxfile><diagram id="p1" name="Grid"><mxGraphModel gridSize="10"><root>
      <mxCell id="0" /><mxCell id="1" parent="0" />
      <mxCell id="a" value="A" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="20" y="30" width="100" height="50" as="geometry" /></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const parsed = parseDrawio(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const moved = moveCells(parsed.doc, 0, new Set(["a"]), 14, 7, 10);
    const geom = moved.pages[0].cells.find((c) => c.id === "a")!.geometry!;
    expect(geom.x).toBe(30);
    expect(geom.y).toBe(40);
  });
});
