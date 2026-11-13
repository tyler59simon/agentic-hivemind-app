import { describe, expect, it, vi } from "vitest";

// The capture window module imports Tauri window APIs; only the pure body builder is tested here.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
const { captureBody } = await import("./QuickCapture");
const { sections, split } = await import("../../lib/note");

describe("quick capture body", () => {
  it("is a summary plus details as bullets, in LM's layout", () => {
    const body = captureBody("  Summary line. ", "first\n- already a bullet\n\n  second ");
    expect(body).toBe("Summary line.\n\n## Details\n- first\n- already a bullet\n- second");
    expect(sections(body)).toEqual({ summary: "Summary line.", details: "- first\n- already a bullet\n- second" });
  });

  it("leaves Details out when there are none", () => {
    expect(captureBody("Only a summary.", "  \n")).toBe("Only a summary.");
    expect(split(captureBody("Only a summary.", "  \n")).map((p) => p.key)).toEqual(["preamble"]);
  });
});
