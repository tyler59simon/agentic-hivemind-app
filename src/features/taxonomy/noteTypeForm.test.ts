import { describe, expect, it } from "vitest";
import type { NoteTypeDef } from "../../lib/lm";
import { fieldsOfType, typePayload, typeProblems } from "./noteTypeForm";

const incident: NoteTypeDef = {
  name: "incident", builtin: false, status: "active", description: "Outages.", summary: "What broke.",
  sections: ["Timeline", "Impact"], actions: true, review_days: 60, concern: "concern/bug", subject: null,
};

describe("note type form", () => {
  it("checks the name only when creating", () => {
    const blank = fieldsOfType();
    expect(typeProblems({ ...blank, name: "Bad name", description: "x" }, true)).toEqual([expect.stringContaining("lowercase")]);
    expect(typeProblems({ ...blank, name: "incident", description: "" }, true)).toEqual([expect.stringContaining("Describe")]);
    expect(typeProblems({ ...fieldsOfType(incident), reviewDays: "soon" }, false)).toEqual([expect.stringContaining("whole number")]);
  });

  it("sends every field on create and only the changed ones on update", () => {
    expect(typePayload({ ...fieldsOfType(), name: "incident", description: " Outages ", sections: ["Timeline", " "], reviewDays: "" })).toEqual({
      name: "incident", description: "Outages", summary: "", sections: ["Timeline"], actions: false, review_days: null, concern: null, subject: null,
    });
    expect(typePayload(fieldsOfType(incident), incident)).toBeNull();
    expect(typePayload({ ...fieldsOfType(incident), sections: ["Impact", "Timeline"], reviewDays: "", concern: "" }, incident))
      .toEqual({ name: "incident", sections: ["Impact", "Timeline"], review_days: null, concern: null });
  });
});
