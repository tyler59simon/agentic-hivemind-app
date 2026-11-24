// NS-7A: Quick capture's Today and Inbox targets for a folder notebook (Rust appends). Living Memory notebooks were retired by
// CON-18.
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// The capture window module imports Tauri window APIs.
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
const { captureToPage, CAPTURE_HEADING } = await import("./QuickCapture");

const now = new Date(2026, 10, 22, 14, 5);
const form = { title: "Call Ann", summary: "About the plan.", details: "ask for the date" };
let rust: Record<string, (args: Record<string, unknown>) => unknown>;
const sent: { cmd: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  rust = {
    notebooks_list: () => [{ id: "nb-1", title: "Work", path: "C:\\work", added: "" }],
    notebook_meta_get: () => ({ daily: { template: "Templates/Daily" } }),
    obsidian_setting: () => null,
    file_read: () => ({ text: "# {{title}}\n\n## Captured\n", sha256: "s", size: 1, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false }),
    file_create: () => ({ sha256: "s", size: 1, mtimeMs: 1 }),
    notebook_append: () => ({ created: false }),
  };
  sent.length = 0;
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    sent.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    if (!rust[cmd]) throw new Error(`no Rust command ${cmd} in this test`);
    return rust[cmd]((args ?? {}) as Record<string, unknown>);
  });
});

describe("capturing to a folder notebook", () => {
  it("adds a line under ## Captured on today's page, made from the template first", async () => {
    const path = await captureToPage("today", "nb-1", form, now);
    expect(path).toBe("Daily/2026-11-22.md");
    expect(sent.map((s) => s.cmd).filter((c) => c === "file_create" || c === "notebook_append")).toEqual(["file_create", "notebook_append"]);
    expect(sent.find((s) => s.cmd === "file_create")?.args.text).toBe("# 2026-11-22\n\n## Captured\n");
    expect(sent.find((s) => s.cmd === "notebook_append")?.args).toEqual({
      notebook: "nb-1", path: "Daily/2026-11-22.md", heading: CAPTURE_HEADING, text: "- 14:05 Call Ann: About the plan.\n  - ask for the date",
    });
  });

  it("does not make today's page again when it is there", async () => {
    rust.file_create = () => { throw new Error("Daily/2026-11-22.md already exists"); };
    expect(await captureToPage("today", "nb-1", form, now)).toBe("Daily/2026-11-22.md");
    expect(sent.some((s) => s.cmd === "notebook_append")).toBe(true);
  });

  it("adds a dated line to the end of the inbox page, which is the notebook's setting", async () => {
    rust.notebook_meta_get = () => ({ inbox: "Box/In.md" });
    expect(await captureToPage("inbox", "nb-1", { title: "", summary: "Buy milk", details: "" }, now)).toBe("Box/In.md");
    expect(sent.some((s) => s.cmd === "file_create")).toBe(false);
    expect(sent.find((s) => s.cmd === "notebook_append")?.args).toEqual({ notebook: "nb-1", path: "Box/In.md", heading: null, text: "- 2026-11-22 14:05 Buy milk" });
  });

  it("passes on a refusal", async () => {
    rust.notebook_append = () => { throw new Error("Day.md kept changing while the line was added"); };
    await expect(captureToPage("inbox", "nb-1", form, now)).rejects.toThrow(/kept changing/);
  });
});

describe("a target saved for a retired Living Memory notebook (CON-18)", () => {
  it("is not sent anywhere: hosted notebooks are gone, so captureToPage asks Rust, which refuses an unknown notebook", async () => {
    rust.notebooks_list = () => [];
    rust.notebook_meta_get = () => { throw new Error("no notebook lm:demo:daily"); };
    rust.file_create = () => { throw new Error("no notebook lm:demo:daily"); };
    rust.notebook_append = () => { throw new Error("no notebook lm:demo:daily"); };
    await expect(captureToPage("today", "lm:demo:daily", form, now)).rejects.toThrow(/no notebook/);
    expect(sent.some((s) => s.cmd === "lm" || s.cmd === "lm_body")).toBe(false);
  });
});
