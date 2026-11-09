import { describe, expect, it, vi } from "vitest";

// The capture window module imports Tauri window APIs; only the pure body builder is tested here.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
const { captureBody } = await import("./QuickCapture");
const { sections, split } = await import("../../lib/note");

describe("quick capture body", () => {
  it("is a summary plus details as bullets, in LM's layout", () => {
    const body = captureBody("  Summary line. ", "first\n- already a bullet\n\n  second ");
    expect(body).toBe("## 📌 Executive Summary\nSummary line.\n\n---\n\n## 📝 Key Details\n* first\n- already a bullet\n* second");
    expect(sections(body)).toEqual({ summary: "Summary line.", details: "* first\n- already a bullet\n* second" });
  });

  it("leaves Key Details out when there are none", () => {
    expect(split(captureBody("Only a summary.", "  \n")).map((p) => p.key)).toEqual(["preamble", "summary"]);
  });
});
