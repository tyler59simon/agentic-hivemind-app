import { describe, expect, it } from "vitest";
import { pasteAction } from "./paste";

describe("pasteAction", () => {
  it("leaves text to xterm for every engine", () => {
    expect(pasteAction(true, "claude")).toBe("xterm");
    expect(pasteAction(true, "codex")).toBe("xterm");
  });
  it("sends each CLI's image-paste key when there is no text", () => {
    expect(pasteAction(false, "claude")).toEqual({ send: "\x1bv" });
    expect(pasteAction(false, "codex")).toEqual({ send: "\x16" });
  });
});
