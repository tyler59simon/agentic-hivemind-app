// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { inspectSvg, NEW_SVG_TEXT, svgToDataUrl } from "./svg";

describe("SVG inspection and safe encoding", () => {
  it("extracts dimensions from width/height or viewBox", () => {
    expect(inspectSvg(NEW_SVG_TEXT)).toEqual({ ok: true, width: 240, height: 120, viewBox: "0 0 240 120" });
    expect(inspectSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><rect width="80" height="40"/></svg>'))
      .toEqual({ ok: true, width: 80, height: 40, viewBox: "0 0 80 40" });
  });

  it("reports empty, malformed, and non-svg XML", () => {
    expect(inspectSvg("   ").ok).toBe(false);
    expect(inspectSvg("<svg><rect></svg>").ok).toBe(false);
    const nonSvg = inspectSvg("<html><body/></html>");
    expect(nonSvg.ok).toBe(false);
    if (!nonSvg.ok) expect(nonSvg.error).toContain("<svg>");
  });

  it("encodes Unicode SVG as a base64 data URI for isolated <img> rendering", () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg"><text>Café ✓</text></svg>';
    const url = svgToDataUrl(src);
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(url.slice("data:image/svg+xml;base64,".length)), (c) => c.charCodeAt(0)));
    expect(decoded).toBe(src);
  });
});
