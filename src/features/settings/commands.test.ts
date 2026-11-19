import { describe, expect, it } from "vitest";
import { commandsFromText, withCommands } from "./commands";

describe("allowed commands", () => {
  it("reads one trimmed command per line, without blanks or repeats", () => {
    expect(commandsFromText("  npm test \r\n\ncargo test\nnpm test\n")).toEqual(["npm test", "cargo test"]);
    expect(commandsFromText("   ")).toEqual([]);
  });

  it("sets or removes one project's list and keeps the others", () => {
    const all = { pay: ["npm test"], ledger: ["cargo test"] };
    expect(withCommands(all, "pay", "npm run lint\nnpm test")).toEqual({ pay: ["npm run lint", "npm test"], ledger: ["cargo test"] });
    expect(withCommands(all, "pay", "")).toEqual({ ledger: ["cargo test"] });
    expect(withCommands(null, "new", "make")).toEqual({ new: ["make"] });
    expect(all.pay).toEqual(["npm test"]);
  });
});
