import { describe, expect, it } from "vitest";
import { APPROVALS, CLAUDE_MODES, SANDBOXES, accessLabel, asksNobody, type Access } from "./agent";

describe("asksNobody", () => {
  it("is true only for the Claude modes that never ask", () => {
    const risky = CLAUDE_MODES.filter((mode) => asksNobody({ engine: "claude", mode }));
    expect(risky).toEqual(["dontAsk", "bypassPermissions"]);
  });

  it("is true for Codex when the sandbox is wide open or nobody is asked", () => {
    for (const sandbox of SANDBOXES) {
      for (const approval of APPROVALS) {
        const expected = sandbox === "danger-full-access" || approval !== "on-request";
        expect(asksNobody({ engine: "codex", sandbox, approval })).toBe(expected);
      }
    }
    expect(asksNobody({ engine: "codex", sandbox: "workspace-write", approval: "on-request" })).toBe(false);
  });
});

describe("accessLabel", () => {
  it("uses the CLI's own names", () => {
    const labels: [Access, string][] = [
      [{ engine: "claude", mode: "bypassPermissions" }, "bypassPermissions"],
      [{ engine: "claude", mode: "acceptEdits" }, "acceptEdits"],
      [{ engine: "codex", sandbox: "workspace-write", approval: "on-request" }, "workspace-write · on-request"],
      [{ engine: "codex", sandbox: "workspace-write", approval: "approve-for-me" }, "workspace-write · approve-for-me"],
    ];
    for (const [access, label] of labels) expect(accessLabel(access)).toBe(label);
  });
});
