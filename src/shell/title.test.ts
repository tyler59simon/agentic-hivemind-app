import { describe, expect, it } from "vitest";
import { windowTitle } from "./title";

describe("windowTitle", () => {
  it("names the most specific place first and ends with the app", () => {
    expect(windowTitle(["PayStream", "Notes", "Runbooks", "Deploy"], false)).toBe("Deploy - Runbooks - Notes - PayStream - Hivemind");
  });
  it("marks unsaved edits with a dot", () => {
    expect(windowTitle(["PayStream", "Notes", "Deploy"], true)).toBe("● Deploy - Notes - PayStream - Hivemind");
  });
  it("drops the Projects crumb, blanks and repeats", () => {
    expect(windowTitle(["Projects", "PayStream"], false)).toBe("PayStream - Hivemind");
    expect(windowTitle(["Inbox", " ", "Inbox"], false)).toBe("Inbox - Hivemind");
    expect(windowTitle([], false)).toBe("Hivemind");
  });
});
