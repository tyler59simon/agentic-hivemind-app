// @vitest-environment jsdom
// Document text size (DESK-ZOOM): one CSS variable, kept per device.
import { afterEach, describe, expect, it } from "vitest";
import { applyDocSize } from "./docSize";
import { prefs } from "./prefs";

afterEach(() => { localStorage.clear(); applyDocSize(1, false); });

describe("document text size", () => {
  it("sets --doc-size and keeps it", () => {
    applyDocSize(1.25);
    expect(document.documentElement.style.getPropertyValue("--doc-size")).toBe("1.25");
    expect(prefs.docSize()).toBe(1.25);
  });
  it("treats a size that is not offered as Normal", () => {
    applyDocSize(3);
    expect(document.documentElement.style.getPropertyValue("--doc-size")).toBe("1");
    localStorage.setItem("hivemind.documentSize", "nonsense");
    expect(prefs.docSize()).toBe(1);
  });
});
