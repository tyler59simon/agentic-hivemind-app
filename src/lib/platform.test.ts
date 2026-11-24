// @vitest-environment jsdom
// macOS behavior of the webview (MACOS-1D), forced through setMacForTests. Off macOS each helper keeps the old behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyAction } from "../features/terminal/keys";
import { pasteAction } from "../features/terminal/paste";
import { quotePaths } from "../features/terminal/paths";
import { baseName, commandKey, copyLater, editableTarget, fileManager, joinPath, linkClick, parentFolder, setMacForTests } from "./platform";

const key = (k: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) =>
  ({ type: "keydown", key: "c", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...k });

afterEach(() => {
  setMacForTests(false);
  vi.unstubAllGlobals();
});

describe("paths", () => {
  it("keeps the Windows rules on Windows", () => {
    expect(parentFolder("C:\\Users\\me\\a.md")).toBe("C:\\Users\\me");
    expect(baseName("C:\\Users\\me\\Notes")).toBe("Notes");
    expect(joinPath("C:\\Notes", "a/b.md")).toBe("C:\\Notes\\a\\b.md");
    expect(joinPath("C:/Notes", "a/b.md")).toBe("C:/Notes\\a\\b.md");
  });

  it("splits macOS paths on / only", () => {
    setMacForTests(true);
    expect(parentFolder("/Users/me/a.md")).toBe("/Users/me");
    expect(parentFolder("/page.md")).toBe("/");
    expect(parentFolder("/Users/me/a\\b.md")).toBe("/Users/me");
    expect(baseName("/Users/me/a\\b.md")).toBe("a\\b.md");
    expect(joinPath("/Users/me/Notes/", "a/b.md")).toBe("/Users/me/Notes/a/b.md");
    expect(joinPath("/Users/me/odd\\", "a.md")).toBe("/Users/me/odd\\/a.md");
  });
});

describe("keys", () => {
  it("uses Cmd for commands on macOS and leaves Ctrl to the terminal", () => {
    expect(commandKey({ ctrlKey: true, metaKey: false })).toBe(true);
    setMacForTests(true);
    expect(commandKey({ ctrlKey: true, metaKey: false })).toBe(false);
    expect(commandKey({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(keyAction(key({ ctrlKey: true }), true)).toBe("pass");
    expect(keyAction(key({ key: "v", ctrlKey: true }), false)).toBe("pass");
    expect(keyAction(key({ metaKey: true }), true)).toBe("copy");
    expect(keyAction(key({ key: "v", metaKey: true }), false)).toBe("paste");
  });

  it("opens links with Ctrl+click on Windows and Cmd+click on macOS", () => {
    expect(linkClick({ ctrlKey: true, metaKey: false, button: 1 })).toBe(true);
    setMacForTests(true);
    expect(linkClick({ ctrlKey: true, metaKey: false, button: 0 })).toBe(false);
    expect(linkClick({ ctrlKey: false, metaKey: true, button: 0 })).toBe(true);
    expect(linkClick({ ctrlKey: false, metaKey: true, button: 2 })).toBe(false);
  });

  it("names Finder and knows text fields", () => {
    expect(fileManager()).toBe("Explorer");
    setMacForTests(true);
    expect(fileManager()).toBe("Finder");
    const input = document.createElement("input");
    document.body.append(input);
    expect(editableTarget(input)).toBe(true);
    expect(editableTarget(document.body)).toBe(false);
    input.remove();
  });
});

describe("terminal paste", () => {
  it("sends Ctrl+V for a Claude image paste on macOS", () => {
    expect(pasteAction(false, "claude")).toEqual({ send: "\x1bv" });
    setMacForTests(true);
    expect(pasteAction(false, "claude")).toEqual({ send: "\x16" });
  });

  it("quotes dropped paths for zsh and for fish", () => {
    expect(quotePaths(["/tmp/it's $HOME.md", "/a b"], "posix")).toBe("'/tmp/it'\\''s $HOME.md' '/a b' ");
    expect(quotePaths(["/tmp/a\\\\b's.md"], "fish")).toBe("'/tmp/a\\\\\\\\b\\'s.md' ");
  });
});

describe("copyLater", () => {
  class Item { constructor(public items: Record<string, unknown>) {} }

  it("awaits the data and writes text on Windows", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn(), writeText } });
    await copyLater("text/plain", Promise.resolve("lines"));
    expect(writeText).toHaveBeenCalledWith("lines");
  });

  it("hands the clipboard a promise on macOS", async () => {
    setMacForTests(true);
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    await copyLater("text/plain", Promise.resolve("lines"));
    const [[[item]]] = write.mock.calls as [[[Item]]];
    expect(await item.items["text/plain"]).toBe("lines");
  });

  it("reports the data's own failure first on macOS, with nothing left unhandled", async () => {
    setMacForTests(true);
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn().mockRejectedValue(new Error("denied")), writeText: vi.fn() } });
    await expect(copyLater("image/png", Promise.reject(new Error("bad svg")))).rejects.toThrow("bad svg");
    vi.stubGlobal("navigator", { clipboard: { write: vi.fn().mockRejectedValue(new Error("denied")), writeText: vi.fn() } });
    await expect(copyLater("image/png", Promise.resolve(new Blob()))).rejects.toThrow("denied");
  });
});
