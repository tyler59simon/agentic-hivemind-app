// @vitest-environment jsdom
// macOS behavior of the webview (MACOS-1D), forced through setMacForTests.
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyAction } from "../features/terminal/keys";
import { pasteAction } from "../features/terminal/paste";
import { quotePaths } from "../features/terminal/paths";
import { baseName, commandKey, copyLater, editableTarget, fileManager, joinPath, parentFolder, setMacForTests } from "./platform";

const key = (k: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) =>
  ({ type: "keydown", key: "c", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...k });

afterEach(() => setMacForTests(false));

describe("paths", () => {
  it("splits Windows and POSIX paths", () => {
    expect(parentFolder("C:\\Users\\me\\a.md")).toBe("C:\\Users\\me");
    expect(parentFolder("/Users/me/a.md")).toBe("/Users/me");
    expect(parentFolder("a.md")).toBe("");
    expect(baseName("/Users/me/Notes")).toBe("Notes");
    expect(baseName("C:\\Users\\me\\Notes")).toBe("Notes");
  });

  it("joins a notebook path with the separator the notebook uses", () => {
    expect(joinPath("C:\\Notes", "a/b.md")).toBe("C:\\Notes\\a\\b.md");
    expect(joinPath("/Users/me/Notes/", "a/b.md")).toBe("/Users/me/Notes/a/b.md");
  });
});

describe("keys on macOS", () => {
  it("uses Cmd for commands and leaves Ctrl to the terminal", () => {
    expect(commandKey({ ctrlKey: true, metaKey: false })).toBe(true);
    setMacForTests(true);
    expect(commandKey({ ctrlKey: true, metaKey: false })).toBe(false);
    expect(commandKey({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(keyAction(key({ ctrlKey: true }), true)).toBe("pass");
    expect(keyAction(key({ key: "v", ctrlKey: true }), false)).toBe("pass");
    expect(keyAction(key({ metaKey: true }), true)).toBe("copy");
    expect(keyAction(key({ key: "v", metaKey: true }), false)).toBe("paste");
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

describe("terminal paste on macOS", () => {
  it("sends Ctrl+V for a Claude image paste", () => {
    expect(pasteAction(false, "claude")).toEqual({ send: "\x1bv" });
    setMacForTests(true);
    expect(pasteAction(false, "claude")).toEqual({ send: "\x16" });
  });

  it("quotes dropped paths for zsh", () => {
    expect(quotePaths(["/tmp/it's $HOME.md", "/a b"], "posix")).toBe("'/tmp/it'\\''s $HOME.md' '/a b' ");
  });
});

describe("copyLater", () => {
  it("hands the clipboard a promise when ClipboardItem exists", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    class Item { constructor(public items: Record<string, Promise<Blob>>) {} }
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    await copyLater(Promise.resolve("lines"));
    const [[[item]]] = write.mock.calls as [[[Item]]];
    const blob = await item.items["text/plain"];
    expect([blob.type, blob.size]).toEqual(["text/plain", "lines".length]);
    vi.unstubAllGlobals();
  });
});
