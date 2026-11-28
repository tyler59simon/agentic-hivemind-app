import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { exportTheme, exportWiki, pickBrandLogo } = await import("./wiki");
const { useConnection } = await import("./connection");

describe("the theme of an exported wiki", () => {
  it("is sent only to a Living Memory that has --theme (the wiki_agent capability)", () => {
    expect(exportTheme(undefined, "emerald")).toBeNull();
    expect(exportTheme({}, "emerald")).toBeNull();
    expect(exportTheme({ wiki_agent: { version: 0 } }, "emerald")).toBeNull();
    expect(exportTheme({ wiki_agent: { version: 1 } }, "emerald")).toBe("emerald");
  });

  it("goes to Rust as null on an older install and as the theme on a newer one", async () => {
    invoke.mockResolvedValue(null);
    useConnection.setState({ capabilities: { history: 3 } });
    await exportWiki("demo", false);
    expect(invoke).toHaveBeenLastCalledWith("wiki_export", { domain: "demo", archived: false, agent: false, project: null, theme: null });
    useConnection.setState({ capabilities: { wiki_agent: { version: 1 } } });
    await exportWiki("demo", false, { agent: true, project: "core" });
    expect(invoke).toHaveBeenLastCalledWith("wiki_export", { domain: "demo", archived: false, agent: true, project: "core", theme: "purple" });
  });
});

describe("the brand logo picker", () => {
  it("asks Rust for a project's or the default brand's logo and resolves with the receipt", async () => {
    invoke.mockResolvedValue(null);
    expect(await pickBrandLogo("core", "Core")).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("brand_logo", { owner: "core", name: "Core" });
    await pickBrandLogo(null);
    expect(invoke).toHaveBeenLastCalledWith("brand_logo", { owner: null, name: null });
  });
});
