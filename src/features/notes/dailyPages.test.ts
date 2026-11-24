// NS-7A: the settings a notebook resolves to (from the sidecar and the vault's Obsidian files), and making a day's page from its
// template.
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAILY } from "./daily";
import { ensureDaily, loadNotebookInfo } from "./dailyPages";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

type Handler = (args: Record<string, unknown>) => unknown;
let rust: Record<string, Handler>;
const sent: { cmd: string; args: Record<string, unknown> }[] = [];
beforeEach(() => {
  rust = {};
  sent.length = 0;
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    sent.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
    const handler = rust[cmd];
    if (!handler) throw new Error(`no Rust command ${cmd} in this test`);
    return handler((args ?? {}) as Record<string, unknown>);
  });
});

const loaded = (text: string) => ({ text, sha256: "s", size: text.length, mtimeMs: 1, format: { encoding: "UTF-8", bom: false, eol: "lf" }, readOnly: null, binary: false });
const day = new Date(2026, 10, 22, 9, 7);

describe("a folder notebook's settings", () => {
  it("come from its sidecar, then the vault's Obsidian files, then the defaults", async () => {
    rust.notebooks_list = () => [{ id: "nb-1", title: "Work", path: "C:\\work", added: "" }];
    rust.notebook_meta_get = () => ({ version: 1, daily: { folder: "Journal" }, templates: "Tpls", inbox: "Box.md" });
    rust.obsidian_setting = ({ name }) => (name === "daily-notes.json" ? { folder: "Ignored", format: "YYYY/MM/DD", template: "Tpls/Day" } : { folder: "ObsTemplates" });
    const info = await loadNotebookInfo("nb-1");
    expect(info).toMatchObject({ title: "Work", stored: { folder: "Journal" } });
    expect(info.settings).toEqual({ folder: "Journal", format: "YYYY/MM/DD", template: "Tpls/Day", templates: "Tpls", inbox: "Box.md" });
    expect(sent.filter((s) => s.cmd === "obsidian_setting").map((s) => s.args.name).sort()).toEqual(["daily-notes.json", "templates.json"]);
  });

  it("are the defaults for a notebook with nothing, and an unreadable Obsidian file counts as none", async () => {
    rust.notebooks_list = () => [{ id: "nb-1", title: "Work", path: "C:\\work", added: "" }];
    rust.notebook_meta_get = () => ({});
    rust.obsidian_setting = () => { throw new Error(".obsidian/daily-notes.json is not valid JSON"); };
    expect((await loadNotebookInfo("nb-1")).settings).toEqual(DEFAULT_DAILY);
  });
});

describe("making a day's page", () => {
  const tree = (template: string | null) => {
    rust.notebooks_list = () => [{ id: "nb-1", title: "Work", path: "C:\\work", added: "" }];
    rust.notebook_meta_get = () => ({ daily: template ? { template } : {} });
    rust.obsidian_setting = () => null;
  };

  it("fills the template: the page's name, the day, the notebook", async () => {
    tree("Templates/Daily");
    rust.file_read = ({ path }) => { expect(path).toBe("Templates/Daily.md"); return loaded("# {{title}}\n{{date:dddd}} in {{notebook}}\n\n## Captured\n\n{{cursor}}"); };
    rust.file_create = () => ({ sha256: "s", size: 1, mtimeMs: 1 });
    const page = await ensureDaily("nb-1", day);
    expect(page).toMatchObject({ path: "Daily/2026-11-22.md", created: true, text: "# 2026-11-22\nSunday in Work\n\n## Captured\n\n", cursor: 42, missingTemplate: null });
    expect(sent.find((s) => s.cmd === "file_create")?.args).toEqual({ notebook: "nb-1", path: "Daily/2026-11-22.md", text: page.text });
  });

  it("leaves a page that exists as it is", async () => {
    tree("Templates/Daily");
    rust.file_read = () => loaded("# {{title}}");
    rust.file_create = () => { throw new Error("C:\\work\\Daily\\2026-11-22.md already exists"); };
    expect(await ensureDaily("nb-1", day)).toMatchObject({ path: "Daily/2026-11-22.md", created: false, cursor: null });
  });

  it("makes an empty page and says which template was missing when the template cannot be read", async () => {
    tree("Templates/Gone");
    rust.file_read = () => { throw new Error("Could not open: it does not exist"); };
    rust.file_create = () => ({ sha256: "s", size: 0, mtimeMs: 1 });
    expect(await ensureDaily("nb-1", day)).toMatchObject({ created: true, text: "", missingTemplate: "Templates/Gone" });
  });

  it("reads no template when the notebook has none, and passes on any other failure", async () => {
    tree(null);
    rust.file_create = () => { throw new Error("The disk is full"); };
    await expect(ensureDaily("nb-1", day)).rejects.toThrow(/disk is full/);
    expect(sent.some((s) => s.cmd === "file_read")).toBe(false);
  });
});
