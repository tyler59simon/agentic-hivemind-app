import { describe, expect, it } from "vitest";
import { pollMs, startModeOf, TRANSCRIPT_POLL_MS, viewOf } from "./view";

describe("agent tab view", () => {
  it("opens ended and failed sessions on the transcript and the others on the terminal", () => {
    expect(viewOf(undefined, { status: "ended" }, false)).toBe("transcript");
    expect(viewOf(undefined, { status: "failed" }, false)).toBe("transcript");
    expect(viewOf(undefined, { status: "running" }, true)).toBe("terminal");
    expect(viewOf(undefined, { status: "idle" }, false)).toBe("terminal");
    // Resumed: the program runs again before the stored status has caught up.
    expect(viewOf(undefined, { status: "ended" }, true)).toBe("terminal");
  });

  it("keeps the user's choice", () => {
    expect(viewOf("terminal", { status: "ended" }, false)).toBe("terminal");
    expect(viewOf("transcript", { status: "running" }, true)).toBe("transcript");
  });

  it("polls only a transcript that is shown while the session runs", () => {
    expect(pollMs("transcript", true)).toBe(TRANSCRIPT_POLL_MS);
    expect(pollMs("transcript", false)).toBe(false);
    expect(pollMs("terminal", true)).toBe(false);
  });
});

describe("startModeOf", () => {
  it("resumes an imported conversation and starts anything else idle fresh", () => {
    expect(startModeOf({ status: "idle", engineSession: "0ea3c5d4-1111-4222-8333-444455556666" })).toBe("resume");
    expect(startModeOf({ status: "idle", engineSession: null })).toBe("fresh");
    expect(startModeOf({ status: "running", engineSession: "x" })).toBeNull();
    expect(startModeOf({ status: "ended", engineSession: null })).toBeNull();
  });
});
