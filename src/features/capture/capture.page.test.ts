// NS-7A: Quick capture's Today and Inbox targets, for a folder notebook (Rust appends) and a Living Memory notebook (the
// webview reads, changes and writes the page).
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTransport, type Invoke } from "../../lib/lm";

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
afterEach(() => setTransport(invoke as Invoke));

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

describe("capturing to a Living Memory notebook", () => {
  it("makes today's page from the template and writes the line into it", async () => {
    const pages = new Map<string, string>([["Templates/Daily.md", "# {{title}}\n\n## Captured\n"]]);
    const calls: string[] = [];
    const hex = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
    setTransport(async (_cmd, args) => {
      const argv = args.argv as string[];
      const path = argv[argv.length - 1];
      calls.push(`${argv[1]} ${path}`);
      const ok = (result: unknown) => ({ exit_code: 0, error: null, result });
      if (argv[1] === "notebooks") return ok({ notebooks: [{ domain: "demo", notebook: "daily", title: "Daily", visibility: "searchable", private: false, revision: "r", pages: 0, assets: 0, asset_bytes: 0, proposals: 0, updated: "", settings: { daily: { template: "Templates/Daily" } } }] });
      if (argv[1] === "read") {
        const text = pages.get(path);
        return text === undefined ? { exit_code: 2, result: null, error: { code: "invalid", message: `not_found: no page ${path}` } } : ok({ path, text, revision: await hex(text), size: text.length, updated: "", truncated: false });
      }
      if (argv[1] === "create" || argv[1] === "write") { pages.set(path, args.body as string); return ok({ operation_id: "op", revision: "new" }); }
      throw new Error(`unexpected ${argv.join(" ")}`);
    });
    expect(await captureToPage("today", "lm:demo:daily", form, now)).toBe("Daily/2026-11-22.md");
    expect(pages.get("Daily/2026-11-22.md")).toBe("# 2026-11-22\n\n## Captured\n\n- 14:05 Call Ann: About the plan.\n  - ask for the date\n");
    expect(calls).toContain("write Daily/2026-11-22.md");
  });
});
