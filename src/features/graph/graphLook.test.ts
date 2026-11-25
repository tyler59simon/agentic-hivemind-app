import { describe, expect, it } from "vitest";
import { cameraSettings, graphColors } from "./graphLook";

const tokens: Record<string, string> = { "--fg": "#eee", "--muted": "#999", "--border": "#333", "--accent": "#0a0" };
const token = (name: string) => tokens[name];

describe("graphColors (DESK-A11Y A4)", () => {
  it("reads the theme's tokens and leaves every node its own colour when no contrast theme is on", () => {
    expect(graphColors(null, token)).toEqual({ fg: "#eee", muted: "#999", border: "#333", accent: "#0a0", node: null, focus: null });
  });

  it("uses the system colours of a contrast theme: text for nodes and labels, grey for what is dimmed, Highlight for the focus and the hovered edges", () => {
    const palette = { canvas: "rgb(0, 0, 0)", text: "rgb(255, 255, 255)", highlight: "rgb(26, 235, 255)", highlightText: "rgb(0, 0, 0)", gray: "rgb(63, 242, 63)" };
    expect(graphColors(palette, token)).toEqual({
      fg: "rgb(255, 255, 255)", muted: "rgb(63, 242, 63)", border: "rgb(63, 242, 63)", accent: "rgb(26, 235, 255)", node: "rgb(255, 255, 255)", focus: "rgb(26, 235, 255)",
    });
  });
});

describe("cameraSettings", () => {
  it("ends sigma's wheel, double-click and inertia animations when the user asked for less motion, and leaves its defaults otherwise", () => {
    expect(cameraSettings(true)).toEqual({ inertiaDuration: 0, zoomDuration: 0, doubleClickZoomingDuration: 0 });
    expect(cameraSettings(false)).toEqual({});
  });
});
