import { describe, expect, it } from "vitest";
import { classify } from "./errors";
import { LmError } from "./lm";

const err = (message: string, exit = 2, code = "invalid") => new LmError(code, message, exit);

describe("classify", () => {
  it("trusts the message's wording, not LM's code", () => {
    // Older LM: a title containing "stale" made this exit 6 with code "stale".
    const p = classify(err('possible_duplicate conflict: similar to demo:abc12345 "Stale cache bug". If it is…', 6, "stale"));
    expect(p).toEqual({ kind: "similar", message: expect.any(String), ref: "demo:abc12345", title: "Stale cache bug" });
  });

  it("recognises each case the editor reacts to", () => {
    expect(classify(err("stale_revision", 6)).kind).toBe("stale");
    expect(classify(err("Stale revision: domains/d/notes/x.md", 6)).kind).toBe("stale");
    expect(classify(err("Potential credential detected (API key at character 12); remove it")).kind).toBe("credential");
    expect(classify(err("Unknown tags require an approved taxonomy plan: concern/new, platform/x")))
      .toMatchObject({ kind: "unknown-tags", tags: ["concern/new", "platform/x"] });
    expect(classify(err("Note needs a summary: start the body with one or two sentences, or pass --summary")).kind).toBe("layout");
    expect(classify(err("Action items are only for plan, bug and risk notes; record lasting facts in the body instead")).kind).toBe("layout");
    // Older Living Memory wording.
    expect(classify(err("Note needs an Executive Summary: start the body…")).kind).toBe("layout");
    expect(classify(err("Action Items are only for plan, bug and risk notes; …")).kind).toBe("layout");
    expect(classify(err("ambiguous_ref: two notes")).kind).toBe("ambiguous");
    expect(classify(err("Undo conflicts with later edits", 5)).kind).toBe("undo-conflict");
    expect(classify(new Error("boom"))).toEqual({ kind: "other", message: "boom" });
    expect(classify("plain")).toEqual({ kind: "other", message: "plain" });
  });
});
