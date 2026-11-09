import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const { gitActivity } = await import("./git");

describe("gitActivity", () => {
  it("asks Rust for a project's activity by slug only", async () => {
    invoke.mockResolvedValue([]);
    await expect(gitActivity("demo")).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("git_activity", { slug: "demo" });
  });
});
